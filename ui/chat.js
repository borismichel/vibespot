/**
 * Chat UI — WebSocket client, message rendering, streaming display.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let isStreaming = false;
let streamingMsgEl = null;
let streamBuffer = "";
let streamStartTime = 0;
let streamTimerInterval = null;
let lastStreamStatus = "";
let currentSessionId = "";
let currentTemplateId = "";
let renderScheduled = false;
let scrollScheduled = false;

const messagesEl = document.getElementById("chat-messages");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("chat-send");
const statusText = document.getElementById("status-text");
const statusEngine = document.getElementById("status-engine");

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connectWebSocket() {
  // Close any existing connection to prevent duplicates and stale state
  if (ws) {
    ws.onclose = null; // prevent auto-reconnect from old socket
    ws.close();
    ws = null;
  }
  brandExtractionPromptShown = false;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus("Connected");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleWsMessage(msg);
  };

  ws.onclose = () => {
    stopStreamTimer();
    if (isStreaming) finishStreaming();
    setStatus("Disconnected — reconnecting...");
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    stopStreamTimer();
    if (isStreaming) finishStreaming();
    setStatus("Connection error");
  };
}

function handleWsMessage(msg) {
  // Route upload messages to upload-panel.js
  if (msg.type && msg.type.startsWith("upload_")) {
    if (typeof handleUploadWsMessage === "function") {
      handleUploadWsMessage(msg);
    }
    return;
  }

  switch (msg.type) {
    case "init":
      currentSessionId = msg.sessionId || "";
      currentTemplateId = msg.templateId || "";
      document.getElementById("theme-name").textContent = msg.themeName || "—";

      // Clear previous project's chat and module list
      messagesEl.innerHTML = "";
      document.getElementById("module-items").innerHTML = "";
      document.getElementById("module-count").textContent = "0";

      if (msg.modules && msg.modules.length > 0) {
        updateModuleList(msg.modules);
        refreshPreview();
      }
      statusEngine.textContent = msg.engine || "";
      fetchHsAccountStatus();

      // Populate chat header
      const chatHeaderTitle = document.getElementById("chat-header-title");
      const chatHeaderContext = document.getElementById("chat-header-context");
      if (chatHeaderTitle) chatHeaderTitle.textContent = msg.themeName || "Chat";
      if (chatHeaderContext) chatHeaderContext.textContent = msg.engine || "";

      // Restore chat history from server
      if (msg.messages && msg.messages.length > 0) {
        for (const m of msg.messages) {
          if (m.role === "user") {
            appendUserMessage(m.content, m.timestamp);
          } else if (m.role === "assistant") {
            appendRestoredAssistantMessage(m.content, m.timestamp, m.pipeline);
          }
        }
        scrollToBottom();
      }

      // Show/hide version history button
      const historyBtn = document.getElementById("btn-history");
      if (historyBtn) {
        historyBtn.style.display = msg.gitAvailable ? "" : "none";
      }

      // Hydrate plan-mode state (toggle + Plan pane content)
      if (window.planController) {
        window.planController.setInitialState(msg);
      }
      break;

    case "stream":
      handleStreamChunk(msg.content);
      break;

    case "stream_status":
      handleStreamStatus(msg.content);
      break;

    case "generation_complete":
      clearStreamStatus();
      finishStreaming();
      break;

    case "modules_updated":
      if (msg.modules) {
        updateModuleList(msg.modules);
      }
      refreshPreview();
      break;

    case "version_created":
      if (historyPanelOpen) refreshHistoryPanel();
      break;

    case "parse_warning":
      appendSystemMessage(msg.message || "Module changes could not be applied.");
      break;

    case "error":
      stopPipelineTimer();
      if (typeof clearAllModulesWorking === "function") clearAllModulesWorking();
      finishStreaming();
      pipelineBubbleEl = null;
      pipelineStepsEl = null;
      pipelineModulesEl = null;
      appendAssistantError(msg.message);
      setStatus("Error");
      break;

    case "pong":
      break;

    // --- Agentic pipeline events ---
    case "agent_step":
      handleAgentStep(msg);
      break;
    case "agent_decision":
      handleAgentDecision(msg);
      break;
    case "module_progress":
      handleModuleProgress(msg);
      break;
    case "pipeline_complete":
      handlePipelineComplete(msg);
      break;
    case "pipeline_partial":
      handlePipelinePartial(msg);
      break;
    case "agentic_prompt":
      handleAgenticPrompt();
      break;
    case "suggest_brand_extraction":
      handleSuggestBrandExtraction();
      break;
    case "brand_asset_extracted":
      handleBrandAssetExtracted(msg.assetType);
      break;
    case "brand_extraction_complete":
      handleBrandExtractionComplete();
      break;
    case "brand_extraction_error":
      appendSystemMessage("Brand extraction failed: " + (msg.message || "Unknown error"));
      break;

    case "figma_import_started":
      startStreaming();
      appendSystemMessage("Importing from Figma: " + (msg.fileName || "design") + "...");
      break;

    case "needs_setup":
      // Clear stale UI if shown
      messagesEl.innerHTML = "";
      document.getElementById("module-items").innerHTML = "";
      document.getElementById("module-count").textContent = "0";
      break;

    case "plan_updated":
      if (window.planController) window.planController.onPlanUpdated(msg.plan || "");
      break;

    case "plan_choices":
      if (window.planController) window.planController.renderChoices(msg.question, msg.options);
      break;

    case "plan_complete":
      // Replace the streaming bubble's content with the cleaned message
      // (vibespot-plan + vibespot-choices fenced blocks stripped). We
      // also overwrite streamBuffer so finishStreaming's final render
      // doesn't re-introduce trailing <br> tags from the stripped block.
      if (typeof msg.cleanedContent === "string") {
        streamBuffer = msg.cleanedContent.trim();
      }
      if (streamingMsgEl) {
        if (streamBuffer) {
          streamingMsgEl.innerHTML = renderMarkdown(streamBuffer);
        } else {
          streamingMsgEl.innerHTML = '<em class="message__placeholder">Updated the plan in the Plan pane.</em>';
        }
      }
      finishStreaming();
      clearStreamStatus();
      break;

    case "plan_discarded":
      if (window.planController) window.planController.onPlanDiscarded();
      break;
  }
}

// ---------------------------------------------------------------------------
// Agentic pipeline UI
// ---------------------------------------------------------------------------

const STEP_LABELS = {
  analyzing: "Analyzing",
  designing: "Designing",
  developing: "Developing",
  quality_check: "Quality Check",
};
const STEP_ORDER = ["analyzing", "designing", "developing", "quality_check"];

let pipelineBubbleEl = null;
let pipelineStepsEl = null;
let pipelineModulesEl = null;

function ensurePipelineBubble() {
  if (pipelineBubbleEl) return;

  if (!isStreaming) {
    isStreaming = true;
    sendBtn.disabled = true;
    streamStartTime = Date.now();
    // Don't replace the preview with a spinner — agentic mode uses
    // incremental placeholders and keeps the existing page visible.
  }

  // If startStreaming() already created an empty bubble, repurpose it
  if (streamingMsgEl) {
    const existingDiv = streamingMsgEl.closest(".chat-msg");
    if (existingDiv) {
      streamingMsgEl.innerHTML = `
        <div class="pipeline-steps"></div>
        <div class="pipeline-modules"></div>
        <div class="pipeline-timer"></div>`;
      pipelineBubbleEl = existingDiv;
      pipelineStepsEl = streamingMsgEl.querySelector(".pipeline-steps");
      pipelineModulesEl = streamingMsgEl.querySelector(".pipeline-modules");
      startPipelineTimer(streamingMsgEl.querySelector(".pipeline-timer"));
      scrollToBottom();
      return;
    }
  }

  const time = formatMessageTime(Date.now());
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant chat-msg--streaming";
  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      <div class="chat-msg__header">
        <span class="chat-msg__sender">vibeSpot AI</span>
        <span class="chat-msg__time">${time}</span>
      </div>
      <div class="chat-msg__bubble">
        <div class="pipeline-steps"></div>
        <div class="pipeline-modules"></div>
        <div class="pipeline-timer"></div>
      </div>
    </div>`;
  messagesEl.appendChild(div);

  pipelineBubbleEl = div;
  pipelineStepsEl = div.querySelector(".pipeline-steps");
  pipelineModulesEl = div.querySelector(".pipeline-modules");
  streamingMsgEl = div.querySelector(".chat-msg__bubble");
  startPipelineTimer(div.querySelector(".pipeline-timer"));
  scrollToBottom();
}

function markStepDone(el) {
  el.classList.add("pipeline-step--done");
  el.classList.remove("pipeline-step--active");
  const icon = el.querySelector(".pipeline-step__icon");
  if (icon) icon.textContent = "✓";
}

function handleAgentStep(msg) {
  ensurePipelineBubble();

  // If the same step fires again (e.g., "designing" fires twice for design system + module planner),
  // update the existing step's label instead of creating a duplicate
  const existingStep = pipelineStepsEl.querySelector(`[data-step="${CSS.escape(msg.step)}"]:not(.pipeline-step--done)`);
  if (existingStep) {
    // Mark the current one as done and create a fresh one below
    markStepDone(existingStep);
  } else {
    // Mark all other active steps as done
    const existing = pipelineStepsEl.querySelectorAll(".pipeline-step");
    existing.forEach((el) => {
      if (!el.classList.contains("pipeline-step--done")) {
        markStepDone(el);
      }
    });
  }

  // Add new step
  const step = document.createElement("div");
  step.className = "pipeline-step pipeline-step--active";
  step.dataset.step = msg.step;
  step.innerHTML = `<span class="pipeline-step__icon">⟳</span> <span class="pipeline-step__label">${msg.label || STEP_LABELS[msg.step] || msg.step}</span>`;

  // Insert quality_check AFTER module cards so the visual order is:
  // developing → module cards → quality check
  if (msg.step === "quality_check" && pipelineModulesEl) {
    pipelineModulesEl.after(step);
  } else {
    pipelineStepsEl.appendChild(step);
  }

  // Clear module cards when entering developing
  if (msg.step === "developing") {
    pipelineModulesEl.innerHTML = "";
  }

  scrollToBottom();
}

function handleAgentDecision(msg) {
  if (!pipelineBubbleEl) return;

  // Find the step element — may be inside pipelineStepsEl or after pipelineModulesEl
  const bubble = streamingMsgEl || pipelineBubbleEl;
  const steps = bubble.querySelectorAll(".pipeline-step");
  const lastStep = steps[steps.length - 1];
  if (lastStep) {
    const detail = document.createElement("div");
    detail.className = "pipeline-step__decision";
    detail.textContent = msg.decision;
    lastStep.appendChild(detail);
  }
  scrollToBottom();
}

function handleModuleProgress(msg) {
  ensurePipelineBubble();

  let card = pipelineModulesEl.querySelector(`[data-module="${CSS.escape(msg.module)}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "pipeline-module-card";
    card.dataset.module = msg.module;
    card.innerHTML = `<span class="pipeline-module-card__name">${escapeHtml(msg.module)}</span> <span class="pipeline-module-card__status"></span>`;
    pipelineModulesEl.appendChild(card);
  }

  const statusEl = card.querySelector(".pipeline-module-card__status");
  card.className = "pipeline-module-card pipeline-module-card--" + msg.status;

  const statusLabels = {
    queued: "queued",
    generating: "generating...",
    validating: "validating...",
    retrying: "retrying...",
    complete: "✓",
    failed: "✗",
  };
  statusEl.textContent = statusLabels[msg.status] || msg.status;

  // Mark/clear working overlay in the preview
  if (msg.status === "generating" && typeof markModulesWorking === "function") {
    markModulesWorking([msg.module]);
  } else if ((msg.status === "complete" || msg.status === "failed") && typeof clearModuleWorking === "function") {
    clearModuleWorking(msg.module);
  }

  scrollToBottom();
}

function handlePipelineComplete(msg) {
  if (!pipelineBubbleEl) return;

  stopPipelineTimer();
  if (typeof clearAllModulesWorking === "function") clearAllModulesWorking();

  // Remove the live timer element
  const timerEl = pipelineBubbleEl.querySelector(".pipeline-timer");
  if (timerEl) timerEl.remove();

  // Mark all steps as done (search whole bubble since quality_check is outside pipelineStepsEl)
  const bubble = streamingMsgEl || pipelineBubbleEl;
  bubble.querySelectorAll(".pipeline-step").forEach((el) => markStepDone(el));

  // Show answer text for question intents
  if (msg.answer) {
    const answerEl = document.createElement("div");
    answerEl.className = "pipeline-answer";
    answerEl.textContent = msg.answer;
    bubble.appendChild(answerEl);
  }

  // Add completion stats after the last element in the bubble
  const stats = document.createElement("div");
  stats.className = "pipeline-stats";
  const duration = formatDuration(msg.durationMs);
  if (msg.answer) {
    // For questions, just show duration
    stats.textContent = `Answered in ${duration}`;
  } else {
    stats.textContent = `Generated ${msg.modulesGenerated} module${msg.modulesGenerated === 1 ? "" : "s"} in ${duration}`;
    if (msg.modulesUnchanged > 0) {
      stats.textContent += ` (${msg.modulesUnchanged} unchanged)`;
    }
  }
  // Place stats after quality_check step (or after modules if no quality step)
  const qualityStep = bubble.querySelector('[data-step="quality_check"]');
  if (qualityStep) {
    qualityStep.after(stats);
  } else if (pipelineModulesEl) {
    pipelineModulesEl.after(stats);
  } else {
    bubble.appendChild(stats);
  }

  clearStreamStatus();
  finishStreaming();

  // Reset pipeline state
  pipelineBubbleEl = null;
  pipelineStepsEl = null;
  pipelineModulesEl = null;
}

function handlePipelinePartial(msg) {
  if (!pipelineBubbleEl) return;

  stopPipelineTimer();
  if (typeof clearAllModulesWorking === "function") clearAllModulesWorking();

  const timerEl = pipelineBubbleEl.querySelector(".pipeline-timer");
  if (timerEl) timerEl.remove();

  const bubble = streamingMsgEl || pipelineBubbleEl;
  bubble.querySelectorAll(".pipeline-step").forEach((el) => markStepDone(el));

  const stats = document.createElement("div");
  stats.className = "pipeline-stats pipeline-stats--partial";
  const duration = formatDuration(msg.durationMs);
  stats.textContent = `${msg.succeeded.length} modules succeeded, ${msg.failed.length} failed in ${duration}`;
  const qualityStep = bubble.querySelector('[data-step="quality_check"]');
  if (qualityStep) {
    qualityStep.after(stats);
  } else if (pipelineModulesEl) {
    pipelineModulesEl.after(stats);
  } else {
    pipelineStepsEl.appendChild(stats);
  }

  clearStreamStatus();
  finishStreaming();

  pipelineBubbleEl = null;
  pipelineStepsEl = null;
  pipelineModulesEl = null;
}

async function handleAgenticPrompt() {
  // First-run onboarding: show dialog explaining agentic mode
  if (typeof vibeConfirm !== "function") return;

  const agreed = await vibeConfirm(
    "Agentic Pipeline Available",
    "vibeSpot can decompose AI generation into specialized agents:\n\n" +
    "• Intent Analyzer — classifies your request\n" +
    "• Page Architect — designs the page structure\n" +
    "• Module Developer — generates each module in parallel\n" +
    "• Validator — checks and auto-fixes errors\n\n" +
    "Tradeoffs:\n" +
    "✓ Better quality — each agent is focused on one task\n" +
    "✓ Structured output — eliminates JSON parsing failures\n" +
    "✓ Only changed modules regenerated on edits\n" +
    "✗ Uses more calls per request (API calls or CLI subprocess calls)\n\n" +
    "You can change this anytime in Settings.",
    "Use Agentic Pipeline",
    "Keep Single-Call",
  );

  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agenticMode: agreed }),
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Brand asset extraction prompt
// ---------------------------------------------------------------------------

let brandExtractionPromptShown = false;

function handleSuggestBrandExtraction() {
  if (brandExtractionPromptShown) return;
  brandExtractionPromptShown = true;

  const el = document.createElement("div");
  el.className = "chat-msg chat-msg--system brand-extraction-prompt";
  el.innerHTML = `
    <div class="chat-msg__system" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span>Extract product context &amp; styleguide from your page? Helps keep future templates consistent.</span>
      <button class="btn btn--sm btn--primary" id="btn-accept-extraction">Extract</button>
      <button class="btn btn--sm btn--outline" id="btn-dismiss-extraction">Dismiss</button>
    </div>
  `;

  messagesEl.appendChild(el);
  scrollToBottom();

  el.querySelector("#btn-accept-extraction").addEventListener("click", () => {
    el.querySelector(".brand-extraction-prompt__actions").innerHTML =
      '<span class="brand-extraction-prompt__status">Extracting...</span>';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "extract_brand_assets" }));
    }
  });

  el.querySelector("#btn-dismiss-extraction").addEventListener("click", () => {
    el.remove();
  });
}

function handleBrandAssetExtracted(assetType) {
  const labelMap = { themeContext: "Product context", styleguide: "Styleguide", brandvoice: "Brand voice" };
  const label = labelMap[assetType] || assetType;
  appendSystemMessage(`${label} extracted and saved.`);
}

function handleBrandExtractionComplete() {
  const prompt = document.querySelector(".brand-extraction-prompt");
  if (prompt) prompt.remove();
}

// ---------------------------------------------------------------------------
// File attachments
// ---------------------------------------------------------------------------

const pendingFiles = [];
const fileChipsEl = document.getElementById("file-chips");
const fileInputEl = document.getElementById("file-input");
const attachBtn = document.getElementById("btn-attach-file");
const dropOverlay = document.getElementById("drop-overlay");
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/gif"]);
const DOC_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown", "text/plain",
]);
const SUPPORTED_TYPES = new Set([...IMAGE_TYPES, ...DOC_TYPES]);
// Browsers often report .md files as application/octet-stream or empty string
const EXT_MIME_MAP = { ".md": "text/markdown", ".txt": "text/plain", ".markdown": "text/markdown" };

function addPendingFile(file) {
  let f = file;
  if (!SUPPORTED_TYPES.has(f.type)) {
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    const mapped = EXT_MIME_MAP[ext];
    if (mapped) {
      f = new File([f], f.name, { type: mapped });
    } else {
      showToast(`Unsupported file type: ${f.name}`);
      return;
    }
  }
  if (f.size > MAX_FILE_SIZE) {
    showToast(`File too large (>10MB): ${f.name}`);
    return;
  }
  pendingFiles.push(f);
  renderFileChips();
}

function removePendingFile(index) {
  pendingFiles.splice(index, 1);
  renderFileChips();
}

function renderFileChips() {
  fileChipsEl.innerHTML = "";
  if (pendingFiles.length === 0) {
    fileChipsEl.classList.remove("visible");
    return;
  }
  fileChipsEl.classList.add("visible");
  pendingFiles.forEach((file, i) => {
    const isImage = IMAGE_TYPES.has(file.type);
    const chip = document.createElement("div");
    chip.className = `file-chip file-chip--${isImage ? "image" : "doc"}`;
    const sizeKB = Math.round(file.size / 1024);
    const sizeStr = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
    chip.innerHTML = `
      <span class="file-chip__icon">${isImage ? "\u{1F5BC}" : "\u{1F4C4}"}</span>
      <span class="file-chip__name">${escapeHtml(file.name)}</span>
      <span class="file-chip__size">${sizeStr}</span>
      <button class="file-chip__remove" title="Remove">&times;</button>
    `;
    chip.querySelector(".file-chip__remove").addEventListener("click", () => removePendingFile(i));
    fileChipsEl.appendChild(chip);
  });
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("visible"), 10);
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function uploadFiles(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  const resp = await fetch("/api/upload-files", { method: "POST", body: formData });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(err.error || "Upload failed");
  }
  return resp.json();
}

function renderFileChipsInMessage(files) {
  if (!files || files.length === 0) return "";
  return `<div class="chat-msg__files">${files
    .map((f) => {
      const isImage = f.type === "image";
      return `<span class="file-chip file-chip--${isImage ? "image" : "doc"} file-chip--sent">
        <span class="file-chip__icon">${isImage ? "\u{1F5BC}" : "\u{1F4C4}"}</span>
        <span class="file-chip__name">${escapeHtml(f.originalName || f.name)}</span>
      </span>`;
    })
    .join("")}</div>`;
}

// Drag-and-drop
let dragCounter = 0;

inputEl.closest(".chat__input-area").addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.remove("hidden");
});

inputEl.closest(".chat__input-area").addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.add("hidden");
  }
});

inputEl.closest(".chat__input-area").addEventListener("dragover", (e) => {
  e.preventDefault();
});

inputEl.closest(".chat__input-area").addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add("hidden");
  if (e.dataTransfer?.files) {
    for (const file of e.dataTransfer.files) {
      addPendingFile(file);
    }
  }
});

// Paperclip button
attachBtn.addEventListener("click", () => fileInputEl.click());
fileInputEl.addEventListener("change", () => {
  for (const file of fileInputEl.files) {
    addPendingFile(file);
  }
  fileInputEl.value = "";
});

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

async function sendMessage(text) {
  const hasFiles = pendingFiles.length > 0;
  if ((!text.trim() && !hasFiles) || isStreaming || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Remove welcome screen
  const welcome = messagesEl.querySelector(".chat__welcome");
  if (welcome) welcome.remove();

  // Upload files first if any
  let uploadedFiles = [];
  const filesToUpload = [...pendingFiles];
  if (hasFiles) {
    pendingFiles.length = 0;
    renderFileChips();
    setStatus("Uploading files...");
    try {
      const result = await uploadFiles(filesToUpload);
      uploadedFiles = result.files || [];
      if (result.errors?.length) {
        result.errors.forEach((e) => showToast(e));
      }
    } catch (err) {
      showToast(err.message);
      setStatus("Upload failed");
      return;
    }
  }

  // Show user message with file chips
  appendUserMessage(text, null, uploadedFiles);

  // Start streaming indicator
  startStreaming();

  // Send via WebSocket with file IDs
  const payload = { type: "chat", message: text || "(files attached)" };
  if (uploadedFiles.length > 0) {
    payload.fileIds = uploadedFiles.map((f) => f.id);
  }
  ws.send(JSON.stringify(payload));

  // Clear input
  inputEl.value = "";
  inputEl.style.height = "auto";
  setStatus("Generating...");
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function formatMessageTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function appendUserMessage(text, timestamp, files) {
  const time = formatMessageTime(timestamp || Date.now());
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--user";
  const fileChipsHtml = renderFileChipsInMessage(files);
  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--user">Y</div>
    <div class="chat-msg__content">
      <div class="chat-msg__header">
        <span class="chat-msg__sender">You</span>
        <span class="chat-msg__time">${time}</span>
      </div>
      ${fileChipsHtml}
      <div class="chat-msg__bubble">${escapeHtml(text)}</div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function startStreaming() {
  isStreaming = true;
  streamBuffer = "";
  lastStreamStatus = "";
  sendBtn.disabled = true;
  streamStartTime = Date.now();
  if (typeof window.setSelectModeDisabled === "function") {
    window.setSelectModeDisabled(true);
  }

  // Don't show generating preview here — agentic mode keeps the page visible.
  // For single-call mode, showGeneratingPreview() is called on first "stream" event.

  const time = formatMessageTime(streamStartTime);
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant chat-msg--streaming";
  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      <div class="chat-msg__header">
        <span class="chat-msg__sender">vibeSpot AI</span>
        <span class="chat-msg__time">${time}</span>
      </div>
      <div class="chat-msg__bubble"></div>
    </div>`;
  messagesEl.appendChild(div);
  streamingMsgEl = div.querySelector(".chat-msg__bubble");
  scrollToBottom();

  // Start the running clock
  startStreamTimer();
}

function handleStreamChunk(text) {
  if (!streamingMsgEl) return;
  streamBuffer += text;

  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(flushStreamRender);
  }
}

function flushStreamRender() {
  renderScheduled = false;
  if (!streamingMsgEl) return;

  // Hide incomplete code fences (AI is writing module code)
  let display = streamBuffer;
  const fenceCount = (display.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    const lastFence = display.lastIndexOf("```");
    display = display.substring(0, lastFence);
  }

  const rendered = renderMarkdown(display);
  const visibleText = rendered.replace(/<[^>]*>/g, "").trim();

  if (visibleText) {
    // Preserve the stream-status spinner while updating text
    const statusEl = streamingMsgEl.querySelector(".stream-status");
    streamingMsgEl.innerHTML = rendered;
    if (statusEl) streamingMsgEl.appendChild(statusEl);
  }
  // No visible text — leave the spinner (.stream-status) untouched in the DOM
  scrollToBottom();
}

function handleStreamStatus(status) {
  if (!streamingMsgEl) {
    startStreaming();
    // Single-call mode — show generating preview (agentic mode never sends stream_status)
    if (typeof showGeneratingPreview === "function" && !pipelineBubbleEl) {
      showGeneratingPreview();
    }
  }

  lastStreamStatus = status;

  // Find or create the status element inside the streaming bubble
  let statusEl = streamingMsgEl.querySelector(".stream-status");
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "stream-status";
    statusEl.innerHTML = '<span class="stream-status__text"></span><span class="stream-status__timer"></span>';
    streamingMsgEl.appendChild(statusEl);
  }
  const textEl = statusEl.querySelector(".stream-status__text");
  if (textEl) textEl.textContent = status;
  scrollToBottom();
}

function startStreamTimer() {
  stopStreamTimer();
  streamTimerInterval = setInterval(() => {
    // Update the timer in the stream status element
    const timerEl = streamingMsgEl && streamingMsgEl.querySelector(".stream-status__timer");
    if (timerEl) {
      timerEl.textContent = formatDuration(Date.now() - streamStartTime);
    }
  }, 1000);
}

function stopStreamTimer() {
  if (streamTimerInterval) {
    clearInterval(streamTimerInterval);
    streamTimerInterval = null;
  }
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return totalSec + "s";
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) {
    return hours + "h " + (min < 10 ? "0" : "") + min + "m " + (sec < 10 ? "0" : "") + sec + "s";
  }
  return min + "m " + (sec < 10 ? "0" : "") + sec + "s";
}

let pipelineTimerInterval = null;

function startPipelineTimer(timerEl) {
  stopPipelineTimer();
  if (!timerEl) return;
  const update = () => {
    timerEl.textContent = formatDuration(Date.now() - streamStartTime);
  };
  update();
  pipelineTimerInterval = setInterval(update, 1000);
}

function stopPipelineTimer() {
  if (pipelineTimerInterval) {
    clearInterval(pipelineTimerInterval);
    pipelineTimerInterval = null;
  }
}

function clearStreamStatus() {
  if (!streamingMsgEl) return;
  const statusEl = streamingMsgEl.querySelector(".stream-status");
  if (statusEl) statusEl.remove();
}

function finishStreaming() {
  if (!isStreaming) return;
  isStreaming = false;
  sendBtn.disabled = false;
  if (typeof window.setSelectModeDisabled === "function") {
    window.setSelectModeDisabled(false);
  }

  // Stop the timer and capture duration
  stopStreamTimer();
  const durationMs = Date.now() - streamStartTime;
  const durationStr = formatDuration(durationMs);

  clearStreamStatus();

  // Remove streaming cursor
  const streamingEl = messagesEl.querySelector(".chat-msg--streaming");
  if (streamingEl) {
    streamingEl.classList.remove("chat-msg--streaming");

    // Add duration metadata beneath the bubble (inside .chat-msg__content)
    const meta = document.createElement("div");
    meta.className = "chat-msg__meta";
    meta.textContent = durationStr;
    const contentEl = streamingEl.querySelector(".chat-msg__content") || streamingEl;
    contentEl.appendChild(meta);
  }

  // Final render of the full response
  if (streamingMsgEl && streamBuffer) {
    const rendered = renderMarkdown(streamBuffer);
    const visibleText = rendered.replace(/<[^>]*>/g, "").trim();
    streamingMsgEl.innerHTML = visibleText ? rendered : "<em>Modules applied.</em>";
  }

  streamingMsgEl = null;
  streamBuffer = "";
  setStatus("Ready");
  scrollToBottom();
}

function appendAssistantError(message) {
  const time = formatMessageTime(Date.now());
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";
  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      <div class="chat-msg__header">
        <span class="chat-msg__sender">vibeSpot AI</span>
        <span class="chat-msg__time">${time}</span>
      </div>
      <div class="chat-msg__bubble" style="border-left: 3px solid var(--error);">
        <strong>Error:</strong> ${escapeHtml(message)}
      </div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Markdown-lite renderer (code blocks, inline code, bold, links)
// ---------------------------------------------------------------------------

function renderMarkdown(text) {
  // Strip all code blocks — module code is applied via JSON, not displayed in chat
  text = text.replace(/```[\s\S]*?```/g, "");
  // Also strip unclosed code fences (truncated responses)
  text = text.replace(/```[\s\S]*$/g, "");
  // Collapse runs of blank lines left behind by stripped fences (otherwise
  // they become trailing <br> tags and produce visible empty space).
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // Escape HTML to prevent XSS from AI/user content
  text = escapeHtml(text);

  // Inline code: `...`
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **...**
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *...*
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

  // Line breaks → paragraphs
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  if (paragraphs.length > 1) {
    text = paragraphs.map((p) => {
      if (p.startsWith("<pre>")) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    }).join("");
  } else {
    text = text.replace(/\n/g, "<br>");
  }

  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scrollToBottom() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    // Only auto-scroll if user is near the bottom (within 150px)
    const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    if (gap < 150) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
}

function setStatus(text) {
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Restored / system messages
// ---------------------------------------------------------------------------

function appendRestoredAssistantMessage(text, timestamp, pipeline) {
  const time = formatMessageTime(timestamp);
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";

  if (pipeline && pipeline.steps && pipeline.steps.length > 0) {
    // Render detailed pipeline structure
    const stepsHtml = pipeline.steps.map((s) => {
      const icon = "&#x2714;";
      const decisionsHtml = (s.decisions || [])
        .map((d) => `<div class="pipeline-step__decision">${escapeHtml(d)}</div>`)
        .join("");
      return `<div class="pipeline-step pipeline-step--done"><span class="pipeline-step__icon">${icon}</span> <span class="pipeline-step__label">${escapeHtml(s.label)}</span>${decisionsHtml}</div>`;
    }).join("");

    const modulesHtml = pipeline.modules && pipeline.modules.length > 0
      ? pipeline.modules.map((m) => {
          const statusClass = m.status === "failed" ? "pipeline-module-card--failed" : "pipeline-module-card--done";
          const statusIcon = m.status === "failed" ? "&#x2718;" : "&#x2714;";
          return `<div class="pipeline-module-card ${statusClass}">${statusIcon} ${escapeHtml(m.name)}</div>`;
        }).join("")
      : "";

    const duration = formatDuration(pipeline.stats.durationMs);
    let statsText = `Generated ${pipeline.stats.modulesGenerated} module${pipeline.stats.modulesGenerated === 1 ? "" : "s"} in ${duration}`;
    if (pipeline.stats.modulesUnchanged > 0) {
      statsText += ` (${pipeline.stats.modulesUnchanged} unchanged)`;
    }
    const statsClass = pipeline.stats.modulesFailed > 0 ? "pipeline-stats pipeline-stats--partial" : "pipeline-stats";

    div.innerHTML = `
      <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
      <div class="chat-msg__content">
        ${time ? `<div class="chat-msg__header"><span class="chat-msg__sender">vibeSpot AI</span><span class="chat-msg__time">${time}</span></div>` : ""}
        <div class="chat-msg__bubble">
          <div class="pipeline-steps">${stepsHtml}${modulesHtml ? `<div class="pipeline-modules-restored">${modulesHtml}</div>` : ""}<div class="${statsClass}">${statsText}</div></div>
        </div>
      </div>`;
  } else {
    div.innerHTML = `
      <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
      <div class="chat-msg__content">
        ${time ? `<div class="chat-msg__header"><span class="chat-msg__sender">vibeSpot AI</span><span class="chat-msg__time">${time}</span></div>` : ""}
        <div class="chat-msg__bubble">${renderMarkdown(text)}</div>
      </div>`;
  }
  messagesEl.appendChild(div);
}

function appendSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--system";
  div.innerHTML = `<div class="chat-msg__system">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Version history panel
// ---------------------------------------------------------------------------

let historyPanelOpen = false;

function toggleHistoryPanel() {
  const panel = document.getElementById("history-panel");
  if (!panel) return;
  historyPanelOpen = !historyPanelOpen;
  panel.classList.toggle("hidden", !historyPanelOpen);
  if (historyPanelOpen) refreshHistoryPanel();
}

let historyShowAll = false;

async function refreshHistoryPanel() {
  const list = document.getElementById("history-list");
  if (!list) return;
  list.innerHTML = '<div class="history__loading">Loading...</div>';

  try {
    const useFilter = currentTemplateId && !historyShowAll;
    const url = useFilter
      ? `/api/history?templateId=${encodeURIComponent(currentTemplateId)}`
      : "/api/history";
    const res = await fetch(url);
    const data = await res.json();

    if (!data.available) {
      list.innerHTML = '<div class="history__empty">Git not available</div>';
      return;
    }

    // Show all / filter toggle
    const toggleHtml = currentTemplateId
      ? `<div class="history__toggle"><button class="history__toggle-btn" id="history-toggle-filter">${historyShowAll ? "This template" : "Show all"}</button></div>`
      : "";

    if (data.commits.length === 0) {
      list.innerHTML = toggleHtml + '<div class="history__empty">No versions yet</div>';
      attachHistoryToggle();
      return;
    }

    list.innerHTML = toggleHtml;
    const HISTORY_LIMIT = 50;
    const commits = data.commits.slice(0, HISTORY_LIMIT);
    const frag = document.createDocumentFragment();

    for (const commit of commits) {
      const isInitial = commit.message.startsWith("Initial ");
      const isRollback = commit.message.includes("Rollback to:");

      // Strip [templateId] prefix from display
      let displayMsg = commit.message;
      const prefixMatch = displayMsg.match(/^\[[^\]]+\]\s*/);
      if (prefixMatch) displayMsg = displayMsg.slice(prefixMatch[0].length);

      const item = document.createElement("div");
      item.className = "history-item" + (isRollback ? " history-item--rollback" : "");
      item.innerHTML = `
        <div class="history-item__header">
          <span class="history-item__hash">${escapeHtml(commit.hash)}</span>
          <span class="history-item__date">${timeAgoShort(commit.timestamp)}</span>
        </div>
        <div class="history-item__msg">${escapeHtml(displayMsg)}</div>
        ${!isInitial ? `<button class="history-item__rollback" data-hash="${escapeHtml(commit.fullHash)}">Restore</button>` : ""}
      `;
      frag.appendChild(item);
    }
    list.appendChild(frag);

    if (data.commits.length > HISTORY_LIMIT) {
      const more = document.createElement("div");
      more.className = "history__show-more";
      more.textContent = `Showing ${HISTORY_LIMIT} of ${data.commits.length} versions`;
      list.appendChild(more);
    }

    list.querySelectorAll(".history-item__rollback").forEach((btn) => {
      btn.addEventListener("click", () => doRollback(btn.dataset.hash));
    });
    attachHistoryToggle();
  } catch {
    list.innerHTML = '<div class="history__empty">Error loading history</div>';
  }
}

