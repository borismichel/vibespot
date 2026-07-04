/**
 * Chat UI — WebSocket client, message rendering, streaming display.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let isStreaming = false;
// True while an agentic pipeline is actively building (Stage 3) — the window in
// which a new message barges in to cancel-and-replan (VIB-1880). False when
// parked at a checkpoint gate or running single-call mode.
let agenticRunning = false;
// True while a checkpoint gate card is parked awaiting the user's decision.
// finishStreaming() clears isStreaming at the gate, so this flag is what
// actually locks the composer (VIB-1898).
let checkpointGateActive = false;
// Softened barge-in (VIB-1876): a message sent during an active build is QUEUED
// by default and dispatched when the build finishes. The queued chip carries an
// "Interrupt now" button that triggers the old cancel-and-replan barge-in.
let queuedMessage = null; // { text, opts }
let queuedChipEl = null;
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

// VIB-1770 — the assistant bubble of the just-finished generation, so the
// trailing `generation_cost` event can append its estimated cost line to it.
let lastGenerationBubbleEl = null;

const messagesEl = document.getElementById("chat-messages");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("chat-send");
const oneShotBtn = document.getElementById("chat-send-oneshot");
// Remembered so the barge-in hint placeholder can be restored after a run.
const chatInputDefaultPlaceholder = (inputEl && inputEl.placeholder) || "";
const statusText = document.getElementById("status-text");
const statusEngine = document.getElementById("status-engine");
const statusTheme = document.getElementById("status-theme");
const statusLastSaved = document.getElementById("status-last-saved");

let lastSavedAt = 0;

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
let pageDragSourceId = null;

const PAGE_TYPE_BADGES = {
  landing_page: "LP",
  blog_post: "Blog",
  website_page: "Web",
  email: "Email",
  module_only: "Sec",
};

// Inline SVG icons keyed by page type. Stroke-only so they inherit currentColor.
const PAGE_TYPE_ICONS = {
  landing_page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/></svg>',
  website_page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="6" cy="7" r="0.6" fill="currentColor"/><circle cx="8.4" cy="7" r="0.6" fill="currentColor"/></svg>',
  blog_post: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11l3 3v13H5z"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="14" y2="15"/></svg>',
  email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3,7 12,13 21,7"/></svg>',
  module_only: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="6" width="16" height="4" rx="1"/><rect x="4" y="14" width="10" height="4" rx="1"/></svg>',
};

const PAGE_TYPE_LABEL_LONG = {
  landing_page: "Landing page",
  website_page: "Website page",
  blog_post: "Blog post",
  email: "Email",
  module_only: "Section",
};

function renderPageTabs(templates, activeTemplateId) {
  const list = document.getElementById("page-tabs-list");
  if (!list) return;

  currentTemplates = templates || [];

  list.innerHTML = currentTemplates.map((t) => {
    const isActive = t.id === activeTemplateId;
    const badge = PAGE_TYPE_BADGES[t.pageType] || "";
    const icon = PAGE_TYPE_ICONS[t.pageType] || PAGE_TYPE_ICONS.website_page;
    const typeLabel = PAGE_TYPE_LABEL_LONG[t.pageType] || t.pageType;
    const titleAttr = `${t.label} — ${typeLabel} (${t.moduleCount} modules)`;
    return `<div class="page-tabs__row${isActive ? " page-tabs__row--active" : ""}" role="treeitem" aria-selected="${isActive ? "true" : "false"}" data-template-id="${t.id}" draggable="true" title="${escapeHtml(titleAttr)}">
      <span class="page-tabs__handle" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>
      <button class="page-tabs__tab" type="button" data-template-id="${t.id}" data-action="activate">
        <span class="page-tabs__icon" aria-hidden="true">${icon}</span>
        ${badge ? `<span class="page-tabs__tab-badge">${badge}</span>` : ""}
        <span class="page-tabs__tab-label">${escapeHtml(t.label)}</span>
        <span class="page-tabs__tab-count">${t.moduleCount}</span>
      </button>
      <button class="page-tabs__menu-btn" type="button" data-template-id="${t.id}" data-action="menu" title="Page actions" aria-label="Page actions" aria-haspopup="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="6" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="18" r="1"/></svg></button>
    </div>`;
  }).join("");
}

function refreshPageTabs() {
  return fetch("/api/templates")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      currentTemplateId = data.activeTemplateId || currentTemplateId;
      renderPageTabs(data.templates || [], currentTemplateId);
    })
    .catch(() => {});
}

function handlePageTabClick(e) {
  const menuBtn = e.target.closest(".page-tabs__menu-btn");
  if (menuBtn) {
    e.preventDefault();
    e.stopPropagation();
    openPageContextMenu(menuBtn.dataset.templateId, menuBtn);
    return;
  }
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

// ---------------------------------------------------------------------------
// Page tree context menu (right-click / kebab) — Edit, Duplicate, Delete, Move
// ---------------------------------------------------------------------------

function handlePageTabContextMenu(e) {
  const row = e.target.closest(".page-tabs__row");
  if (!row) return;
  e.preventDefault();
  openPageContextMenu(row.dataset.templateId, e);
}

function openPageContextMenu(templateId, anchor) {
  closePageContextMenu();
  if (!templateId) return;
  const template = currentTemplates.find((t) => t.id === templateId);
  if (!template) return;

  const idx = currentTemplates.findIndex((t) => t.id === templateId);
  const canMoveUp = idx > 0;
  const canMoveDown = idx >= 0 && idx < currentTemplates.length - 1;

  const menu = document.createElement("div");
  menu.className = "page-tree__context-menu";
  menu.id = "page-context-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = [
    `<button type="button" role="menuitem" data-action="edit">Edit name…</button>`,
    `<button type="button" role="menuitem" data-action="duplicate">Duplicate</button>`,
    `<div class="page-tree__context-sep" role="separator"></div>`,
    `<button type="button" role="menuitem" data-action="move-up"${canMoveUp ? "" : " disabled"}>Move up</button>`,
    `<button type="button" role="menuitem" data-action="move-down"${canMoveDown ? "" : " disabled"}>Move down</button>`,
    `<div class="page-tree__context-sep" role="separator"></div>`,
    `<button type="button" role="menuitem" data-action="delete" class="page-tree__context-menu-danger">Delete…</button>`,
  ].join("");
  document.body.appendChild(menu);

  // Position the menu. Anchor can be a MouseEvent or an HTMLElement.
  let x = 0;
  let y = 0;
  if (anchor instanceof Event) {
    x = anchor.clientX;
    y = anchor.clientY;
  } else if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    x = r.right;
    y = r.bottom;
  }
  // Constrain to viewport.
  const menuRect = menu.getBoundingClientRect();
  if (x + menuRect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - menuRect.width - 8);
  if (y + menuRect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - menuRect.height - 8);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    closePageContextMenu();
    runPageAction(templateId, action);
  });

  // Dismiss on outside click / scroll / Escape.
  setTimeout(() => {
    document.addEventListener("click", closePageContextMenu, { once: true });
    document.addEventListener("contextmenu", closePageContextMenu, { once: true });
    window.addEventListener("scroll", closePageContextMenu, { capture: true, once: true });
  }, 0);
}

function closePageContextMenu() {
  const menu = document.getElementById("page-context-menu");
  if (menu) menu.remove();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePageContextMenu();
});

function runPageAction(templateId, action) {
  if (isStreaming) return;
  switch (action) {
    case "edit": return renamePageAction(templateId);
    case "duplicate": return duplicatePageAction(templateId);
    case "delete": return deletePageAction(templateId);
    case "move-up": return movePageAction(templateId, -1);
    case "move-down": return movePageAction(templateId, 1);
  }
}

function renamePageAction(templateId) {
  const tpl = currentTemplates.find((t) => t.id === templateId);
  if (!tpl) return;
  // Inline rename: turn the label cell into a contenteditable.
  const row = document.querySelector(`.page-tabs__row[data-template-id="${CSS.escape(templateId)}"]`);
  const labelEl = row && row.querySelector(".page-tabs__tab-label");
  if (!labelEl) {
    // Fallback: native prompt.
    const next = prompt("Rename page", tpl.label);
    if (!next || next.trim() === tpl.label) return;
    sendRename(templateId, next.trim());
    return;
  }
  const oldLabel = tpl.label;
  labelEl.contentEditable = "true";
  labelEl.classList.add("page-tabs__tab-label--editing");
  labelEl.focus();
  const range = document.createRange();
  range.selectNodeContents(labelEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    labelEl.contentEditable = "false";
    labelEl.classList.remove("page-tabs__tab-label--editing");
    const next = labelEl.textContent.trim();
    if (!next || next === oldLabel) {
      labelEl.textContent = oldLabel;
      return;
    }
    sendRename(templateId, next);
  }
  labelEl.addEventListener("blur", commit, { once: true });
  labelEl.addEventListener("keydown", function handler(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      labelEl.removeEventListener("keydown", handler);
      commit();
    } else if (e.key === "Escape") {
      labelEl.removeEventListener("keydown", handler);
      committed = true;
      labelEl.textContent = oldLabel;
      labelEl.contentEditable = "false";
      labelEl.classList.remove("page-tabs__tab-label--editing");
    }
  });
}

function sendRename(templateId, newLabel) {
  fetch("/api/templates/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, newLabel }),
  }).then((r) => r.json()).then((data) => {
    if (data && data.ok) refreshPageTabs();
  }).catch(() => {});
}

function duplicatePageAction(templateId) {
  const tpl = currentTemplates.find((t) => t.id === templateId);
  if (!tpl) return;
  const label = prompt("Name for the duplicated page:", `${tpl.label} (Copy)`);
  if (!label || !label.trim()) return;
  fetch("/api/templates/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, label: label.trim() }),
  }).then((r) => r.json()).then((data) => {
    if (data && data.ok && data.template && data.template.id) {
      // Activate the clone so the user lands on it (mirrors createPage flow).
      return fetch("/api/templates/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: data.template.id }),
      }).then(() => { refreshPageTabs(); connectWebSocket(); });
    }
  }).catch(() => {});
}

function deletePageAction(templateId) {
  const tpl = currentTemplates.find((t) => t.id === templateId);
  if (!tpl) return;
  const msg = `Delete "${tpl.label}"? This removes the page and its template file. Sections (modules) are kept in the library.`;
  if (!confirm(msg)) return;
  fetch("/api/templates", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, deleteModules: false }),
  }).then((r) => r.json()).then((data) => {
    if (data && data.ok) {
      refreshPageTabs();
      // If we deleted the active page, the server picks a new active — reconnect.
      if (templateId === currentTemplateId) connectWebSocket();
    }
  }).catch(() => {});
}

function movePageAction(templateId, delta) {
  const ids = currentTemplates.map((t) => t.id);
  const idx = ids.indexOf(templateId);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= ids.length) return;
  ids.splice(idx, 1);
  ids.splice(target, 0, templateId);
  sendReorder(ids);
}

function sendReorder(templateIds) {
  // Optimistic re-render so the move feels instant.
  const map = new Map(currentTemplates.map((t) => [t.id, t]));
  const next = templateIds.map((id) => map.get(id)).filter(Boolean);
  if (next.length === currentTemplates.length) {
    renderPageTabs(next, currentTemplateId);
  }
  fetch("/api/templates/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateIds }),
  }).then((r) => r.json()).then((data) => {
    if (!data || !data.ok) refreshPageTabs();
  }).catch(() => refreshPageTabs());
}

// ---------------------------------------------------------------------------
// Drag and drop reordering (HTML5)
// ---------------------------------------------------------------------------

function handlePageTabDragStart(e) {
  const row = e.target.closest(".page-tabs__row");
  if (!row) return;
  pageDragSourceId = row.dataset.templateId || null;
  row.classList.add("page-tabs__row--dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Some browsers need data set to start the drag.
    try { e.dataTransfer.setData("text/plain", pageDragSourceId || ""); } catch (_) {}
  }
}

function handlePageTabDragEnd(e) {
  const row = e.target.closest(".page-tabs__row");
  if (row) row.classList.remove("page-tabs__row--dragging");
  pageDragSourceId = null;
  document.querySelectorAll(".page-tabs__row--drop-before, .page-tabs__row--drop-after")
    .forEach((el) => el.classList.remove("page-tabs__row--drop-before", "page-tabs__row--drop-after"));
}

function handlePageTabDragOver(e) {
  if (!pageDragSourceId) return;
  const row = e.target.closest(".page-tabs__row");
  if (!row || row.dataset.templateId === pageDragSourceId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const rect = row.getBoundingClientRect();
  const before = e.clientY - rect.top < rect.height / 2;
  document.querySelectorAll(".page-tabs__row--drop-before, .page-tabs__row--drop-after")
    .forEach((el) => el.classList.remove("page-tabs__row--drop-before", "page-tabs__row--drop-after"));
  row.classList.add(before ? "page-tabs__row--drop-before" : "page-tabs__row--drop-after");
}

function handlePageTabDrop(e) {
  if (!pageDragSourceId) return;
  const row = e.target.closest(".page-tabs__row");
  if (!row) return;
  const targetId = row.dataset.templateId;
  if (!targetId || targetId === pageDragSourceId) return;
  e.preventDefault();
  const ids = currentTemplates.map((t) => t.id);
  const from = ids.indexOf(pageDragSourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  const rect = row.getBoundingClientRect();
  const before = e.clientY - rect.top < rect.height / 2;
  ids.splice(from, 1);
  // After removing the source, the target index may have shifted by one.
  const adjustedTo = to > from ? to - 1 : to;
  const insertAt = before ? adjustedTo : adjustedTo + 1;
  ids.splice(insertAt, 0, pageDragSourceId);
  sendReorder(ids);
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
    if (!res.ok) return null;
    return res.json();
  }).then((data) => {
    const newId = data && data.template && data.template.id;
    if (!newId) return;
    // Server's addTemplate already marks the new template as active, but we
    // call activate to sync the flat-field cache and let the WS reconnect
    // re-broadcast the full session (modules + templates + active id).
    return fetch("/api/templates/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: newId }),
    }).then((res) => {
      if (!res || !res.ok) return;
      // Re-render the tree immediately from the canonical list so the new
      // page shows up even before the WS init message arrives.
      refreshPageTabs();
      connectWebSocket();
    });
  });
}

(function initPageTree() {
  const list = document.getElementById("page-tabs-list");
  const addBtn = document.getElementById("btn-add-page");
  const createBtn = document.getElementById("page-tree-create");
  const nameInput = document.getElementById("page-tree-name");
  if (list) {
    list.addEventListener("click", handlePageTabClick);
    list.addEventListener("contextmenu", handlePageTabContextMenu);
    list.addEventListener("dragstart", handlePageTabDragStart);
    list.addEventListener("dragend", handlePageTabDragEnd);
    list.addEventListener("dragover", handlePageTabDragOver);
    list.addEventListener("drop", handlePageTabDrop);
  }
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
      setStatusTheme(msg.themeName);
      lastSavedAt = typeof msg.updatedAt === "number" ? msg.updatedAt : 0;
      renderLastSaved();
      if (msg.engine) statusEngine.textContent = msg.engine;

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
      if (typeof refreshPortalIndicator === "function") refreshPortalIndicator();

      // Populate chat header
      const chatHeaderTitle = document.getElementById("chat-header-title");
      const chatHeaderContext = document.getElementById("chat-header-context");
      if (chatHeaderTitle) chatHeaderTitle.textContent = msg.themeName || "Chat";
      if (chatHeaderContext) chatHeaderContext.textContent = msg.engine || "";

      // Hydrate the per-project generation cost chip (VIB-1770)
      updateProjectCostChip(msg.costTotal);

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

      // Rehydrate a parked checkpoint after a refresh / device sleep (VIB-1876):
      // the server kept the gate, so re-render the card and let the user resume
      // from where they were. Plan-mode parks are rehydrated by planController.
      if (msg.pendingCheckpoint && msg.pendingCheckpoint.preview && msg.pendingCheckpoint.kind !== "plan") {
        handleCheckpointRequested({ preview: msg.pendingCheckpoint.preview });
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
      // Refresh the Library tab's module list so it stays in sync
      if (typeof refreshDashboard === "function") refreshDashboard();
      flushQueuedMessage();
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
      markSaved(msg.updatedAt);
      break;

    case "version_created":
      if (historyPanelOpen) refreshHistoryPanel();
      // New generation: reset timeline cursor to head and refresh.
      historyTimelineCursor = 0;
      refreshHistoryTimeline();
      markSaved(msg.updatedAt);
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
      // The run this message was queued behind is over — dispatch it rather
      // than stranding the chip forever (VIB-1898).
      flushQueuedMessage();
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
      enableBargeIn();
      handleModuleProgress(msg);
      break;
    case "generation_superseded":
      // The server confirmed our barge-in cancelled the prior run; the fresh
      // run's events follow. Nothing to do — supersedeCurrentRun already reset.
      setStatus("Redirecting…");
      break;
    case "pipeline_complete":
      handlePipelineComplete(msg);
      break;
    case "pipeline_partial":
      handlePipelinePartial(msg);
      break;
    case "checkpoint_requested":
      handleCheckpointRequested(msg);
      break;
    case "checkpoint_cancelled":
      handleCheckpointCancelled();
      break;
    case "generation_cost":
      handleGenerationCost(msg);
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
  // The expensive build stage is the barge-in window (VIB-1880).
  if (msg.step === "developing") enableBargeIn();
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

  // Render code snippet preview when a module finishes generating, and update
  // the global "Valid HubL" indicator based on a quick syntax check.
  if (msg.status === "complete" && msg.moduleFiles) {
    appendModuleCardSnippet(card, msg.module, msg.moduleFiles);
    if (typeof window.reportHublCheck === "function") {
      const issues = quickCheckHubl(msg.moduleFiles);
      window.reportHublCheck(msg.module, issues);
    }
  } else if (msg.status === "failed" && typeof window.reportHublCheck === "function") {
    window.reportHublCheck(msg.module, [{ kind: "generation_failed", message: "Module generation failed" }]);
  }

  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Code snippet preview inside a pipeline module card
// ---------------------------------------------------------------------------

const HUBL_PREVIEW_MAX_LINES = 12;
const HUBL_PREVIEW_MAX_CHARS = 800;

function appendModuleCardSnippet(card, moduleName, files) {
  if (card.querySelector(".pipeline-module-card__snippet")) return;
  const snippet = buildHublSnippet(files.moduleHtml || "");
  if (!snippet) return;

  const wrap = document.createElement("div");
  wrap.className = "pipeline-module-card__snippet";

  const header = document.createElement("div");
  header.className = "pipeline-module-card__snippet-head";
  header.innerHTML = `
    <span class="pipeline-module-card__snippet-label">module.html</span>
    <button class="pipeline-module-card__snippet-toggle" type="button" aria-expanded="false">
      <svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      <span class="pipeline-module-card__snippet-toggle-label">Show code</span>
    </button>`;

  const codeWrap = document.createElement("div");
  codeWrap.className = "pipeline-module-card__snippet-code hidden";
  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.className = "language-hubl";
  codeEl.textContent = snippet.text;
  pre.appendChild(codeEl);
  codeWrap.appendChild(pre);

  if (snippet.truncated) {
    const more = document.createElement("button");
    more.className = "pipeline-module-card__snippet-open";
    more.type = "button";
    more.textContent = "Open in code view →";
    more.addEventListener("click", () => openCodeViewForModule(moduleName));
    codeWrap.appendChild(more);
  }

  header.querySelector("button").addEventListener("click", () => {
    const expanded = !codeWrap.classList.contains("hidden");
    codeWrap.classList.toggle("hidden", expanded);
    const toggle = header.querySelector(".pipeline-module-card__snippet-toggle");
    toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    const lbl = toggle.querySelector(".pipeline-module-card__snippet-toggle-label");
    if (lbl) lbl.textContent = expanded ? "Show code" : "Hide code";
  });

  wrap.appendChild(header);
  wrap.appendChild(codeWrap);
  card.appendChild(wrap);
}

function buildHublSnippet(html) {
  if (!html) return null;
  const trimmed = html.replace(/^\n+/, "").replace(/\n+$/, "");
  const lines = trimmed.split("\n");
  let out = lines.slice(0, HUBL_PREVIEW_MAX_LINES).join("\n");
  let truncated = lines.length > HUBL_PREVIEW_MAX_LINES;
  if (out.length > HUBL_PREVIEW_MAX_CHARS) {
    out = out.slice(0, HUBL_PREVIEW_MAX_CHARS);
    truncated = true;
  }
  return { text: out, truncated };
}

function openCodeViewForModule(moduleName) {
  const codeBtn = document.querySelector('.view-toggle__btn[data-view="code"]');
  if (codeBtn) codeBtn.click();
  // Best-effort selection of the module's html file if the file list is ready.
  setTimeout(() => {
    const list = document.getElementById("code-file-list");
    if (!list) return;
    const target = Array.from(list.querySelectorAll("[data-file-path]")).find((el) => {
      const p = el.getAttribute("data-file-path") || "";
      return p.includes(`/${moduleName}.module/module.html`) || p.endsWith(`${moduleName}.module/module.html`);
    });
    if (target) target.click();
  }, 80);
}

// Lightweight HubL validity check — flags the same balance issues the
// server-side validator would auto-fix, plus reserved field/ deprecated type
// markers that the server already strips. The badge is a hint, not a gate.
function quickCheckHubl(files) {
  const issues = [];
  const html = files && typeof files.moduleHtml === "string" ? files.moduleHtml : "";
  if (!html) return issues;

  const blockOpeners = ["if", "for", "block", "with", "macro", "filter", "raw", "scope_css"];
  const stack = [];
  const tagRe = /\{%-?\s*(end)?(\w+)/g;
  let match;
  while ((match = tagRe.exec(html))) {
    const isEnd = !!match[1];
    const name = match[2];
    if (isEnd) {
      if (!stack.length || stack[stack.length - 1] !== name) {
        issues.push({ kind: "unbalanced_close", tag: name, message: `Stray {% end${name} %}` });
      } else {
        stack.pop();
      }
    } else if (blockOpeners.includes(name)) {
      stack.push(name);
    }
  }
  for (const open of stack) {
    issues.push({ kind: "unbalanced_open", tag: open, message: `Missing {% end${open} %}` });
  }
  return issues;
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

  // Remember this bubble so the trailing `generation_cost` event (sent right
  // after completion) can append its cost line to the same message (VIB-1770).
  lastGenerationBubbleEl = bubble;

  resetPipelineState();
  flushQueuedMessage();
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

  lastGenerationBubbleEl = bubble;

  resetPipelineState();
  flushQueuedMessage();
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
// Generation cost (VIB-1770) — per-page estimate + per-project running total
// ---------------------------------------------------------------------------

// Format an estimated USD amount. Sub-dollar costs show 4 decimals so a
// fraction of a cent is still legible; larger amounts round to cents.
function formatUsd(usd) {
  const n = Number(usd) || 0;
  if (n > 0 && n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

function formatTokenCount(tokens) {
  const n = Number(tokens) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// Build the per-page cost summary text from a PageCost object.
// `costComplete === false` means some model wasn't in the price table, so the
// dollar figure is a lower bound — prefix "≥" and explain it via the title.
function buildCostText(cost) {
  if (!cost || !cost.calls) return null;
  const tokens = formatTokenCount(cost.totalTokens) + " tokens";
  if (cost.costUsd > 0 || cost.costComplete) {
    const prefix = cost.costComplete ? "" : "≥ ";
    return "Est. " + prefix + formatUsd(cost.costUsd) + " · " + tokens;
  }
  // No priced calls at all — show tokens only.
  return tokens;
}

// Append (or replace) the cost line on a finished generation's bubble.
function renderCostLineOnBubble(bubble, cost) {
  if (!bubble) return;
  const text = buildCostText(cost);
  if (!text) return;
  let line = bubble.querySelector(".pipeline-cost");
  if (!line) {
    line = document.createElement("div");
    line.className = "pipeline-cost";
    bubble.appendChild(line);
  }
  line.textContent = text;
  if (cost.costComplete === false) {
    line.title = "Some model calls had no price data — this is a lower-bound estimate.";
  } else {
    line.title = "Estimated cost of this generation. Local estimate from public model prices; not a bill.";
  }
}

// Live `generation_cost` event — arrives right after pipeline completion.
function handleGenerationCost(msg) {
  if (msg.cost) renderCostLineOnBubble(lastGenerationBubbleEl, msg.cost);
  lastGenerationBubbleEl = null;
  updateProjectCostChip(msg.projectTotal);
}

// Update the persistent per-project cost chip in the chat header. Hidden when
// there's no cost yet (new project / CLI engine).
function updateProjectCostChip(total) {
  const chip = document.getElementById("chat-cost-total");
  if (!chip) return;
  if (!total || !total.generations) {
    chip.classList.add("hidden");
    chip.textContent = "";
    return;
  }
  const prefix = total.costComplete === false ? "≥ " : "";
  chip.textContent = "Σ " + prefix + formatUsd(total.costUsd);
  chip.title =
    "Estimated total for this project: " +
    formatUsd(total.costUsd) +
    " over " +
    total.generations +
    " generation" + (total.generations === 1 ? "" : "s") +
    " · " + formatTokenCount(total.totalTokens) + " tokens" +
    (total.costComplete === false ? " (lower bound)" : "");
  chip.classList.remove("hidden");
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

async function sendMessage(text, opts = {}) {
  const hasFiles = pendingFiles.length > 0;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!text.trim() && !hasFiles) return;
  // A parked checkpoint gate must be resolved through its card. Only the send
  // buttons were locked before — Enter still reached here (the streaming flags
  // are reset at the gate) and started a second run mid-park (VIB-1898).
  if (checkpointGateActive) return;
  // Block sends while busy — EXCEPT during an active agentic build. There, a new
  // message is QUEUED by default and runs when the build finishes (VIB-1876);
  // an explicit Interrupt (opts.interrupt) triggers the cancel-and-replan
  // barge-in (VIB-1880). Single-call streaming and checkpoint gates stay locked.
  if (isStreaming && !agenticRunning) return;
  const buildActive = isStreaming && agenticRunning;
  if (buildActive && !opts.interrupt) {
    queueMessage(text, opts);
    return;
  }
  if (buildActive && opts.interrupt) supersedeCurrentRun();

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
  if (typeof window.resetHublCheck === "function") window.resetHublCheck();

  // Start streaming indicator
  startStreaming();

  // Send via WebSocket with file IDs
  const payload = { type: "chat", message: text || "(files attached)" };
  if (uploadedFiles.length > 0) {
    payload.fileIds = uploadedFiles.map((f) => f.id);
  }
  // One-shot: skip the design checkpoint and build the whole page (VIB-1877).
  if (opts.oneShot) payload.oneShot = true;
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
  if (oneShotBtn) oneShotBtn.disabled = true;
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

// Open the barge-in window: the build is running, so re-enable the composer and
// let the user redirect the run mid-flight (VIB-1880).
function enableBargeIn() {
  if (agenticRunning) return;
  agenticRunning = true;
  sendBtn.disabled = false;
  if (oneShotBtn) oneShotBtn.disabled = false;
  if (inputEl) inputEl.placeholder = "Building… your message will queue (or Interrupt to redirect now)";
}

// --- Softened barge-in: queue-by-default with an Interrupt button (VIB-1876) ---

// Queue a message sent mid-build instead of cancelling the run. Latest wins.
function queueMessage(text, opts) {
  if (!text.trim() && pendingFiles.length === 0) return;
  queuedMessage = { text, opts: { ...opts } };
  if (inputEl) {
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input"));
  }
  renderQueuedChip();
  setStatus("Message queued");
}

function clearQueuedMessage() {
  queuedMessage = null;
  if (queuedChipEl) {
    queuedChipEl.remove();
    queuedChipEl = null;
  }
}

// Trigger the real barge-in (cancel-and-replan) with the queued message.
function interruptWithQueued() {
  if (!queuedMessage) return;
  const { text, opts } = queuedMessage;
  clearQueuedMessage();
  sendMessage(text, { ...opts, interrupt: true });
}

// Dispatch the queued message once the current build has finished.
function flushQueuedMessage() {
  if (!queuedMessage) return;
  // A parked gate blocks sendMessage — keep the message queued; the gate's
  // resolution path flushes again (VIB-1898).
  if (checkpointGateActive) return;
  const { text, opts } = queuedMessage;
  clearQueuedMessage();
  // Defer so the just-finished run's UI settles before the next one starts.
  setTimeout(() => sendMessage(text, opts), 0);
}

function renderQueuedChip() {
  if (!queuedMessage) return clearQueuedMessage();
  const area = inputEl && inputEl.closest(".chat__input-area");
  if (!area) return;
  if (!queuedChipEl) {
    queuedChipEl = document.createElement("div");
    queuedChipEl.className = "queued-msg";
    queuedChipEl.style.cssText =
      "display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:8px 10px;border:1px solid var(--border,#e2e2e2);border-radius:8px;background:var(--surface-2,#faf7f5);font-size:13px;";
    area.insertBefore(queuedChipEl, area.firstChild);
  }
  const t = queuedMessage.text || "(files attached)";
  const preview = t.length > 90 ? t.slice(0, 90) + "…" : t;
  queuedChipEl.innerHTML =
    '<span aria-hidden="true">⏳</span>' +
    '<span style="opacity:.7;white-space:nowrap;">Queued — runs next:</span>' +
    '<span class="queued-msg__text" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>' +
    '<button type="button" class="queued-msg__interrupt" style="flex:none;cursor:pointer;border:1px solid var(--border,#e2e2e2);background:var(--surface,#fff);border-radius:6px;padding:3px 8px;font-size:12px;">Interrupt now</button>' +
    '<button type="button" class="queued-msg__cancel" aria-label="Cancel queued message" style="flex:none;cursor:pointer;border:1px solid var(--border,#e2e2e2);background:var(--surface,#fff);border-radius:6px;padding:3px 8px;font-size:12px;">✕ Cancel</button>';
  queuedChipEl.querySelector(".queued-msg__text").textContent = preview;
  queuedChipEl.querySelector(".queued-msg__interrupt").onclick = interruptWithQueued;
  queuedChipEl.querySelector(".queued-msg__cancel").onclick = clearQueuedMessage;
}

// Tear down the superseded run's transient UI so the replacement run renders
// fresh (called when a barge-in send cancels the active build).
function supersedeCurrentRun() {
  stopStreamTimer();
  clearStreamStatus();
  const streamingEl = messagesEl.querySelector(".chat-msg--streaming");
  if (streamingEl) {
    streamingEl.classList.remove("chat-msg--streaming");
    const bubble = streamingEl.querySelector(".chat-msg__bubble");
    if (bubble && !bubble.textContent.trim()) {
      bubble.innerHTML = '<em class="message__placeholder">Superseded by your next message.</em>';
    }
  }
  removeCheckpointCard();
  checkpointGateActive = false;
  isStreaming = false;
  agenticRunning = false;
  streamingMsgEl = null;
  streamBuffer = "";
  resetPipelineState();
}

function finishStreaming() {
  if (!isStreaming) return;
  isStreaming = false;
  agenticRunning = false;
  if (inputEl) inputEl.placeholder = chatInputDefaultPlaceholder;
  sendBtn.disabled = false;
  if (oneShotBtn) oneShotBtn.disabled = false;
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

    // Agentic seams (a checkpoint gate, or a resume that re-parks / just builds
    // modules) leave a streaming bubble that never received any text or progress
    // stepper. Don't finalize it into an empty bubble with a lone duration —
    // drop it (VIB-1876 follow-up). A bubble carrying the pipeline stepper or
    // any rendered content has child nodes, so it's kept.
    const bubbleEl = streamingEl.querySelector(".chat-msg__bubble");
    const hasContent =
      !!bubbleEl && (bubbleEl.children.length > 0 || bubbleEl.textContent.trim().length > 0);
    const willRenderText = !!streamBuffer && streamBuffer.trim().length > 0;
    if (!hasContent && !willRenderText) {
      streamingEl.remove();
      streamingMsgEl = null;
      streamBuffer = "";
      setStatus("Ready");
      scrollToBottom();
      return;
    }

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

// escapeHtml comes from the shared ui/escape-html.js (VIB-1902).

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

function setStatusTheme(name) {
  if (!statusTheme) return;
  const value = (name || "").trim();
  statusTheme.textContent = value && value !== "—" ? value : "";
}

function formatRelativeSaved(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

function renderLastSaved() {
  if (!statusLastSaved) return;
  if (!lastSavedAt) {
    statusLastSaved.textContent = "";
    statusLastSaved.title = "";
    return;
  }
  statusLastSaved.textContent = formatRelativeSaved(lastSavedAt);
  try {
    statusLastSaved.title = new Date(lastSavedAt).toLocaleString();
  } catch { /* ignore */ }
}

