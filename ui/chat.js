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

// Change tracking for the in-flight generation. `modulesBeforeRun` snapshots
// the module list when the user submits a prompt so we can tell which modules
// are brand new when the run finishes. `changedModulesInRun` accumulates names
// from per-module `module_progress` events. The flag is set on
// `generation_complete` so the *next* `modules_updated` (the post-run one)
// triggers the highlight pass instead of a plain refresh.
let modulesBeforeRun = null;
let changedModulesInRun = new Set();
let highlightOnNextModulesUpdated = false;
let changedListClearTimer = null;

const messagesEl = document.getElementById("chat-messages");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("chat-send");
const statusText = document.getElementById("status-text");
const statusEngine = document.getElementById("status-engine");

// Snapshot the welcome section before any init can destroy it
const _welcomeHtml = document.getElementById("chat-welcome")?.outerHTML || "";

function restoreWelcome() {
  if (!_welcomeHtml || messagesEl.querySelector(".chat__welcome")) return;
  messagesEl.insertAdjacentHTML("afterbegin", _welcomeHtml);
  const el = messagesEl.querySelector("#conversation-starters");
  if (el) el.addEventListener("click", handleConversationStarterClick);
}

function handleConversationStarterClick(e) {
  const btn = e.target.closest(".starter-btn");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "describe") {
    inputEl?.focus();
  } else if (action === "figma") {
    document.getElementById("btn-attach-file")?.click();
  } else if (action === "hubspot-import") {
    if (inputEl) {
      inputEl.value = "Import this HubSpot page and adapt it: ";
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
      inputEl.focus();
      const end = inputEl.value.length;
      inputEl.setSelectionRange(end, end);
    }
  }
}

// ---------------------------------------------------------------------------
// Page tabs (multi-page template switcher)
// ---------------------------------------------------------------------------

let currentTemplates = [];

const PAGE_TYPE_BADGES = {
  landing_page: "LP",
  blog_post: "Blog",
  website_page: "Web",
  email: "Email",
  module_only: "Sec",
};

function renderPageTabs(templates, activeTemplateId) {
  const container = document.getElementById("page-tree");
  const list = document.getElementById("page-tabs-list");
  if (!list) return;

  currentTemplates = templates || [];

  list.innerHTML = currentTemplates.map((t) => {
    const isActive = t.id === activeTemplateId;
    const badge = PAGE_TYPE_BADGES[t.pageType] || "";
    return `<button class="page-tabs__tab${isActive ? " page-tabs__tab--active" : ""}" data-template-id="${t.id}" title="${t.label} (${t.moduleCount} modules)">
      ${badge ? `<span class="page-tabs__tab-badge">${badge}</span>` : ""}
      <span class="page-tabs__tab-label">${escapeHtml(t.label)}</span>
      <span class="page-tabs__tab-count">${t.moduleCount}</span>
    </button>`;
  }).join("");
}

function handlePageTabClick(e) {
  const tab = e.target.closest(".page-tabs__tab");
  if (!tab) return;
  const templateId = tab.dataset.templateId;
  if (!templateId || templateId === currentTemplateId) return;
  if (isStreaming) return;

  tab.style.opacity = "0.5";
  fetch("/api/templates/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId }),
  }).then((res) => {
    if (!res.ok) {
      tab.style.opacity = "";
      return;
    }
    connectWebSocket();
  }).catch(() => {
    tab.style.opacity = "";
  });
}

function handleAddPage() {
  if (isStreaming) return;
  const inlineForm = document.getElementById("page-tree-add-inline");
  if (inlineForm) {
    inlineForm.classList.toggle("hidden");
    if (!inlineForm.classList.contains("hidden")) {
      document.getElementById("page-tree-name")?.focus();
    }
    return;
  }
  const label = prompt("Page name:");
  if (!label || !label.trim()) return;
  createPage("website_page", label.trim());
}

function handleInlineCreate() {
  if (isStreaming) return;
  const nameInput = document.getElementById("page-tree-name");
  const typeSelect = document.getElementById("page-tree-type");
  const label = nameInput?.value?.trim();
  if (!label) { nameInput?.focus(); return; }
  const pageType = typeSelect?.value || "website_page";
  createPage(pageType, label);
  nameInput.value = "";
  document.getElementById("page-tree-add-inline")?.classList.add("hidden");
}

function createPage(pageType, label) {
  fetch("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageType, label }),
  }).then((res) => {
    if (!res.ok) return;
    return res.json();
  }).then((data) => {
    if (data && data.id) {
      return fetch("/api/templates/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: data.id }),
      });
    }
  }).then((res) => {
    if (res && res.ok) connectWebSocket();
  });
}