function attachHistoryToggle() {
  const btn = document.getElementById("history-toggle-filter");
  if (btn) {
    btn.addEventListener("click", () => {
      historyShowAll = !historyShowAll;
      refreshHistoryPanel();
    });
  }
}

async function doRollback(hash) {
  const scoped = currentTemplateId && !historyShowAll;
  const msg = scoped
    ? "This template's modules will be restored to the selected version. Other templates are not affected."
    : "All theme files will be replaced, but chat history is preserved.";
  const ok = await vibeConfirm("Restore this version?", msg, { confirmLabel: "Restore", confirmClass: "btn--primary" });
  if (!ok) return;
  setStatus("Rolling back...");

  try {
    const payload = { hash };
    if (scoped) payload.templateId = currentTemplateId;
    const res = await fetch("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.error) {
      await vibeAlert(data.error, "Rollback failed");
      setStatus("Ready");
      return;
    }

    if (data.modules) updateModuleList(data.modules);
    refreshPreview();
    appendSystemMessage("Restored to version " + hash.slice(0, 7));
    refreshHistoryPanel();
    setStatus("Ready");
  } catch (err) {
    await vibeAlert(err.message, "Rollback failed");
    setStatus("Ready");
  }
}

function timeAgoShort(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h";
  const days = Math.floor(hours / 24);
  return days + "d";
}

