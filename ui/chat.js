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
      // Populate HubSpot account pill in statusbar
      fetchHsAccountStatus();
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
    streamingMsgEl.appendChild(statusEl);
  }
  statusEl.textContent = status;
  scrollToBottom();
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

  clearStreamStatus();

  // Remove streaming cursor
  const streamingEl = messagesEl.querySelector(".chat-msg--streaming");
  if (streamingEl) {
    streamingEl.classList.remove("chat-msg--streaming");
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

// Import from GitHub button
document.getElementById("import-btn").addEventListener("click", async () => {
  const urlInput = document.getElementById("import-url");
  const url = urlInput.value.trim();
  if (!url) return;

  setStatus("Importing project...");
  urlInput.disabled = true;
  document.getElementById("import-btn").disabled = true;

  try {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (data.error) {
      setStatus(`Import failed: ${data.error}`);
      urlInput.disabled = false;
      document.getElementById("import-btn").disabled = false;
      return;
    }

    setStatus(`Imported ${data.componentCount} components. Converting...`);

    // Send the AI conversion prompt as a chat message
    sendMessage(data.conversionPrompt);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`);
    urlInput.disabled = false;
    document.getElementById("import-btn").disabled = false;
  }
});

// Also allow Enter in the import input
document.getElementById("import-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("import-btn").click();
  }
});

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

  const frame = document.getElementById("preview-frame");
  const width = btn.dataset.width;
  frame.style.width = width;
  frame.style.maxWidth = "100%";
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