function markSaved(ts) {
  lastSavedAt = typeof ts === "number" && ts > 0 ? ts : Date.now();
  renderLastSaved();
}

setInterval(renderLastSaved, 30000);

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

    // Per-page cost line, if this generation persisted one (VIB-1770)
    const costText = buildCostText(pipeline.cost);
    const costHtml = costText
      ? `<div class="pipeline-cost">${escapeHtml(costText)}</div>`
      : "";

    div.innerHTML = `
      <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
      <div class="chat-msg__content">
        ${time ? `<div class="chat-msg__header"><span class="chat-msg__sender">vibeSpot AI</span><span class="chat-msg__time">${time}</span></div>` : ""}
        <div class="chat-msg__bubble">
          <div class="pipeline-stepper">${stepperParts.join("")}</div>
          ${decisionHtml}
          ${modulesHtml}
          <div class="${statsClass}">${statsText}</div>
          ${costHtml}
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
// Checkpoint gate card (VIB-1877) — the design preview the user approves /
// steers / skips / cancels before the expensive module build.
// ---------------------------------------------------------------------------

let checkpointCardEl = null;
let currentCheckpointKind = null;
let currentCheckpointData = null;

function setSendDisabled(disabled) {
  sendBtn.disabled = disabled;
  if (oneShotBtn) oneShotBtn.disabled = disabled;
}

function removeCheckpointCard() {
  if (checkpointCardEl && checkpointCardEl.parentNode) {
    checkpointCardEl.parentNode.removeChild(checkpointCardEl);
  }
  checkpointCardEl = null;
}

// One-line record of what the user decided at a checkpoint (VIB-1876). Boris:
// keep the decision in the transcript rather than dropping the turn entirely.
function summarizeDecision(kind, action, note, extra) {
  const label =
    kind === "brand_intake" ? "Brand" : kind === "structure" ? "Structure" : kind === "plan" ? "Plan" : "Design";
  if (action === "cancel") return `${label}: cancelled — nothing was built.`;
  if (action === "steer") return `${label}: steered${note ? " — " + note : ""}.`;
  if (kind === "brand_intake") {
    if (action !== "approve") return "Brand: surprise me — generating a design system.";
    const ch =
      extra && extra.brandIntake
        ? Object.keys(extra.brandIntake).filter((k) => extra.brandIntake[k])
        : [];
    return `Brand: bringing your brand${ch.length ? " (" + ch.join(", ") + ")" : ""}.`;
  }
  if (action === "skip") return `${label}: skipped remaining checkpoints — building now.`;
  return `${label}: approved.`;
}

// The substantive content/facts behind a decision (VIB-1876): the palette/type
// approved, the module outline kept, or the brand inputs provided — so the
// transcript records *what*, not just the verb. Returns "" when there's nothing.
function decisionFacts(kind, action, note, extra, data) {
  if (action === "cancel") return "";
  if (action === "steer") return note ? "Note: " + note : "";
  const parts = [];
  const clip = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 80);
  if (kind === "design" || kind === "plan") {
    const pal = Array.isArray(data && data.palette)
      ? data.palette.map((p) => p && p.value).filter(Boolean).slice(0, 5)
      : [];
    if (pal.length) parts.push("Palette: " + pal.join(", "));
    const typo = (data && data.typography) || {};
    if (typo.heading || typo.body) parts.push("Type: " + [typo.heading, typo.body].filter(Boolean).join(" / "));
  } else if (kind === "structure") {
    const rows =
      extra && Array.isArray(extra.outline) && extra.outline.length
        ? extra.outline
        : data && Array.isArray(data.modules)
          ? data.modules
          : [];
    const names = rows.map((r) => r && (r.name || r.label)).filter(Boolean);
    if (names.length) parts.push(`Sections (${names.length}): ` + names.join(", "));
  } else if (kind === "brand_intake") {
    const bi = (extra && extra.brandIntake) || {};
    if (bi.colors) parts.push("Colors: " + clip(bi.colors));
    if (bi.siteUrl) parts.push("Site: " + clip(bi.siteUrl));
    if (bi.themePath) parts.push("Theme: " + clip(bi.themePath));
    if (bi.code) parts.push("Pasted code");
    if (bi.voice) parts.push("Voice: " + clip(bi.voice));
  }
  return parts.join(" · ");
}

// Convert the live checkpoint card into a static decision record so the turn
// keeps meaning in the transcript instead of leaving an empty bubble (VIB-1876).
// Rebuilds a standard assistant bubble (the card renderers use bespoke markup).
function finalizeCheckpointCard(action, note, extra) {
  if (!checkpointCardEl) return;
  const kind = currentCheckpointKind || "design";
  const text = summarizeDecision(kind, action, note, extra);
  const facts = decisionFacts(kind, action, note, extra, currentCheckpointData);
  const glyph = action === "cancel" ? "✕" : "✓";
  const time = formatMessageTime(Date.now());
  checkpointCardEl.className = "chat-msg chat-msg--assistant chat-msg--checkpoint-resolved";
  checkpointCardEl.innerHTML =
    '<div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>' +
    '<div class="chat-msg__content">' +
    '<div class="chat-msg__header"><span class="chat-msg__sender">vibeSpot AI</span>' +
    '<span class="chat-msg__time">' + time + "</span></div>" +
    '<div class="chat-msg__bubble">' +
    '<div class="checkpoint-decision" style="opacity:.85;"></div>' +
    '<div class="checkpoint-decision__facts" style="opacity:.6;font-size:12px;margin-top:2px;"></div>' +
    "</div></div>";
  checkpointCardEl.querySelector(".checkpoint-decision").textContent = glyph + " " + text;
  const factsEl = checkpointCardEl.querySelector(".checkpoint-decision__facts");
  if (facts) factsEl.textContent = facts;
  else factsEl.remove();
  checkpointCardEl = null;
}

// When a stepper card is left behind (the run parks at a gate), mark the stages
// it actually reached as done so the older card reads "complete up to here"
// rather than frozen mid-stage (VIB-1876).
function finalizeStepperProgress() {
  if (!pipelineStepperEl) return;
  pipelineStepperEl.querySelectorAll(".pipeline-stage--active").forEach((el) => {
    const step = el.getAttribute("data-stage");
    if (step) setStageStatus(step, "done");
  });
}

function handleCheckpointRequested(msg) {
  // Settle the in-flight progress bubble; the gate now waits on the user.
  clearStreamStatus();
  finalizeStepperProgress();
  finishStreaming();
  removeCheckpointCard();

  const preview = msg.preview || {};
  const data = preview.data || {};
  currentCheckpointKind = preview.kind || "design";
  currentCheckpointData = data;
  checkpointCardEl = renderCheckpointCard(preview, data, msg.estCostNext);
  messagesEl.appendChild(checkpointCardEl);
  scrollToBottom();

  // Hold the composer until the gate is resolved — buttons AND the Enter path
  // through sendMessage (VIB-1898).
  checkpointGateActive = true;
  setSendDisabled(true);
  setStatus("Awaiting your call");
}

function handleCheckpointCancelled() {
  removeCheckpointCard();
  checkpointGateActive = false;
  setSendDisabled(false);
  appendSystemMessage("Cancelled — nothing was built.");
  flushQueuedMessage();
}

function resolveCheckpoint(action, note, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  checkpointGateActive = false;
  // Leave the decision in the transcript (card → one-line record), not an empty
  // bubble (VIB-1876).
  finalizeCheckpointCard(action, note, extra);
  if (action === "cancel") {
    setSendDisabled(false);
  } else {
    // Work resumes. Don't pre-create an empty bubble — clear the prior turn's
    // pipeline refs so the resume's first progress event builds its OWN stepper
    // bubble (ensurePipelineBubble returns early while pipelineBubbleEl is set).
    isStreaming = true;
    setSendDisabled(true);
    pipelineBubbleEl = null;
    pipelineStepperEl = null;
    pipelineDetailEl = null;
    pipelineModulesEl = null;
    pipelineEstimateEl = null;
    streamingMsgEl = null;
    streamStartTime = Date.now();
    setStatus("Generating...");
  }
  ws.send(JSON.stringify({
    type: "checkpoint_resolve",
    action,
    note: note || undefined,
    // Structure checkpoint (VIB-1879) outline; brand-intake channels (VIB-1878).
    outline: extra && extra.outline ? extra.outline : undefined,
    brandIntake: extra && extra.brandIntake ? extra.brandIntake : undefined,
  }));
}

function renderCheckpointCard(preview, data, estCostNext) {
  // Brand-intake gate (VIB-1878) — the front-of-flow ask-back; different card.
  if (preview && preview.kind === "brand_intake") {
    return renderBrandIntakeCard(preview, data);
  }
  // Structure checkpoint (VIB-1879) renders an editable module outline instead
  // of the design palette/hero.
  if (preview && preview.kind === "structure") {
    return renderStructureCheckpointCard(preview, data, estCostNext);
  }

  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";

  const palette = Array.isArray(data.palette) ? data.palette : [];
  const swatches = palette.map((p) =>
    `<div class="checkpoint__swatch" title="${escapeHtml(p.label)}: ${escapeHtml(p.value)}">
       <span class="checkpoint__swatch-chip" style="background:${escapeHtml(p.value)}"></span>
       <span class="checkpoint__swatch-label">${escapeHtml(p.label)}</span>
     </div>`).join("");

  const typo = data.typography || {};
  const heroSrc = typeof data.heroHtml === "string" ? data.heroHtml : "";
  const costLine = (typeof estCostNext === "number" && estCostNext > 0)
    ? `<span class="checkpoint__cost">Building all modules will cost ~$${estCostNext.toFixed(2)}</span>`
    : "";

  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      <div class="checkpoint">
        <div class="checkpoint__head">
          <span class="checkpoint__badge">Design checkpoint</span>
          <span class="checkpoint__headline">${escapeHtml(preview.headline || "Review the design before building")}</span>
        </div>
        <div class="checkpoint__hero">
          <iframe class="checkpoint__hero-frame" title="Hero preview" sandbox="" srcdoc="${escapeHtml(heroSrc)}"></iframe>
        </div>
        <div class="checkpoint__tokens">
          <div class="checkpoint__palette">${swatches || '<span class="checkpoint__muted">No palette tokens</span>'}</div>
          <div class="checkpoint__type">
            <div class="checkpoint__type-row" style="font-family:${escapeHtml(typo.heading || "")}">Aa — ${escapeHtml(typo.heading || "Heading font")}</div>
            <div class="checkpoint__type-row checkpoint__type-row--body" style="font-family:${escapeHtml(typo.body || "")}">Body — ${escapeHtml(typo.body || "Body font")}</div>
          </div>
        </div>
        ${costLine ? `<div class="checkpoint__meta">${costLine}</div>` : ""}
        <div class="checkpoint__steer hidden">
          <textarea class="checkpoint__steer-input" rows="2" placeholder="What should change? e.g. warmer palette, bigger headings..."></textarea>
        </div>
        <div class="checkpoint__actions">
          <button class="btn btn--primary checkpoint__btn" data-action="approve">Looks good — build it</button>
          <button class="btn checkpoint__btn" data-action="steer">Tweak the design</button>
          <button class="btn checkpoint__btn" data-action="skip" title="Build now and don't ask again this run">Skip checkpoints</button>
          <button class="btn btn--ghost checkpoint__btn" data-action="cancel">Cancel</button>
        </div>
      </div>
    </div>`;

  const steerWrap = div.querySelector(".checkpoint__steer");
  const steerInput = div.querySelector(".checkpoint__steer-input");
  const steerBtn = div.querySelector('.checkpoint__btn[data-action="steer"]');
  let steerArmed = false;

  div.querySelectorAll(".checkpoint__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      // Steer is two-step: first click reveals the note box, second submits.
      if (action === "steer" && !steerArmed) {
        steerArmed = true;
        steerWrap.classList.remove("hidden");
        steerBtn.textContent = "Apply tweak";
        if (steerInput) steerInput.focus();
        return;
      }
      const note = action === "steer" && steerInput ? steerInput.value.trim() : undefined;
      div.querySelectorAll(".checkpoint__btn").forEach((b) => (b.disabled = true));
      resolveCheckpoint(action, note);
    });
  });

  return div;
}