// ---------------------------------------------------------------------------
// Module list
// ---------------------------------------------------------------------------

function updateModuleList(moduleNames) {
  const itemsEl = document.getElementById("module-items");
  const barCountEl = document.getElementById("module-count");
  const slideoutCountEl = document.getElementById("slideout-module-count");

  if (barCountEl) barCountEl.textContent = moduleNames.length;
  if (slideoutCountEl) slideoutCountEl.textContent = moduleNames.length;
  itemsEl.innerHTML = "";

  for (const name of moduleNames) {
    const item = document.createElement("div");
    item.className = "module-item";
    item.dataset.module = name;
    item.innerHTML = `
      <span class="module-item__drag">⠿</span>
      <span class="module-item__name">${escapeHtml(name)}</span>
      <span class="module-item__edit" title="Edit fields">⚙</span>
      <span class="module-item__delete" title="Delete module">&times;</span>
    `;

    item.querySelector(".module-item__edit").addEventListener("click", (e) => {
      e.stopPropagation();
      openFieldEditor(name);
      highlightModuleItem(name);
    });

    item.querySelector(".module-item__delete").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteModule(name);
    });

    itemsEl.appendChild(item);
  }

  setupDragReorder(itemsEl);
}

function highlightModuleItem(name) {
  document.querySelectorAll(".module-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.module === name);
  });
}