(function initPageTree() {
  const list = document.getElementById("page-tabs-list");
  const addBtn = document.getElementById("btn-add-page");
  const createBtn = document.getElementById("page-tree-create");
  const nameInput = document.getElementById("page-tree-name");
  if (list) list.addEventListener("click", handlePageTabClick);
  if (addBtn) addBtn.addEventListener("click", handleAddPage);
  if (createBtn) createBtn.addEventListener("click", handleInlineCreate);
  if (nameInput) nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleInlineCreate();
    if (e.key === "Escape") document.getElementById("page-tree-add-inline")?.classList.add("hidden");
  });
})();

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
      const _mi = document.getElementById("module-items"); if (_mi) _mi.innerHTML = "";
      const _mc = document.getElementById("module-count") || document.getElementById("slideout-module-count"); if (_mc) _mc.textContent = "0";
      hideChatSuggestions();
      // Reset pipeline state — DOM nodes were detached by innerHTML clear
      resetPipelineState();
      stopPipelineTimer();
      streamingMsgEl = null;

      if (msg.modules && msg.modules.length > 0) {
        updateModuleList(msg.modules);
        refreshPreview();
      }

      // Render page tabs for multi-page projects
      renderPageTabs(msg.templates, currentTemplateId);

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
      } else {
        restoreWelcome();
      }

      // Show/hide version history button
      const historyBtn = document.getElementById("btn-history");
      if (historyBtn) {
        historyBtn.style.display = msg.gitAvailable ? "" : "none";
      }

      // Initialize history timeline (compact strip above chat input)
      historyGitAvailable = !!msg.gitAvailable;
      if (historyGitAvailable) {
        historyTimelineCursor = 0;
        refreshHistoryTimeline();
      } else {
        const tl = document.getElementById("history-timeline");
        if (tl) tl.classList.add("hidden");
      }

      // Hydrate plan-mode state (toggle + Plan pane content)
      if (window.planController) {
        window.planController.setInitialState(msg);
      }

      // If a pipeline is actively running (reconnect scenario), lock the
      // input so the user can't double-submit. Replayed pipeline events
      // that follow this init message will rebuild the progress UI.
      if (msg.isGenerating) {
        isStreaming = true;
        sendBtn.disabled = true;
        streamStartTime = Date.now();
        if (typeof window.setSelectModeDisabled === "function") {
          window.setSelectModeDisabled(true);
        }
        if (typeof window.setEditModeDisabled === "function") {
          window.setEditModeDisabled(true);
        }
      }

      // If setup handed us an initial prompt (describe-it path), send it now
      // that the session is live. Skip if the project already has history
      // (e.g. resumed session) to avoid double-submitting.
      if (window.__pendingInitialPrompt) {
        const pendingPrompt = window.__pendingInitialPrompt;
        window.__pendingInitialPrompt = null;
        const hasHistory = msg.messages && msg.messages.length > 0;
        if (!hasHistory) {
          setTimeout(() => sendMessage(pendingPrompt), 50);
        }
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
      // The next `modules_updated` is the terminal one for this run — let it
      // fire the change-highlight pass on the preview iframe.
      highlightOnNextModulesUpdated = true;
      break;

    case "modules_updated":
      if (msg.modules) {
        updateModuleList(msg.modules);
      }
      if (msg.templates) {
        if (msg.templateId) currentTemplateId = msg.templateId;
        renderPageTabs(msg.templates, currentTemplateId);
      }
      if (highlightOnNextModulesUpdated) {
        highlightOnNextModulesUpdated = false;
        flushChangeHighlights(msg.modules || []);
      } else {
        refreshPreview();
      }
      break;

    case "version_created":
      if (historyPanelOpen) refreshHistoryPanel();
      // New generation: reset timeline cursor to head and refresh.
      historyTimelineCursor = 0;
      refreshHistoryTimeline();
      break;

    case "parse_warning":
      appendSystemMessage(msg.message || "Module changes could not be applied.");
      break;

    case "error":
      stopPipelineTimer();
      stopPipelineEstimate();
      if (typeof clearAllModulesWorking === "function") clearAllModulesWorking();
      finishStreaming();
      resetPipelineState();
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
      { const _mi = document.getElementById("module-items"); if (_mi) _mi.innerHTML = ""; }
      { const _mc = document.getElementById("module-count") || document.getElementById("slideout-module-count"); if (_mc) _mc.textContent = "0"; }
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
  developing: "Building",
  quality_check: "Quality Check",
};
const STEP_ORDER = ["analyzing", "designing", "developing", "quality_check"];

const STEP_ICONS = {
  analyzing:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  designing:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20c1.4 0 2-.9 2-2 0-.5-.2-1-.5-1.4a1.5 1.5 0 0 1 1.2-2.4H17a5 5 0 0 0 5-5c0-5.5-4.5-9.2-10-9.2z"/><circle cx="7.5" cy="10.5" r="1.4"/><circle cx="12" cy="7.5" r="1.4"/><circle cx="16.5" cy="10.5" r="1.4"/></svg>',
  developing:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  quality_check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.5 9.4 8 10 4.5-.6 8-5 8-10V6l-8-4z"/></svg>',
};

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 13 10 18 20 7"/></svg>';

// Per-module wall-clock seconds. Rough heuristic for time-remaining display.
const ESTIMATED_SECONDS_PER_MODULE = 14;

let pipelineBubbleEl = null;
let pipelineStepperEl = null;
let pipelineDetailEl = null;
let pipelineModulesEl = null;
let pipelineEstimateEl = null;
let pipelineCurrentStep = null;
let pipelineEstimateInterval = null;

function buildStepperHtml() {
  const parts = [];
  for (let i = 0; i < STEP_ORDER.length; i++) {
    const step = STEP_ORDER[i];
    parts.push(`
      <div class="pipeline-stage pipeline-stage--pending" data-stage="${step}">
        <div class="pipeline-stage__indicator">
          <span class="pipeline-stage__icon">${STEP_ICONS[step]}</span>
          <span class="pipeline-stage__check">${CHECK_ICON}</span>
        </div>
        <div class="pipeline-stage__label">${STEP_LABELS[step]}</div>
      </div>`);
    if (i < STEP_ORDER.length - 1) {
      parts.push('<div class="pipeline-stage__connector" data-after="' + step + '"></div>');
    }
  }
  return `<div class="pipeline-stepper" role="progressbar" aria-label="Generation progress">${parts.join("")}</div>`;
}