// Structure checkpoint card (VIB-1879) — the planned module skeleton as an
// editable outline (reorder / cut / add / rename) before the parallel build.
function renderStructureCheckpointCard(preview, data, estCostNext) {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";

  const modules = Array.isArray(data.modules) ? data.modules : [];
  const narrative = typeof data.narrative === "string" ? data.narrative : "";
  const costLine = (typeof estCostNext === "number" && estCostNext > 0)
    ? `<span class="checkpoint__cost">Building all modules will cost ~$${estCostNext.toFixed(2)}</span>`
    : "";

  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      <div class="checkpoint checkpoint--structure">
        <div class="checkpoint__head">
          <span class="checkpoint__badge">Structure checkpoint</span>
          <span class="checkpoint__headline">${escapeHtml(preview.headline || "Review the structure before building")}</span>
        </div>
        ${narrative ? `<div class="checkpoint__narrative">${escapeHtml(narrative)}</div>` : ""}
        <div class="checkpoint__outline"></div>
        <button type="button" class="btn btn--ghost checkpoint__add">+ Add section</button>
        ${costLine ? `<div class="checkpoint__meta">${costLine}</div>` : ""}
        <div class="checkpoint__steer hidden">
          <textarea class="checkpoint__steer-input" rows="2" placeholder="What should change? e.g. add a pricing section, drop the FAQ..."></textarea>
        </div>
        <div class="checkpoint__actions">
          <button class="btn btn--primary checkpoint__btn" data-action="approve">Build these sections</button>
          <button class="btn checkpoint__btn" data-action="steer">Re-plan structure</button>
          <button class="btn checkpoint__btn" data-action="skip" title="Build now and don't ask again this run">Skip checkpoints</button>
          <button class="btn btn--ghost checkpoint__btn" data-action="cancel">Cancel</button>
        </div>
      </div>
    </div>`;

  const listEl = div.querySelector(".checkpoint__outline");

  function makeRow(name, description, sourceIndex) {
    const row = document.createElement("div");
    row.className = "checkpoint__row";
    if (sourceIndex != null) row.dataset.sourceIndex = String(sourceIndex);
    if (description) row.dataset.desc = description;
    row.innerHTML = `
      <div class="checkpoint__row-move">
        <button type="button" class="checkpoint__row-btn" data-move="up" title="Move up" aria-label="Move up">▲</button>
        <button type="button" class="checkpoint__row-btn" data-move="down" title="Move down" aria-label="Move down">▼</button>
      </div>
      <div class="checkpoint__row-main">
        <input class="checkpoint__row-name" value="${escapeHtml(name || "")}" placeholder="section-name" spellcheck="false" />
        <span class="checkpoint__row-desc">${escapeHtml(description || "")}</span>
      </div>
      <button type="button" class="checkpoint__row-remove" data-remove title="Remove section" aria-label="Remove section">✕</button>`;

    row.querySelector('[data-move="up"]').addEventListener("click", () => {
      const prev = row.previousElementSibling;
      if (prev) listEl.insertBefore(row, prev);
    });
    row.querySelector('[data-move="down"]').addEventListener("click", () => {
      const next = row.nextElementSibling;
      if (next) listEl.insertBefore(next, row);
    });
    row.querySelector("[data-remove]").addEventListener("click", () => {
      row.remove();
    });
    return row;
  }

  modules.forEach((m) =>
    listEl.appendChild(makeRow(m.name, m.description, m.sourceIndex)),
  );

  div.querySelector(".checkpoint__add").addEventListener("click", () => {
    const row = makeRow("", "", null);
    listEl.appendChild(row);
    const input = row.querySelector(".checkpoint__row-name");
    if (input) input.focus();
  });

  function collectOutline() {
    return [...listEl.querySelectorAll(".checkpoint__row")]
      .map((row) => {
        const name = (row.querySelector(".checkpoint__row-name").value || "").trim();
        const si = row.dataset.sourceIndex;
        return {
          name,
          description: row.dataset.desc || undefined,
          sourceIndex: si !== undefined && si !== "" ? Number(si) : undefined,
        };
      })
      .filter((it) => it.name);
  }

  const steerWrap = div.querySelector(".checkpoint__steer");
  const steerInput = div.querySelector(".checkpoint__steer-input");
  const steerBtn = div.querySelector('.checkpoint__btn[data-action="steer"]');
  let steerArmed = false;

  div.querySelectorAll(".checkpoint__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      // Steer is two-step: first click reveals the note box, second submits.
      if (action === "steer" && !steerArmed) {
        steerArmed = true;
        steerWrap.classList.remove("hidden");
        steerBtn.textContent = "Apply re-plan";
        if (steerInput) steerInput.focus();
        return;
      }
      const note = action === "steer" && steerInput ? steerInput.value.trim() : undefined;
      // approve/skip carry the edited outline; steer/cancel don't.
      const outline = action === "approve" || action === "skip" ? collectOutline() : undefined;
      div.querySelectorAll(".checkpoint__btn").forEach((b) => (b.disabled = true));
      resolveCheckpoint(action, note, { outline });
    });
  });

  return div;
}

// ---------------------------------------------------------------------------
// Brand-intake gate card (VIB-1878) — the front-of-flow ask-back shown when a
// new page has no style system yet: "Surprise me" (AI invents) vs "Bring your
// brand" (paste colors/code/voice, or point at a site/theme → seed the design).
// ---------------------------------------------------------------------------

function renderBrandIntakeCard(preview, data) {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg--assistant";

  const channels = Array.isArray(data.channels) ? data.channels : [];
  const fields = channels.map((c) => {
    const id = `brand-${escapeHtml(c.key)}`;
    const input = c.multiline
      ? `<textarea class="brand-intake__input" data-key="${escapeHtml(c.key)}" rows="3" placeholder="${escapeHtml(c.placeholder || "")}"></textarea>`
      : `<input class="brand-intake__input" data-key="${escapeHtml(c.key)}" type="text" placeholder="${escapeHtml(c.placeholder || "")}" />`;
    return `<label class="brand-intake__field" for="${id}">
        <span class="brand-intake__label">${escapeHtml(c.label || c.key)}</span>
        ${input}
      </label>`;
  }).join("");

  div.innerHTML = `
    <div class="chat-msg__avatar chat-msg__avatar--ai">AI</div>
    <div class="chat-msg__content">
      <div class="checkpoint brand-intake">
        <div class="checkpoint__head">
          <span class="checkpoint__badge">Brand checkpoint</span>
          <span class="checkpoint__headline">${escapeHtml(preview.headline || "Match your brand, or surprise you?")}</span>
        </div>
        <div class="brand-intake__choices">
          <button class="btn btn--primary brand-intake__choice" data-choice="surprise">
            <span class="brand-intake__choice-title">${escapeHtml(data.surpriseLabel || "Surprise me")}</span>
            <span class="brand-intake__choice-hint">${escapeHtml(data.surpriseHint || "")}</span>
          </button>
          <button class="btn brand-intake__choice" data-choice="bring">
            <span class="brand-intake__choice-title">${escapeHtml(data.bringLabel || "Bring your brand")}</span>
            <span class="brand-intake__choice-hint">${escapeHtml(data.bringHint || "")}</span>
          </button>
        </div>
        <div class="brand-intake__form hidden">
          ${fields}
          <div class="brand-intake__form-actions">
            <button class="btn btn--primary brand-intake__submit">Use my brand</button>
            <button class="btn btn--ghost brand-intake__back">Back</button>
          </div>
        </div>
        <div class="checkpoint__actions brand-intake__top-actions">
          <button class="btn btn--ghost checkpoint__btn" data-action="cancel">Cancel</button>
        </div>
      </div>
    </div>`;

  const form = div.querySelector(".brand-intake__form");
  const choices = div.querySelector(".brand-intake__choices");

  div.querySelector('[data-choice="surprise"]').addEventListener("click", () => {
    div.querySelectorAll("button").forEach((b) => (b.disabled = true));
    // "Surprise me" = skip the brand step; the AI invents the design system.
    resolveCheckpoint("skip");
  });

  div.querySelector('[data-choice="bring"]').addEventListener("click", () => {
    if (choices) choices.classList.add("hidden");
    if (form) form.classList.remove("hidden");
    const first = div.querySelector(".brand-intake__input");
    if (first) first.focus();
  });

  const backBtn = div.querySelector(".brand-intake__back");
  if (backBtn) backBtn.addEventListener("click", () => {
    if (form) form.classList.add("hidden");
    if (choices) choices.classList.remove("hidden");
  });

  const submitBtn = div.querySelector(".brand-intake__submit");
  if (submitBtn) submitBtn.addEventListener("click", () => {
    const brandIntake = {};
    div.querySelectorAll(".brand-intake__input").forEach((el) => {
      const v = (el.value || "").trim();
      if (v) brandIntake[el.dataset.key] = v;
    });
    if (Object.keys(brandIntake).length === 0) {
      // Nothing filled in → treat as "surprise me" rather than a no-op.
      div.querySelectorAll("button").forEach((b) => (b.disabled = true));
      resolveCheckpoint("skip");
      return;
    }
    div.querySelectorAll("button").forEach((b) => (b.disabled = true));
    resolveCheckpoint("approve", undefined, { brandIntake });
  });

  const cancelBtn = div.querySelector('.checkpoint__btn[data-action="cancel"]');
  if (cancelBtn) cancelBtn.addEventListener("click", () => {
    div.querySelectorAll("button").forEach((b) => (b.disabled = true));
    resolveCheckpoint("cancel");
  });

  return div;
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
  const topbarUndo = document.getElementById("btn-undo");
  const topbarRedo = document.getElementById("btn-redo");
  const max = historyTimelineEntries.length - 1;
  const busy = historyTimelineRestoring || (typeof isStreaming !== "undefined" && isStreaming);
  const undoDisabled = busy || !historyGitAvailable || historyTimelineCursor >= max;
  const redoDisabled = busy || !historyGitAvailable || historyTimelineCursor <= 0;
  if (undoBtn) undoBtn.disabled = undoDisabled;
  if (redoBtn) redoBtn.disabled = redoDisabled;
  if (topbarUndo) topbarUndo.disabled = undoDisabled;
  if (topbarRedo) topbarRedo.disabled = redoDisabled;
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

  // Topbar undo/redo buttons mirror the timeline strip controls so the action
  // is discoverable without opening the history panel.
  const topbarUndo = document.getElementById("btn-undo");
  const topbarRedo = document.getElementById("btn-redo");
  if (topbarUndo) topbarUndo.addEventListener("click", timelineUndo);
  if (topbarRedo) topbarRedo.addEventListener("click", timelineRedo);

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

  // Download is only meaningful once the theme has at least one module.
  const downloadBtn = document.getElementById("btn-download");
  if (downloadBtn) downloadBtn.disabled = moduleNames.length === 0;

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
      <span class="module-item__edit" title="Edit fields">${vsIcon("settings", {size: "sm"})}</span>
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

// One-shot button — build the whole page, skipping the design checkpoint.
if (oneShotBtn) {
  oneShotBtn.addEventListener("click", () => {
    sendMessage(inputEl.value, { oneShot: true });
  });
}

// Enter to send (Shift+Enter for newline)
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

// Auto-grow textarea — 3 rows default, expand up to 6 rows.
// Line-height (1.5) × font-size (14px) × 6 rows + ~8px padding = ~134px.
const CHAT_INPUT_MAX_HEIGHT = 134;
function autoGrowChatInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, CHAT_INPUT_MAX_HEIGHT) + "px";
}
inputEl.addEventListener("input", () => {
  autoGrowChatInput();

  // Hide suggestion chips as soon as the user starts typing
  if (suggestionsVisible && inputEl.value.length > 0) {
    hideChatSuggestions();
  }
});

// Contextual placeholder — adapts to plan mode and whether a page already exists.
function updateChatPlaceholder() {
  if (!inputEl) return;
  const planActive = !!window.planModeActive;
  const moduleCountEl = document.getElementById("module-count");
  const moduleCount = moduleCountEl ? parseInt(moduleCountEl.textContent || "0", 10) || 0 : 0;
  let placeholder;
  if (planActive) {
    placeholder = "Describe what you want to plan...";
  } else if (moduleCount > 0) {
    placeholder = "Describe what you want to change...";
  } else {
    placeholder = "Describe your landing page...";
  }
  inputEl.placeholder = placeholder;
}

// Re-evaluate placeholder when plan mode changes (plan.js dispatches this) or
// when the module list updates.
window.addEventListener("plan-mode-changed", updateChatPlaceholder);
const _moduleCountEl = document.getElementById("module-count");
if (_moduleCountEl && typeof MutationObserver !== "undefined") {
  new MutationObserver(updateChatPlaceholder).observe(_moduleCountEl, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}
updateChatPlaceholder();

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
  autoGrowChatInput();
  inputEl.focus();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
};

// Conversation starter buttons in chat welcome
document.getElementById("conversation-starters")?.addEventListener("click", handleConversationStarterClick);

// Templates icon in input area — switch to Library tab where project assets live
document.getElementById("btn-starter-templates")?.addEventListener("click", () => {
  const libraryTab = document.getElementById("ws-tab-library");
  if (libraryTab) {
    libraryTab.click();
    document.getElementById("library-project-assets")?.scrollIntoView({ behavior: "smooth", block: "start" });
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

// Download button — fetches the HubSpot-ready .zip of the active theme.
// The server streams it as an attachment; an anchor lets the browser save it.
document.getElementById("btn-download")?.addEventListener("click", () => {
  const btn = document.getElementById("btn-download");
  if (!btn || btn.disabled) return;
  const a = document.createElement("a");
  a.href = "/api/download-zip";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
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
      const idSuffix = hs.portalId ? ` (${hs.portalId})` : "";
      pill.innerHTML = `<span class="statusbar__dot statusbar__dot--ok"></span><span class="statusbar__item-text">${escapeHtml(hs.portalName)}${escapeHtml(idSuffix)}</span>`;
    } else {
      pill.textContent = "";
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
          setStatusTheme(data.newName);
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
