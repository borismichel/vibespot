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
            appendRestoredAssistantMessage(m.content, m.timestamp);
          }
        }
        scrollToBottom();
      }

      // Show/hide version history button
      const historyBtn = document.getElementById("btn-history");
      if (historyBtn) {
        historyBtn.style.display = msg.gitAvailable ? "" : "none";
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
      finishStreaming();
      appendAssistantError(msg.message);
      setStatus("Error");
      break;

    case "pong":
      break;
  }
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

function sendMessage(text) {
  if (!text.trim() || isStreaming || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Remove welcome screen
  const welcome = messagesEl.querySelector(".chat__welcome");
  if (welcome) welcome.remove();

  // Show user message
  appendUserMessage(text);

  // Start streaming indicator
  startStreaming();

  // Send via WebSocket
  ws.send(JSON.stringify({ type: "chat", message: text }));

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

function appendUserMessage(text, timestamp) {
  const time = formatMessageTime(timestamp || Date.now());
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--user";
  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--user">Y</div>
    <div class="chat-msg__content">
      <div class="chat-msg__header">
        <span class="chat-msg__sender">You</span>
        <span class="chat-msg__time">${time}</span>
      </div>
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

  // Show generating preview with spinner + fun messages
  if (typeof showGeneratingPreview === "function") {
    showGeneratingPreview();
  }

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
  if (!streamingMsgEl) startStreaming();

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
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min + "m " + (sec < 10 ? "0" : "") + sec + "s";
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

function appendRestoredAssistantMessage(text, timestamp) {
  const time = formatMessageTime(timestamp);
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";
  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      ${time ? `<div class="chat-msg__header"><span class="chat-msg__sender">vibeSpot AI</span><span class="chat-msg__time">${time}</span></div>` : ""}
      <div class="chat-msg__bubble">${renderMarkdown(text)}</div>
    </div>`;
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
  chrome.style.maxWidth = width === "100%" ? "none" : width;

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