function buildPipelineBodyHtml() {
  return `
    ${buildStepperHtml()}
    <div class="pipeline-detail" hidden></div>
    <div class="pipeline-modules"></div>
    <div class="pipeline-footer">
      <div class="pipeline-timer"></div>
      <div class="pipeline-estimate" hidden></div>
    </div>`;
}

function captureBubbleRefs(bubbleEl, container) {
  pipelineBubbleEl = container;
  pipelineStepperEl = bubbleEl.querySelector(".pipeline-stepper");
  pipelineDetailEl = bubbleEl.querySelector(".pipeline-detail");
  pipelineModulesEl = bubbleEl.querySelector(".pipeline-modules");
  pipelineEstimateEl = bubbleEl.querySelector(".pipeline-estimate");
}

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
      streamingMsgEl.innerHTML = buildPipelineBodyHtml();
      captureBubbleRefs(streamingMsgEl, existingDiv);
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
        ${buildPipelineBodyHtml()}
      </div>
    </div>`;
  messagesEl.appendChild(div);

  streamingMsgEl = div.querySelector(".chat-msg__bubble");
  captureBubbleRefs(streamingMsgEl, div);
  startPipelineTimer(div.querySelector(".pipeline-timer"));
  scrollToBottom();
}

function setStageStatus(step, status) {
  if (!pipelineStepperEl) return;
  const stage = pipelineStepperEl.querySelector(`[data-stage="${step}"]`);
  if (!stage) return;
  stage.classList.remove(
    "pipeline-stage--pending",
    "pipeline-stage--active",
    "pipeline-stage--done",
    "pipeline-stage--failed",
  );
  stage.classList.add("pipeline-stage--" + status);

  // Fill the connector behind this stage when it becomes active or done.
  const idx = STEP_ORDER.indexOf(step);
  if (idx > 0) {
    const prev = STEP_ORDER[idx - 1];
    const conn = pipelineStepperEl.querySelector(`[data-after="${prev}"]`);
    if (conn) conn.classList.add("pipeline-stage__connector--filled");
  }
}

function setPipelineDetail(text) {
  if (!pipelineDetailEl) return;
  if (!text) {
    pipelineDetailEl.hidden = true;
    pipelineDetailEl.textContent = "";
    return;
  }
  pipelineDetailEl.hidden = false;
  pipelineDetailEl.classList.remove("pipeline-detail--in");
  // Force reflow so the animation restarts when text changes
  void pipelineDetailEl.offsetWidth;
  pipelineDetailEl.classList.add("pipeline-detail--in");
  pipelineDetailEl.textContent = text;
}

function handleAgentStep(msg) {
  ensurePipelineBubble();

  const incoming = msg.step;
  const incomingIdx = STEP_ORDER.indexOf(incoming);

  // Mark all prior stages done (handles forward jumps + repeated firings)
  if (incomingIdx >= 0) {
    for (let i = 0; i < incomingIdx; i++) {
      const prevStage = pipelineStepperEl.querySelector(`[data-stage="${STEP_ORDER[i]}"]`);
      if (prevStage && !prevStage.classList.contains("pipeline-stage--done")) {
        setStageStatus(STEP_ORDER[i], "done");
      }
    }
  }

  setStageStatus(incoming, "active");
  pipelineCurrentStep = incoming;

  setPipelineDetail(msg.label || STEP_LABELS[incoming] || incoming);

  if (incoming === "developing") {
    pipelineModulesEl.innerHTML = "";
    startPipelineEstimate();
  } else {
    stopPipelineEstimate();
    if (pipelineEstimateEl) pipelineEstimateEl.hidden = true;
  }

  scrollToBottom();
}

function handleAgentDecision(msg) {
  if (!pipelineBubbleEl) return;
  setPipelineDetail(msg.decision);
  scrollToBottom();
}

function handleModuleProgress(msg) {
  ensurePipelineBubble();

  let card = pipelineModulesEl.querySelector(`[data-module="${CSS.escape(msg.module)}"]`);
  if (!card) {
    card = document.createElement("div");
    card.dataset.module = msg.module;
    card.innerHTML = `
      <div class="pipeline-module-card__head">
        <span class="pipeline-module-card__name">${escapeHtml(msg.module)}</span>
        <span class="pipeline-module-card__status"></span>
      </div>
      <div class="pipeline-module-card__progress"><div class="pipeline-module-card__progress-bar"></div></div>
      <div class="pipeline-module-card__skeleton">
        <div class="pipeline-module-card__skeleton-row pipeline-module-card__skeleton-row--lg"></div>
        <div class="pipeline-module-card__skeleton-row pipeline-module-card__skeleton-row--md"></div>
        <div class="pipeline-module-card__skeleton-row pipeline-module-card__skeleton-row--sm"></div>
      </div>`;
    pipelineModulesEl.appendChild(card);
  }

  const statusEl = card.querySelector(".pipeline-module-card__status");
  card.className = "pipeline-module-card pipeline-module-card--" + msg.status;

  const statusLabels = {
    queued: "queued",
    generating: "generating",
    validating: "validating",
    retrying: "retrying",
    complete: "done",
    failed: "failed",
  };
  if (statusEl) statusEl.textContent = statusLabels[msg.status] || msg.status;

  if (msg.status === "generating" && typeof markModulesWorking === "function") {
    markModulesWorking([msg.module]);
  } else if ((msg.status === "complete" || msg.status === "failed") && typeof clearModuleWorking === "function") {
    clearModuleWorking(msg.module);
  }

  updatePipelineEstimate();

  if (msg.status === "complete" && msg.module) {
    changedModulesInRun.add(msg.module);
  }

  scrollToBottom();
}

function startPipelineEstimate() {
  stopPipelineEstimate();
  if (!pipelineEstimateEl) return;
  pipelineEstimateEl.hidden = false;
  updatePipelineEstimate();
  pipelineEstimateInterval = setInterval(updatePipelineEstimate, 1000);
}

function stopPipelineEstimate() {
  if (pipelineEstimateInterval) {
    clearInterval(pipelineEstimateInterval);
    pipelineEstimateInterval = null;
  }
}

function updatePipelineEstimate() {
  if (!pipelineEstimateEl || pipelineCurrentStep !== "developing" || !pipelineModulesEl) return;
  const cards = pipelineModulesEl.querySelectorAll(".pipeline-module-card");
  if (!cards.length) {
    pipelineEstimateEl.textContent = "Estimating…";
    return;
  }
  let remaining = 0;
  let inFlight = 0;
  cards.forEach((c) => {
    if (c.classList.contains("pipeline-module-card--complete") || c.classList.contains("pipeline-module-card--failed")) return;
    remaining++;
    if (
      c.classList.contains("pipeline-module-card--generating") ||
      c.classList.contains("pipeline-module-card--validating") ||
      c.classList.contains("pipeline-module-card--retrying")
    ) {
      inFlight++;
    }
  });
  if (remaining === 0) {
    pipelineEstimateEl.textContent = "Wrapping up…";
    return;
  }
  // Default concurrency limiter is 20 modules, but most chats only have a
  // handful — assume 4-way effective parallelism for the estimate.
  const parallel = Math.max(1, Math.min(4, inFlight || 1));
  const seconds = Math.max(5, Math.ceil((remaining * ESTIMATED_SECONDS_PER_MODULE) / parallel));
  pipelineEstimateEl.textContent = `~${formatEstimate(seconds)} remaining`;
}

function formatEstimate(totalSec) {
  if (totalSec < 60) return totalSec + "s";
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (s === 0) return m + "m";
  return m + "m " + s + "s";
}

function handlePipelineComplete(msg) {
  if (!pipelineBubbleEl) return;

  stopPipelineTimer();
  stopPipelineEstimate();
  if (typeof clearAllModulesWorking === "function") clearAllModulesWorking();

  STEP_ORDER.forEach((s) => setStageStatus(s, "done"));
  pipelineCurrentStep = null;
  setPipelineDetail("");

  const footer = pipelineBubbleEl.querySelector(".pipeline-footer");
  if (footer) footer.remove();

  const bubble = streamingMsgEl || pipelineBubbleEl;

  if (msg.answer) {
    const answerEl = document.createElement("div");
    answerEl.className = "pipeline-answer";
    answerEl.textContent = msg.answer;
    bubble.appendChild(answerEl);
  } else if (msg.assistantMessage) {
    streamBuffer = msg.assistantMessage;
  }

  clearStreamStatus();
  finishStreaming();

  const stats = document.createElement("div");
  stats.className = "pipeline-stats";
  const duration = formatDuration(msg.durationMs);
  if (msg.answer) {
    stats.textContent = `Answered in ${duration}`;
  } else {
    stats.textContent = `Generated ${msg.modulesGenerated} module${msg.modulesGenerated === 1 ? "" : "s"} in ${duration}`;
    if (msg.modulesUnchanged > 0) {
      stats.textContent += ` (${msg.modulesUnchanged} unchanged)`;
    }
  }
  bubble.appendChild(stats);

  resetPipelineState();
}

function handlePipelinePartial(msg) {
  if (!pipelineBubbleEl) return;

  stopPipelineTimer();
  stopPipelineEstimate();
  if (typeof clearAllModulesWorking === "function") clearAllModulesWorking();

  STEP_ORDER.forEach((s) => setStageStatus(s, "done"));
  pipelineCurrentStep = null;
  setPipelineDetail("");

  const footer = pipelineBubbleEl.querySelector(".pipeline-footer");
  if (footer) footer.remove();

  const bubble = streamingMsgEl || pipelineBubbleEl;

  clearStreamStatus();
  finishStreaming();

  const stats = document.createElement("div");
  stats.className = "pipeline-stats pipeline-stats--partial";
  const duration = formatDuration(msg.durationMs);
  stats.textContent = `${msg.succeeded.length} modules succeeded, ${msg.failed.length} failed in ${duration}`;
  bubble.appendChild(stats);

  resetPipelineState();
}

function resetPipelineState() {
  pipelineBubbleEl = null;
  pipelineStepperEl = null;
  pipelineDetailEl = null;
  pipelineModulesEl = null;
  pipelineEstimateEl = null;
  pipelineCurrentStep = null;

  renderChatSuggestions();
}

// ---------------------------------------------------------------------------
// Smart chat suggestions — contextual next-step chips after generation
// ---------------------------------------------------------------------------

let suggestionsVisible = false;

function getCurrentModuleNames() {
  return Array.from(document.querySelectorAll("#module-items .module-item"))
    .map((el) => (el.dataset.module || "").toLowerCase());
}

function pickContextualSuggestions(moduleNames) {
  const has = (kw) => moduleNames.some((n) => n.includes(kw));
  const additive = [];

  if (!has("testimonial") && !has("review") && !has("quote")) {
    additive.push("Add a testimonials module");
  }
  if (!has("pricing") && !has("plan") && !has("tier")) {
    additive.push("Add a pricing table");
  }
  if (!has("faq") && !has("question")) {
    additive.push("Add an FAQ module");
  }
  if (!has("contact") && !has("form")) {
    additive.push("Add a contact form");
  }
  if (!has("hero") && !has("banner")) {
    additive.push("Add a hero module");
  }
  if (!has("feature") && !has("benefit")) {
    additive.push("Add a features grid with icons");
  }
  if (!has("footer")) {
    additive.push("Add a footer with social links");
  }
  if (!has("stat") && !has("metric") && !has("number")) {
    additive.push("Add a stats module with key numbers");
  }
  if (!has("cta") && !has("call")) {
    additive.push("Add a call-to-action module");
  }

  const refinements = [
    has("hero") || has("banner")
      ? "Make the hero CTA more prominent"
      : "Strengthen the opening hook",
    "Change the color scheme to something bolder",
    "Refine the typography for a more modern feel",
    "Add subtle animations to bring it to life",
  ];

  const out = [];
  for (const s of additive) {
    if (out.length >= 3) break;
    out.push(s);
  }
  for (const r of refinements) {
    if (out.length >= 3) break;
    out.push(r);
  }
  return out;
}

function renderChatSuggestions() {
  const container = document.getElementById("chat-suggestions");
  if (!container) return;

  if (isStreaming || (inputEl && inputEl.value && inputEl.value.length > 0)) {
    hideChatSuggestions();
    return;
  }

  const suggestions = pickContextualSuggestions(getCurrentModuleNames());
  if (!suggestions.length) {
    hideChatSuggestions();
    return;
  }

  container.innerHTML = "";
  for (const text of suggestions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat__suggestion-chip";
    btn.dataset.suggestion = text;
    btn.textContent = text;
    container.appendChild(btn);
  }
  container.classList.remove("hidden");
  suggestionsVisible = true;
}

function hideChatSuggestions() {
  const container = document.getElementById("chat-suggestions");
  if (!container) return;
  container.classList.add("hidden");
  container.innerHTML = "";
  suggestionsVisible = false;
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
    const container = el.querySelector(".chat-msg__system");
    if (container) {
      container.innerHTML =
        '<span class="brand-extraction-prompt__status">Extracting…</span>';
    }
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

  // Snapshot the current module list so we can detect new vs. modified modules
  // when the generation finishes. Clears stale change-indicator dots from any
  // previous run so the user only sees indicators for the run they just kicked.
  modulesBeforeRun = new Set(
    Array.from(document.querySelectorAll(".module-item")).map((el) => el.dataset.module),
  );
  changedModulesInRun = new Set();
  clearModuleListChanged();

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
  if (typeof window.setEditModeDisabled === "function") {
    window.setEditModeDisabled(true);
  }

  hideChatSuggestions();
  if (typeof updateHistoryTimelineNavState === "function") updateHistoryTimelineNavState();

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
  if (typeof window.setEditModeDisabled === "function") {
    window.setEditModeDisabled(false);
  }
  if (typeof updateHistoryTimelineNavState === "function") updateHistoryTimelineNavState();

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
    // Finalized stepper — every visited stage shown as done
    const stagesSeen = new Set(pipeline.steps.map((s) => s.step));
    const stepperParts = [];
    for (let i = 0; i < STEP_ORDER.length; i++) {
      const step = STEP_ORDER[i];
      const visited = stagesSeen.has(step);
      const stateClass = visited ? "pipeline-stage--done" : "pipeline-stage--pending";
      stepperParts.push(`
        <div class="pipeline-stage ${stateClass}" data-stage="${step}">
          <div class="pipeline-stage__indicator">
            <span class="pipeline-stage__icon">${STEP_ICONS[step]}</span>
            <span class="pipeline-stage__check">${CHECK_ICON}</span>
          </div>
          <div class="pipeline-stage__label">${STEP_LABELS[step]}</div>
        </div>`);
      if (i < STEP_ORDER.length - 1) {
        const filled = visited && stagesSeen.has(STEP_ORDER[i + 1]) ? "pipeline-stage__connector--filled" : "";
        stepperParts.push(`<div class="pipeline-stage__connector ${filled}" data-after="${step}"></div>`);
      }
    }

    const allDecisions = pipeline.steps.flatMap((s) => s.decisions || []);
    const decisionHtml = allDecisions.length
      ? `<details class="pipeline-detail-summary"><summary>${allDecisions.length} decision${allDecisions.length === 1 ? "" : "s"} logged</summary>${allDecisions.map((d) => `<div class="pipeline-detail-summary__row">${escapeHtml(d)}</div>`).join("")}</details>`
      : "";

    const modulesHtml = pipeline.modules && pipeline.modules.length > 0
      ? `<div class="pipeline-modules pipeline-modules--restored">${pipeline.modules
          .map((m) => {
            const statusClass = m.status === "failed" ? "pipeline-module-card--failed" : "pipeline-module-card--complete";
            const statusLabel = m.status === "failed" ? "failed" : "done";
            return `<div class="pipeline-module-card ${statusClass}"><div class="pipeline-module-card__head"><span class="pipeline-module-card__name">${escapeHtml(m.name)}</span><span class="pipeline-module-card__status">${statusLabel}</span></div></div>`;
          })
          .join("")}</div>`
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
          <div class="pipeline-stepper">${stepperParts.join("")}</div>
          ${decisionHtml}
          ${modulesHtml}
          <div class="${statsClass}">${statsText}</div>
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
// History timeline — compact strip above chat input with undo/redo support
// ---------------------------------------------------------------------------

let historyGitAvailable = false;
// Index into historyTimelineEntries (filtered list, newest first) representing
// the version the user is currently viewing. 0 = head, N = N steps back.
let historyTimelineCursor = 0;
let historyTimelineEntries = [];
let historyTimelineRestoring = false;

function shortenCommitMessage(msg) {
  if (!msg) return "Update";
  let s = msg;
  // Strip [templateId] prefix
  const prefix = s.match(/^\[[^\]]+\]\s*/);
  if (prefix) s = s.slice(prefix[0].length);
  // Strip leading "Rollback to: "
  s = s.replace(/^Rollback to:\s*/i, "");
  if (s.length > 32) s = s.slice(0, 31) + "…";
  return s;
}

function stripCommitPrefix(msg) {
  return (msg || "").replace(/^\[[^\]]+\]\s*/, "");
}

// Compute which timeline entry represents the *currently visible* version.
// HEAD may be a "Rollback to: <original>" commit (an internal marker we filter
// out of the visible timeline); in that case, we map back to the original
// entry by message. Otherwise the cursor sits at HEAD itself.
function computeCursorFromHead(commits, entries) {
  if (!commits.length || !entries.length) return 0;
  const headMsg = stripCommitPrefix(commits[0].message);
  if (/^rollback to:\s*/i.test(headMsg)) {
    const orig = headMsg.replace(/^rollback to:\s*/i, "").trim().replace(/\.{3}$/, "");
    for (let i = 0; i < entries.length; i++) {
      const em = stripCommitPrefix(entries[i].message);
      if (em === orig || em.startsWith(orig)) return i;
    }
    return 0;
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].fullHash === commits[0].fullHash) return i;
  }
  return 0;
}

async function refreshHistoryTimeline() {
  const tl = document.getElementById("history-timeline");
  const track = document.getElementById("history-timeline-track");
  if (!tl || !track) return;

  if (!historyGitAvailable) {
    tl.classList.add("hidden");
    return;
  }

  try {
    const useFilter = currentTemplateId;
    const url = useFilter
      ? `/api/history?templateId=${encodeURIComponent(currentTemplateId)}`
      : "/api/history";
    const res = await fetch(url);
    const data = await res.json();
    if (!data.available) {
      tl.classList.add("hidden");
      return;
    }

    const allCommits = data.commits || [];
    // Filter out automatic "Rollback to:" commits — they're internal markers.
    // The user navigates the conceptual history of generation events.
    const entries = allCommits.filter((c) => {
      return !/^rollback to:\s*/i.test(stripCommitPrefix(c.message));
    });
    historyTimelineEntries = entries;

    if (entries.length === 0) {
      tl.classList.add("hidden");
      return;
    }

    historyTimelineCursor = computeCursorFromHead(allCommits, entries);

    tl.classList.remove("hidden");
    track.innerHTML = "";
    const frag = document.createDocumentFragment();
    entries.forEach((commit, idx) => {
      const isInitial = (commit.message || "").startsWith("Initial ");
      const item = document.createElement("button");
      item.type = "button";
      item.className = "history-timeline__entry"
        + (idx === historyTimelineCursor ? " history-timeline__entry--current" : "")
        + (isInitial ? " history-timeline__entry--initial" : "");
      item.dataset.hash = commit.fullHash;
      item.dataset.index = String(idx);
      item.innerHTML = `<span class="history-timeline__entry-dot"></span>`
        + `<span class="history-timeline__entry-label"></span>`;
      item.querySelector(".history-timeline__entry-label").textContent = shortenCommitMessage(commit.message);
      item.title = ""; // we use a custom tooltip
      frag.appendChild(item);
    });
    track.appendChild(frag);

    updateHistoryTimelineNavState();

    // Scroll the current entry into view
    requestAnimationFrame(() => {
      const cur = track.querySelector(".history-timeline__entry--current");
      if (cur && typeof cur.scrollIntoView === "function") {
        cur.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  } catch {
    tl.classList.add("hidden");
  }
}

function updateHistoryTimelineNavState() {
  const undoBtn = document.getElementById("history-timeline-undo");
  const redoBtn = document.getElementById("history-timeline-redo");
  const max = historyTimelineEntries.length - 1;
  const busy = historyTimelineRestoring || (typeof isStreaming !== "undefined" && isStreaming);
  if (undoBtn) undoBtn.disabled = busy || historyTimelineCursor >= max;
  if (redoBtn) redoBtn.disabled = busy || historyTimelineCursor <= 0;
}

async function restoreToTimelineIndex(idx) {
  if (historyTimelineRestoring) return;
  if (idx < 0 || idx >= historyTimelineEntries.length) return;
  if (typeof isStreaming !== "undefined" && isStreaming) return;
  const target = historyTimelineEntries[idx];
  if (!target) return;

  historyTimelineRestoring = true;
  updateHistoryTimelineNavState();
  setStatus("Restoring…");

  try {
    const payload = { hash: target.fullHash };
    if (currentTemplateId) payload.templateId = currentTemplateId;
    const res = await fetch("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) {
      await vibeAlert(data.error, "Restore failed");
      setStatus("Ready");
      return;
    }
    if (data.modules) updateModuleList(data.modules);
    refreshPreview();
    // Refresh from server — the new HEAD is a "Rollback to:" commit pointing
    // at the entry we just restored; computeCursorFromHead resolves it back.
    await refreshHistoryTimeline();
    if (historyPanelOpen) refreshHistoryPanel();
    setStatus("Ready");
  } catch (err) {
    await vibeAlert(err.message || "Restore failed", "Restore failed");
    setStatus("Ready");
  } finally {
    historyTimelineRestoring = false;
    updateHistoryTimelineNavState();
  }
}

function timelineUndo() {
  restoreToTimelineIndex(historyTimelineCursor + 1);
}

function timelineRedo() {
  restoreToTimelineIndex(historyTimelineCursor - 1);
}

// ---- Tooltip on hover ------------------------------------------------------

function showTimelineTooltip(entryEl) {
  const tooltip = document.getElementById("history-timeline-tooltip");
  const tl = document.getElementById("history-timeline");
  if (!tooltip || !tl || !entryEl) return;
  const idx = parseInt(entryEl.dataset.index || "-1", 10);
  const commit = historyTimelineEntries[idx];
  if (!commit) return;

  const modules = (commit.changedModules || []).slice(0, 5);
  const more = (commit.changedModules || []).length - modules.length;
  const modulesLine = modules.length
    ? modules.join(", ") + (more > 0 ? ` +${more} more` : "")
    : "No module changes";

  // Strip [templateId] prefix for display; keep "Rollback to:" prefix because
  // that case is filtered out earlier and won't reach here.
  let displayMsg = commit.message || "";
  const prefix = displayMsg.match(/^\[[^\]]+\]\s*/);
  if (prefix) displayMsg = displayMsg.slice(prefix[0].length);

  tooltip.innerHTML = `
    <div class="history-timeline__tooltip-title"></div>
    <div class="history-timeline__tooltip-meta"></div>
    <div class="history-timeline__tooltip-modules"></div>
  `;
  tooltip.querySelector(".history-timeline__tooltip-title").textContent = displayMsg || "Update";
  tooltip.querySelector(".history-timeline__tooltip-meta").textContent =
    `${commit.hash} · ${timeAgoShort(commit.timestamp)} ago`;
  tooltip.querySelector(".history-timeline__tooltip-modules").textContent = modulesLine;

  // Position above the entry, clamped within the timeline strip.
  tooltip.classList.remove("hidden");
  const tlRect = tl.getBoundingClientRect();
  const entryRect = entryEl.getBoundingClientRect();
  const left = Math.max(8, entryRect.left - tlRect.left);
  const tooltipW = tooltip.offsetWidth;
  const maxLeft = Math.max(8, tl.clientWidth - tooltipW - 8);
  tooltip.style.left = Math.min(left, maxLeft) + "px";
}

function hideTimelineTooltip() {
  const tooltip = document.getElementById("history-timeline-tooltip");
  if (tooltip) tooltip.classList.add("hidden");
}

// ---- Wire up DOM events ----------------------------------------------------

(function wireHistoryTimeline() {
  const track = document.getElementById("history-timeline-track");
  const undoBtn = document.getElementById("history-timeline-undo");
  const redoBtn = document.getElementById("history-timeline-redo");

  if (track) {
    track.addEventListener("click", (e) => {
      const entry = e.target.closest(".history-timeline__entry");
      if (!entry) return;
      const idx = parseInt(entry.dataset.index || "-1", 10);
      if (idx >= 0) restoreToTimelineIndex(idx);
    });

    let hoverTimer = null;
    track.addEventListener("mouseover", (e) => {
      const entry = e.target.closest(".history-timeline__entry");
      if (!entry) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => showTimelineTooltip(entry), 200);
    });
    track.addEventListener("mouseout", (e) => {
      const entry = e.target.closest(".history-timeline__entry");
      if (!entry) return;
      clearTimeout(hoverTimer);
      hideTimelineTooltip();
    });
  }

  if (undoBtn) undoBtn.addEventListener("click", timelineUndo);
  if (redoBtn) redoBtn.addEventListener("click", timelineRedo);

  // Global Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z keyboard shortcuts. Skip when the
  // user is editing text so we never hijack native undo in inputs/editors.
  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;

    const active = document.activeElement;
    if (active) {
      const tag = (active.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (active.isContentEditable) return;
    }

    if (!historyGitAvailable) return;

    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      timelineUndo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      timelineRedo();
    }
  });
})();

// ---------------------------------------------------------------------------
// Module list
// ---------------------------------------------------------------------------

function updateModuleList(moduleNames) {
  const itemsEl = document.getElementById("module-items");
  const barCountEl = document.getElementById("module-count");
  const slideoutCountEl = document.getElementById("slideout-module-count");

  if (barCountEl) barCountEl.textContent = moduleNames.length;
  if (slideoutCountEl) slideoutCountEl.textContent = moduleNames.length;
  const pageTreeCountEl = document.getElementById("page-tree-module-count");
  if (pageTreeCountEl) pageTreeCountEl.textContent = moduleNames.length;

  // Preserve which items were marked as recently changed across re-renders so
  // the dots survive the per-module `modules_updated` events that happen
  // mid-run.
  const previouslyChanged = new Set(
    Array.from(itemsEl.querySelectorAll(".module-item--changed")).map((el) => el.dataset.module),
  );
  itemsEl.innerHTML = "";

  for (const name of moduleNames) {
    const item = document.createElement("div");
    item.className = "module-item";
    if (previouslyChanged.has(name)) item.classList.add("module-item--changed");
    item.dataset.module = name;
    item.innerHTML = `
      <span class="module-item__drag">⠿</span>
      <span class="module-item__changed-dot" aria-hidden="true"></span>
      <span class="module-item__name">${escapeHtml(name)}</span>
      <span class="module-item__edit" title="Edit fields">⚙</span>
      <span class="module-item__delete" title="Delete section">&times;</span>
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

