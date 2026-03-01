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

const messagesEl = document.getElementById("chat-messages");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("chat-send");
const statusText = document.getElementById("status-text");
const statusEngine = document.getElementById("status-engine");

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connectWebSocket() {
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
    setStatus("Disconnected — reconnecting...");
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
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
      document.getElementById("theme-name").textContent = msg.themeName || "—";
      if (msg.modules && msg.modules.length > 0) {
        updateModuleList(msg.modules);
        refreshPreview();
      }
      statusEngine.textContent = msg.engine || "";
      fetchHsAccountStatus();

      // Restore chat history from server
      if (msg.messages && msg.messages.length > 0) {
        const welcome = messagesEl.querySelector(".chat__welcome");
        if (welcome) welcome.remove();
        for (const m of msg.messages) {
          if (m.role === "user") {
            appendUserMessage(m.content);
          } else if (m.role === "assistant") {
            appendRestoredAssistantMessage(m.content);
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
      clearStreamStatus();
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

function appendUserMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--user";
  div.innerHTML = `<div class="chat-msg__bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function startStreaming() {
  isStreaming = true;
  streamBuffer = "";
  sendBtn.disabled = true;
  streamStartTime = Date.now();

  // Show generating preview with spinner + fun messages
  if (typeof showGeneratingPreview === "function") {
    showGeneratingPreview();
  }

  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant chat-msg--streaming";
  div.innerHTML = `<div class="chat-msg__bubble"></div>`;
  messagesEl.appendChild(div);
  streamingMsgEl = div.querySelector(".chat-msg__bubble");
  scrollToBottom();

  // Start the running clock
  startStreamTimer();
}

function handleStreamChunk(text) {
  if (!streamingMsgEl) return;
  streamBuffer += text;

  // Render markdown-lite (code blocks, inline code, paragraphs)
  streamingMsgEl.innerHTML = renderMarkdown(streamBuffer);
  scrollToBottom();
}

function handleStreamStatus(status) {
  if (!streamingMsgEl) startStreaming();

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

    // Add duration metadata beneath the bubble
    const meta = document.createElement("div");
    meta.className = "chat-msg__meta";
    meta.textContent = durationStr;
    streamingEl.appendChild(meta);
  }

  // Final render of the full response
  if (streamingMsgEl && streamBuffer) {
    streamingMsgEl.innerHTML = renderMarkdown(streamBuffer);
  }

  streamingMsgEl = null;
  streamBuffer = "";
  setStatus("Ready");
  scrollToBottom();
}

function appendAssistantError(message) {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";
  div.innerHTML = `<div class="chat-msg__bubble" style="border-left: 3px solid var(--error);">
    <strong>Error:</strong> ${escapeHtml(message)}
  </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Markdown-lite renderer (code blocks, inline code, bold, links)
// ---------------------------------------------------------------------------

function renderMarkdown(text) {
  // Hide vibespot-modules JSON blocks (they're data, not display)
  text = text.replace(/```vibespot-modules[\s\S]*?```/g, "");

  // Code blocks: ```lang\n...\n```
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });

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
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text) {
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Restored / system messages
// ---------------------------------------------------------------------------

function appendRestoredAssistantMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";
  div.innerHTML = `<div class="chat-msg__bubble">${renderMarkdown(text)}</div>`;
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

async function refreshHistoryPanel() {
  const list = document.getElementById("history-list");
  if (!list) return;
  list.innerHTML = '<div class="history__loading">Loading...</div>';

  try {
    const res = await fetch("/api/history");
    const data = await res.json();

    if (!data.available) {
      list.innerHTML = '<div class="history__empty">Git not available</div>';
      return;
    }
    if (data.commits.length === 0) {
      list.innerHTML = '<div class="history__empty">No versions yet</div>';
      return;
    }

    list.innerHTML = "";
    for (const commit of data.commits) {
      const isInitial = commit.message.startsWith("Initial ");
      const isRollback = commit.message.startsWith("Rollback to:");

      const item = document.createElement("div");
      item.className = "history-item" + (isRollback ? " history-item--rollback" : "");
      item.innerHTML = `
        <div class="history-item__header">
          <span class="history-item__hash">${escapeHtml(commit.hash)}</span>
          <span class="history-item__date">${timeAgoShort(commit.timestamp)}</span>
        </div>
        <div class="history-item__msg">${escapeHtml(commit.message)}</div>
        ${!isInitial ? `<button class="history-item__rollback" data-hash="${escapeHtml(commit.fullHash)}">Restore</button>` : ""}
      `;
      list.appendChild(item);
    }

    list.querySelectorAll(".history-item__rollback").forEach((btn) => {
      btn.addEventListener("click", () => doRollback(btn.dataset.hash));
    });
  } catch {
    list.innerHTML = '<div class="history__empty">Error loading history</div>';
  }
}

async function doRollback(hash) {
  if (!confirm("Restore this version? Your current files will be replaced, but chat history is preserved.")) return;
  setStatus("Rolling back...");

  try {
    const res = await fetch("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    const data = await res.json();

    if (data.error) {
      alert("Rollback failed: " + data.error);
      setStatus("Ready");
      return;
    }

    if (data.modules) updateModuleList(data.modules);
    refreshPreview();
    appendSystemMessage("Restored to version " + hash.slice(0, 7));
    refreshHistoryPanel();
    setStatus("Ready");
  } catch (err) {
    alert("Rollback failed: " + err.message);
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
  const countEl = document.getElementById("module-count");

  countEl.textContent = moduleNames.length;
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

    // Click to scroll to module in preview
    item.querySelector(".module-item__name").addEventListener("click", () => {
      scrollPreviewToModule(name);
      highlightModuleItem(name);
    });

    // Click gear to open field editor
    item.querySelector(".module-item__edit").addEventListener("click", (e) => {
      e.stopPropagation();
      openFieldEditor(name);
      highlightModuleItem(name);
    });

    // Click × to delete module
    item.querySelector(".module-item__delete").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteModule(name);
    });

    itemsEl.appendChild(item);
  }

  // Set up drag-and-drop reordering
  setupDragReorder(itemsEl);
}

function highlightModuleItem(name) {
  document.querySelectorAll(".module-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.module === name);
  });
}

function confirmDeleteModule(moduleName) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-dialog__title">Delete "${escapeHtml(moduleName)}"?</div>
      <p class="confirm-dialog__warn">This cannot be undone.</p>
      <div class="confirm-dialog__actions">
        <button class="btn btn--secondary" id="confirm-cancel">Cancel</button>
        <button class="btn btn--danger" id="confirm-delete">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("confirm-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  document.getElementById("confirm-delete").addEventListener("click", async () => {
    overlay.remove();
    try {
      await fetch("/api/modules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleName }),
      });
      // Remove from list and refresh preview
      const item = document.querySelector(`.module-item[data-module="${CSS.escape(moduleName)}"]`);
      if (item) item.remove();
      const countEl = document.getElementById("module-count");
      countEl.textContent = document.querySelectorAll(".module-item").length;
      refreshPreview();
    } catch {
      // silently fail
    }
  });
}

// ---------------------------------------------------------------------------
// Drag-and-drop reordering
// ---------------------------------------------------------------------------

function setupDragReorder(container) {
  let dragItem = null;
  let dragY = 0;

  container.querySelectorAll(".module-item__drag").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      dragItem = handle.closest(".module-item");
      dragY = e.clientY;
      dragItem.style.opacity = "0.5";

      const onMove = (e) => {
        const dy = e.clientY - dragY;
        if (Math.abs(dy) > 30) {
          const items = [...container.querySelectorAll(".module-item")];
          const idx = items.indexOf(dragItem);
          if (dy > 0 && idx < items.length - 1) {
            container.insertBefore(items[idx + 1], dragItem);
          } else if (dy < 0 && idx > 0) {
            container.insertBefore(dragItem, items[idx - 1]);
          }
          dragY = e.clientY;
        }
      };

      const onUp = () => {
        if (dragItem) dragItem.style.opacity = "1";
        dragItem = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        // Send new order to server
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
// Initialize
// ---------------------------------------------------------------------------

// WebSocket connection is started by setup.js after a session is created.
// Do NOT auto-connect here.