// ---------------------------------------------------------------------------
// Module slideout
// ---------------------------------------------------------------------------

function openModuleSlideout() {
  const slideout = document.getElementById("module-slideout");
  document.getElementById("module-list-view").classList.remove("hidden");
  document.getElementById("module-editor-view").classList.add("hidden");
  slideout.classList.add("open");
}

function closeModuleSlideout() {
  document.getElementById("module-slideout").classList.remove("open");
}

function showEditorView(moduleName) {
  document.getElementById("module-list-view").classList.add("hidden");
  document.getElementById("module-editor-view").classList.remove("hidden");
  document.getElementById("module-slideout").classList.add("open");
}

function showModuleListView() {
  document.getElementById("module-editor-view").classList.add("hidden");
  document.getElementById("module-list-view").classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Module library — add modules from other templates
// ---------------------------------------------------------------------------

async function toggleModuleLibraryDropdown() {
  const dropdown = document.getElementById("module-library-dropdown");
  if (!dropdown.classList.contains("hidden")) {
    dropdown.classList.add("hidden");
    return;
  }

  try {
    const res = await fetch("/api/module-library");
    const data = await res.json();
    const currentModules = Array.from(document.querySelectorAll(".module-item"))
      .map((el) => el.dataset.module);

    // Filter to modules not already in current template
    const available = (data.modules || []).filter(
      (m) => !currentModules.includes(m.moduleName)
    );

    if (available.length === 0) {
      dropdown.innerHTML = `<div class="module-library-dropdown__empty">No other modules available</div>`;
    } else {
      dropdown.innerHTML = available.map((m) =>
        `<button class="module-library-dropdown__item" data-name="${escapeHtml(m.moduleName)}">
          <span class="module-library-dropdown__name">${escapeHtml(m.moduleName)}</span>
          <span class="module-library-dropdown__meta">${escapeHtml(m.usedIn.join(", "))}</span>
        </button>`
      ).join("");

      dropdown.querySelectorAll(".module-library-dropdown__item").forEach((btn) => {
        btn.addEventListener("click", () => {
          addModuleFromLibrary(btn.dataset.name);
          dropdown.classList.add("hidden");
        });
      });
    }

    dropdown.classList.remove("hidden");
  } catch (err) {
    console.error("Failed to load module library:", err);
  }
}

async function addModuleFromLibrary(moduleName) {
  try {
    const session = await fetch("/api/session").then((r) => r.json());
    const templateId = session.activeTemplateId || session.id;

    // Use the templates/activate API to copy module
    const res = await fetch(`/api/templates/${encodeURIComponent(templateId)}/add-module`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleName }),
    });
    const data = await res.json();
    if (data.error) {
      console.warn("Add module error:", data.error);
      return;
    }

    // Refresh module list and preview
    const modRes = await fetch("/api/modules");
    const modData = await modRes.json();
    updateModuleList(modData.modules.map((m) => m.moduleName));
    if (typeof refreshPreview === "function") refreshPreview();
  } catch (err) {
    console.error("Failed to add module:", err);
  }
}