/**
 * Flush change highlights at the end of a generation run: refresh the preview
 * with the changed/new module sets, mark the sidebar items, and schedule the
 * 30-second auto-clear of the dots.
 */
function flushChangeHighlights(latestModules) {
  const changed = Array.from(changedModulesInRun);
  const before = modulesBeforeRun;
  changedModulesInRun = new Set();
  modulesBeforeRun = null;

  let newModules = [];
  if (before) {
    if (changed.length > 0) {
      // Agentic pipeline: we know exactly which modules ran. New = ran AND
      // not in the pre-run snapshot.
      newModules = changed.filter((m) => !before.has(m));
    } else if (Array.isArray(latestModules)) {
      // Single-call mode emits no per-module events. Fall back to "names that
      // appeared since the run started" — we can't know which existing
      // modules were rewritten without server-side support.
      newModules = latestModules.filter((m) => !before.has(m));
    }
  }

  refreshPreview({
    changedModules: changed.length > 0 ? changed : newModules,
    newModules,
  });

  // Sidebar dots only fire when we have explicit per-module change info; the
  // single-call fallback above only knows about new modules, which already
  // get the slide-in animation in the preview.
  if (changed.length > 0) {
    markModuleListChanged(changed);
  } else if (newModules.length > 0) {
    markModuleListChanged(newModules);
  }
}

/** Apply the change indicator dot to each named module in the sidebar. */
function markModuleListChanged(names) {
  if (!names || names.length === 0) return;
  const itemsEl = document.getElementById("module-items");
  if (!itemsEl) return;
  const set = new Set(names);
  itemsEl.querySelectorAll(".module-item").forEach((el) => {
    if (set.has(el.dataset.module)) el.classList.add("module-item--changed");
  });

  // Auto-clear after 30s per spec; next generation also clears via sendMessage.
  if (changedListClearTimer) clearTimeout(changedListClearTimer);
  changedListClearTimer = setTimeout(clearModuleListChanged, 30000);
}

/** Remove all change indicator dots from the sidebar. */
function clearModuleListChanged() {
  if (changedListClearTimer) {
    clearTimeout(changedListClearTimer);
    changedListClearTimer = null;
  }
  document.querySelectorAll(".module-item--changed").forEach((el) => {
    el.classList.remove("module-item--changed");
  });
}

// ---------------------------------------------------------------------------
// Module slideout
// ---------------------------------------------------------------------------

function openModuleSlideout() {
  const slideout = document.getElementById("module-slideout");
  slideout.classList.remove("hidden");
  document.getElementById("module-list-view").classList.remove("hidden");
  document.getElementById("module-editor-view").classList.add("hidden");
  slideout.classList.add("open");
}