// Module bar button → toggle slideout
document.getElementById("btn-modules")?.addEventListener("click", () => {
  const slideout = document.getElementById("module-slideout");
  if (slideout.classList.contains("open")) {
    closeModuleSlideout();
  } else {
    openModuleSlideout();
  }
});

// Add module button (inside slideout)
document.getElementById("btn-add-module").addEventListener("click", toggleModuleLibraryDropdown);

// Slideout close buttons
document.getElementById("module-slideout-close")?.addEventListener("click", closeModuleSlideout);
document.getElementById("field-editor-back")?.addEventListener("click", showModuleListView);
document.getElementById("field-editor-close")?.addEventListener("click", closeModuleSlideout);

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("module-library-dropdown");
  const btn = document.getElementById("btn-add-module");
  if (!dropdown.contains(e.target) && e.target !== btn) {
    dropdown.classList.add("hidden");
  }
});

function confirmDeleteModule(moduleName) {
  return new Promise((resolve) => {
    let deleteEntirely = false;

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">Remove "${escapeHtml(moduleName)}"?</div>
        <p class="confirm-dialog__detail">Module will be removed from this page but kept in your library.</p>
        <label class="confirm-dialog__toggle">
          <span class="confirm-dialog__toggle-switch">
            <input type="checkbox" data-role="toggle" />
            <span class="confirm-dialog__toggle-slider"></span>
          </span>
          <span class="confirm-dialog__toggle-label">Delete entirely</span>
        </label>
        <div class="confirm-dialog__toggle-warn">Cannot be undone!</div>
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" data-action="cancel">Cancel</button>
          <button class="btn btn--primary" data-action="confirm">Remove</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const toggle = overlay.querySelector('[data-role="toggle"]');
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const warnEl = overlay.querySelector(".confirm-dialog__toggle-warn");
    warnEl.style.display = "none";

    toggle.addEventListener("change", () => {
      deleteEntirely = toggle.checked;
      if (deleteEntirely) {
        confirmBtn.textContent = "Delete";
        confirmBtn.className = "btn btn--danger";
        warnEl.style.display = "";
      } else {
        confirmBtn.textContent = "Remove";
        confirmBtn.className = "btn btn--primary";
        warnEl.style.display = "none";
      }
    });

    const close = (confirmed) => {
      overlay.remove();
      if (!confirmed) { resolve(); return; }

      fetch("/api/modules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleName, deleteEntirely }),
      }).then(() => {
        const item = document.querySelector(`.module-item[data-module="${CSS.escape(moduleName)}"]`);
        if (item) item.remove();
        const countEl = document.getElementById("module-count");
        const slideoutCountEl = document.getElementById("slideout-module-count");
        const count = document.querySelectorAll(".module-item").length;
        if (countEl) countEl.textContent = count;
        if (slideoutCountEl) slideoutCountEl.textContent = count;
        refreshPreview();
        resolve();
      }).catch(() => resolve());
    };

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
  });
}