function closeModuleSlideout() {
  document.getElementById("module-slideout").classList.remove("open");
}

function showEditorView(moduleName) {
  const slideout = document.getElementById("module-slideout");
  slideout.classList.remove("hidden");
  document.getElementById("module-list-view").classList.add("hidden");
  document.getElementById("module-editor-view").classList.remove("hidden");
  slideout.classList.add("open");
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
      dropdown.innerHTML = `<div class="module-library-dropdown__empty">No other sections available</div>`;
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

// Toggle module slideout from page-tree header
document.getElementById("btn-toggle-modules")?.addEventListener("click", () => {
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
        <p class="confirm-dialog__detail">Section will be removed from this page but kept in your library.</p>
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

  // Hide suggestion chips as soon as the user starts typing
  if (suggestionsVisible && inputEl.value.length > 0) {
    hideChatSuggestions();
  }
});

// Suggestion chip click — pre-fill input and focus, do not auto-send so the
// user can edit before pressing Enter.
document.getElementById("chat-suggestions")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".chat__suggestion-chip");
  if (!chip) return;
  const text = chip.dataset.suggestion || chip.textContent || "";
  inputEl.value = text;
  inputEl.focus();
  inputEl.setSelectionRange(text.length, text.length);
  // Trigger the input event so the textarea resizes; this also collapses chips
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  hideChatSuggestions();
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

// Conversation starter buttons in chat welcome
document.getElementById("conversation-starters")?.addEventListener("click", handleConversationStarterClick);

// Page Template buttons in the Library tab — send the prompt and surface the chat
document.getElementById("library-template-starters")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".starter-btn");
  if (!btn || !btn.dataset.prompt) return;
  document.getElementById("ws-tab-pages")?.click();
  sendMessage(btn.dataset.prompt);
});

// Templates icon in input area — switch to Library tab where templates live
document.getElementById("btn-starter-templates")?.addEventListener("click", () => {
  const libraryTab = document.getElementById("ws-tab-library");
  if (libraryTab) {
    libraryTab.click();
    document.getElementById("library-page-templates")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

// Version history (bottom panel)
document.getElementById("btn-history")?.addEventListener("click", toggleHistoryPanel);
document.getElementById("history-panel-close")?.addEventListener("click", () => {
  historyPanelOpen = false;
  document.getElementById("history-panel")?.classList.add("hidden");
});
document.getElementById("history-panel-collapse")?.addEventListener("click", () => {
  document.getElementById("history-panel")?.classList.toggle("collapsed");
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