// ---------------------------------------------------------------------------
// Drag-and-drop reordering (smooth sortable animation)
// ---------------------------------------------------------------------------

function setupDragReorder(container) {
  container.querySelectorAll(".module-item").forEach((item) => {
    item.addEventListener("mousedown", (e) => {
      // Skip if clicking on edit/delete controls
      if (e.target.closest(".module-item__edit") || e.target.closest(".module-item__delete")) return;

      e.preventDefault();
      const dragItem = item;
      const moduleName = dragItem.dataset.module;
      const startY = e.clientY;
      const DRAG_THRESHOLD = 5;
      let isDragging = false;
      let items, startIdx, itemRects, itemHeight, currentIdx;

      const startDrag = () => {
        isDragging = true;
        items = [...container.querySelectorAll(".module-item")];
        startIdx = items.indexOf(dragItem);
        itemRects = items.map((it) => it.getBoundingClientRect());
        itemHeight = itemRects[startIdx]?.height || 36;
        currentIdx = startIdx;

        dragItem.classList.add("module-item--dragging");
        items.forEach((it) => {
          if (it !== dragItem) it.classList.add("module-item--placeholder");
        });
      };

      const onMove = (ev) => {
        const dy = ev.clientY - startY;

        if (!isDragging) {
          if (Math.abs(dy) >= DRAG_THRESHOLD) {
            startDrag();
          } else {
            return;
          }
        }

        dragItem.style.transform = `translateY(${dy}px)`;

        const cursorY = ev.clientY;
        let newIdx = startIdx;
        for (let i = 0; i < itemRects.length; i++) {
          const mid = itemRects[i].top + itemRects[i].height / 2;
          if (cursorY > mid) newIdx = i;
        }
        newIdx = Math.max(0, Math.min(items.length - 1, newIdx));

        if (newIdx !== currentIdx) {
          currentIdx = newIdx;
          items.forEach((it, i) => {
            if (it === dragItem) return;
            if (currentIdx > startIdx && i > startIdx && i <= currentIdx) {
              it.style.transform = `translateY(${-itemHeight}px)`;
            } else if (currentIdx < startIdx && i >= currentIdx && i < startIdx) {
              it.style.transform = `translateY(${itemHeight}px)`;
            } else {
              it.style.transform = "";
            }
          });
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        if (!isDragging) {
          // Was a click — navigate to module
          scrollPreviewToModule(moduleName);
          highlightModuleItem(moduleName);
          return;
        }

        dragItem.classList.remove("module-item--dragging");
        dragItem.style.transform = "";
        items.forEach((it) => {
          it.classList.remove("module-item--placeholder");
          it.style.transform = "";
        });

        if (currentIdx !== startIdx) {
          if (currentIdx < startIdx) {
            container.insertBefore(dragItem, items[currentIdx]);
          } else {
            const ref = items[currentIdx].nextSibling;
            container.insertBefore(dragItem, ref);
          }
        }

        const newOrder = [...container.querySelectorAll(".module-item")].map(
          (el) => el.dataset.module
        );
        fetch("/api/modules/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: newOrder }),
        }).then(() => refreshPreview());
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Send button
sendBtn.addEventListener("click", () => {
  sendMessage(inputEl.value);
});

// Enter to send (Shift+Enter for newline)
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

// Auto-grow textarea
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
});

// Pre-fill chat input from preview select-mode click
window.prefillChatInput = function (text) {
  if (!text) return;
  const existing = inputEl.value;
  const prefix = existing.trim() ? existing.replace(/\s+$/, "") + "\n\n" : "";
  inputEl.value = prefix + text;
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
  inputEl.focus();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
};

// Starter template buttons
document.getElementById("starter-templates").addEventListener("click", (e) => {
  const btn = e.target.closest(".starter-btn");
  if (btn) sendMessage(btn.dataset.prompt);
});

// Templates icon in input area — toggle welcome section visibility
document.getElementById("btn-starter-templates")?.addEventListener("click", () => {
  const welcome = document.getElementById("chat-welcome");
  if (welcome) welcome.classList.toggle("hidden");
});

// Version history
document.getElementById("btn-history")?.addEventListener("click", toggleHistoryPanel);
document.getElementById("history-panel-close")?.addEventListener("click", () => {
  historyPanelOpen = false;
  document.getElementById("history-panel")?.classList.add("hidden");
});

// Import from GitHub is now on the setup screen (setup.js)

// Upload button — triggers the upload panel
document.getElementById("btn-upload").addEventListener("click", () => {
  if (typeof startUpload === "function") {
    startUpload();
  }
});

// Resize handle
const resizeHandle = document.getElementById("resize-handle");
const panelLeft = document.getElementById("panel-left");

resizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  resizeHandle.classList.add("dragging");

  const onMove = (e) => {
    const width = Math.max(300, Math.min(600, e.clientX));
    panelLeft.style.width = width + "px";
  };

  const onUp = () => {
    resizeHandle.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// Responsive toggle
document.getElementById("responsive-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".responsive-btn");
  if (!btn) return;

  document.querySelectorAll(".responsive-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  const chrome = document.getElementById("browser-chrome");
  const width = btn.dataset.width;
  const isFullWidth = width === "100%";
  chrome.style.maxWidth = isFullWidth ? "none" : width;
  chrome.style.flex = isFullWidth ? "1" : "none";
  chrome.style.width = isFullWidth ? "" : width;

  // Update browser URL bar with theme name
  const urlEl = document.getElementById("browser-url");
  const themeName = document.getElementById("theme-name")?.textContent || "vibespot.app";
  if (urlEl) urlEl.textContent = themeName + ".vibespot.app";
});

// ---------------------------------------------------------------------------
// HubSpot account status pill
// ---------------------------------------------------------------------------

async function fetchHsAccountStatus() {
  const pill = document.getElementById("status-hs-account");
  if (!pill) return;

  try {
    const res = await fetch("/api/settings/status");
    const data = await res.json();
    const hs = data.environment?.tools?.hubspot;

    if (hs && hs.authenticated && hs.portalName) {
      pill.innerHTML = `<span class="statusbar__dot statusbar__dot--ok"></span>${hs.portalName}${hs.portalId ? " (" + hs.portalId + ")" : ""}`;
      pill.classList.add("statusbar__pill--visible");
    } else {
      pill.textContent = "";
      pill.classList.remove("statusbar__pill--visible");
    }
  } catch {
    // Silently ignore
  }
}

// ---------------------------------------------------------------------------
// Topbar theme-name rename (double-click)
// ---------------------------------------------------------------------------

document.getElementById("theme-name")?.addEventListener("dblclick", () => {
  const el = document.getElementById("theme-name");
  if (!el || !currentSessionId) return;
  if (el.contentEditable === "true") return;

  const oldName = el.textContent.trim();
  el.contentEditable = "true";
  el.classList.add("topbar__project-pill--editing");
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function commit() {
    el.contentEditable = "false";
    el.classList.remove("topbar__project-pill--editing");

    const newName = el.textContent.trim();
    if (!newName || newName === oldName) {
      el.textContent = oldName;
      return;
    }

    fetch("/api/themes/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, newName }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          el.textContent = data.newName;
          if (typeof currentAppTheme !== "undefined") currentAppTheme = data.newName;
          window.location.hash = "#/app/" + encodeURIComponent(data.newName);
          // Update rail item
          const railItem = document.querySelector(`.project-rail__item[data-name="${oldName}"]`);
          if (railItem) {
            railItem.dataset.name = data.newName;
            const nameSpan = railItem.querySelector(".project-rail__item-name");
            if (nameSpan) nameSpan.textContent = data.newName;
            const bubble = railItem.querySelector(".project-rail__item-bubble");
            if (bubble) bubble.textContent = data.newName.charAt(0).toUpperCase();
          }
          if (typeof updateRailActive === "function") updateRailActive();
        } else {
          el.textContent = oldName;
          showError(data.error || "Rename failed");
        }
      })
      .catch(() => {
        el.textContent = oldName;
        showError("Rename failed");
      });
  }

  el.addEventListener("blur", commit, { once: true });
  el.addEventListener("keydown", function handler(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      el.removeEventListener("keydown", handler);
      el.blur();
    }
    if (e.key === "Escape") {
      el.textContent = oldName;
      el.removeEventListener("keydown", handler);
      el.blur();
    }
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

// WebSocket connection is started by setup.js after a session is created.
// Do NOT auto-connect here.
