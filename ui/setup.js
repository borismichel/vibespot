/* Theme init — runs synchronously before DOM to prevent flash.
   Light is the default to match HubSpot's light-first ecosystem. */
const VIBESPOT_THEMES = ["dark", "light", "hubspot"];
const VIBESPOT_THEME_LABELS = {
  dark: "Dark",
  light: "Light",
  hubspot: "HubSpot Light",
};
(function initTheme() {
  const stored = localStorage.getItem("vibespot-theme");
  const theme = VIBESPOT_THEMES.includes(stored) ? stored : "light";
  document.documentElement.setAttribute("data-theme", theme);
})();

function syncThemeToggleLabel() {
  const btn = document.querySelector(".theme-toggle");
  if (!btn) return;
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const idx = VIBESPOT_THEMES.indexOf(current);
  const next = VIBESPOT_THEMES[(idx + 1) % VIBESPOT_THEMES.length];
  const label = `Theme: ${VIBESPOT_THEME_LABELS[current] || current} — switch to ${VIBESPOT_THEME_LABELS[next] || next}`;
  btn.setAttribute("title", label);
  btn.setAttribute("aria-label", label);
}
document.addEventListener("DOMContentLoaded", syncThemeToggleLabel);

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const idx = VIBESPOT_THEMES.indexOf(current);
  const next = VIBESPOT_THEMES[((idx === -1 ? 0 : idx) + 1) % VIBESPOT_THEMES.length];
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("vibespot-theme", next);
  syncThemeToggleLabel();
}

/* ---------------------------------------------------------------------------
 * HubSpot portal indicator (topbar) — visible in both Project Home and Editor
 * Reads /api/settings/status and reflects the active HubSpot portal's
 * connection state. Clicking opens Settings (HubSpot tab).
 * ------------------------------------------------------------------------- */
async function refreshPortalIndicator() {
  const link = document.getElementById("topbar-portal-indicator");
  const label = document.getElementById("topbar-portal-label");
  if (!link || !label) return;
  try {
    const res = await fetch("/api/settings/status");
    const data = await res.json();
    const hs = data && data.environment && data.environment.tools && data.environment.tools.hubspot;
    if (hs && hs.authenticated && hs.portalName) {
      const portal = hs.portalId ? `${hs.portalName} (${hs.portalId})` : hs.portalName;
      link.classList.add("portal-indicator--connected");
      link.classList.remove("portal-indicator--disconnected");
      link.setAttribute("title", `Connected to HubSpot portal ${portal}`);
      link.setAttribute("aria-label", `Connected to HubSpot portal ${portal}`);
      label.textContent = portal;
    } else {
      link.classList.remove("portal-indicator--connected");
      link.classList.add("portal-indicator--disconnected");
      link.setAttribute("title", "No HubSpot portal connected — open Settings to add one");
      link.setAttribute("aria-label", "No HubSpot portal connected — open Settings to add one");
      label.textContent = "Not connected";
    }
  } catch {
    // Server unreachable — leave the disconnected state in place.
  }
}

function bindPortalIndicator() {
  const link = document.getElementById("topbar-portal-indicator");
  if (!link || link.dataset.bound === "1") return;
  link.dataset.bound = "1";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    // In Editor mode, the workspace tab "settings" exists; otherwise the
    // Project Home settings button opens the same overlay.
    const editorTab = document.getElementById("ws-tab-settings");
    const setupBtn = document.getElementById("btn-setup-settings");
    const appBody = document.getElementById("app-body");
    const isEditor = appBody && appBody.getAttribute("data-mode") === "editor";
    const target = isEditor ? editorTab : setupBtn;
    if (target && typeof target.click === "function") target.click();
    else if (editorTab) editorTab.click();
    else if (setupBtn) setupBtn.click();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindPortalIndicator();
  refreshPortalIndicator();
});

// Re-poll occasionally so a freshly-saved PAT shows up without reload.
setInterval(() => { refreshPortalIndicator(); }, 30000);

/**
 * Setup screen — onboarding flow in the browser.
 * Handles theme creation, fetching, opening, and session resume.
 */

const setupScreen = document.getElementById("setup-screen");
const appScreen = document.getElementById("editor");
const appBody = document.getElementById("app-body");
let _serverContentMode = "page";

// ---------------------------------------------------------------------------
// Load setup info on page load
// ---------------------------------------------------------------------------

const ENGINE_DISPLAY_NAMES = {
  "claude-code": "Claude Code",
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
  "gemini-cli": "Gemini CLI",
  "gemini-api": "Gemini API",
  "codex-cli": "Codex CLI",
};

async function initSetup() {
  try {
    // Show loading spinner in switcher while fetching
    const switcherList = document.getElementById("project-switcher-list");
    if (switcherList) {
      switcherList.innerHTML = `
        <div class="project-switcher__loading">
          <div class="setup__spinner"></div>
          <span>Loading projects...</span>
        </div>`;
    }

    const res = await fetch("/api/setup");
    const info = await res.json();

    // Populate the project switcher with all projects (used in editor mode)
    populateProjectRail(info);

    // Show "Continue where you left off" cards above the create options
    populateRecentProjects(info);

    // Auto-select engine if available but not yet chosen
    if (info.availableEngines && info.availableEngines.length > 0 && !info.activeEngine) {
      const engine = info.availableEngines[0];
      await fetch("/api/settings/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine }),
      });
      info.activeEngine = engine;
      info.aiAvailable = true;
      // Update statusbar
      const statusEngine = document.getElementById("status-engine");
      if (statusEngine) statusEngine.textContent = ENGINE_DISPLAY_NAMES[engine] || engine;
    }

    // Show environment alerts
    const alerts = document.getElementById("setup-alerts");
    alerts.innerHTML = "";
    if (!info.aiAvailable) {
      alerts.innerHTML += `
        <div class="setup__alert setup__alert--warn">
          <div>No AI engine configured. Paste an API key to get started:</div>
          <div class="setup__alert-key-row">
            <input type="password" class="setup__alert-key-input" id="alert-api-key" placeholder="sk-ant-api03-..." />
            <button class="btn btn--primary btn--sm" id="alert-api-save">Save</button>
          </div>
          <div class="setup__alert-alt">or <a href="#" id="alert-setup-link">open settings</a> for more options</div>
        </div>`;
      setTimeout(() => {
        const link = document.getElementById("alert-setup-link");
        if (link) link.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });
        const saveBtn = document.getElementById("alert-api-save");
        const keyInput = document.getElementById("alert-api-key");
        if (saveBtn && keyInput) {
          const doSave = () => saveAlertApiKey(keyInput.value.trim());
          saveBtn.addEventListener("click", doSave);
          keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
        }
      }, 0);
    }

    // First-visit product intro: 3-step walkthrough explaining vibeSpot.
    // Add ?intro to URL to force-show it for testing.
    const params = new URLSearchParams(location.search);
    const introSeen = localStorage.getItem(INTRO_SEEN_KEY) === "1";
    const isFreshUser = info.sessions.length === 0 && info.localThemes.length === 0;
    if (params.has("intro") || (!introSeen && isFreshUser)) {
      showIntroWalkthrough(info);
      return;
    }

    // Check if we should show the engine-setup walkthrough (fresh environment).
    // Add ?walkthrough to URL to force-show it for testing
    if (params.has("walkthrough") ||
        (!info.aiAvailable && isFreshUser)) {
      showWalkthrough();
      return;
    }

    // Track server content mode (email vs page)
    _serverContentMode = info.contentMode || "page";

    // Reset panel state
    remoteThemesLoaded = false;

    // Reset starter cache so each visit re-fetches from server
    _startersCache = null;

    // Set warm time-of-day greeting; show asset-type cards as the primary entry.
    initGuidedEntry();

    // Reset to cards-first state (no panel, prompt hidden).
    activePanel = null;
    showAssetTypeCards();

  } catch (err) {
    showError("Could not connect to server. Is vibeSpot running?");
  }
}

// ---------------------------------------------------------------------------
// Guided entry — time-of-day greeting + asset-type card flow (VIB-255)
// ---------------------------------------------------------------------------

function initGuidedEntry() {
  const textEl = document.getElementById("setup-greeting-text");
  if (!textEl) return;
  const hour = new Date().getHours();
  let greeting = "Welcome";
  if (hour < 5) greeting = "Working late";
  else if (hour < 12) greeting = "Good morning";
  else if (hour < 17) greeting = "Good afternoon";
  else greeting = "Good evening";
  textEl.textContent = greeting;
}

let _selectedAssetType = null;

function showAssetTypeCards() {
  const cards = document.getElementById("setup-type-cards");
  const promptCard = document.getElementById("setup-prompt-card");
  const recent = document.getElementById("setup-recent");
  const promptInput = document.getElementById("setup-prompt-input");
  const question = document.getElementById("setup-question");
  const importPanel = document.getElementById("setup-import-sources");
  if (cards) cards.classList.remove("hidden");
  if (question) question.classList.remove("hidden");
  if (importPanel) importPanel.classList.add("hidden");
  if (promptCard) {
    promptCard.classList.add("hidden");
    promptCard.dataset.assetType = "";
  }
  if (recent && recent.dataset.hasItems === "1") recent.classList.remove("hidden");
  if (promptInput) {
    promptInput.value = "";
    const submit = document.getElementById("setup-prompt-submit");
    if (submit) submit.disabled = true;
  }
  // Close any open advanced panel (e.g. starter grid) when returning to cards.
  document.querySelectorAll(".setup__panel").forEach((p) => p.classList.add("hidden"));
  document.querySelectorAll(".setup__action-btn").forEach((b) => b.classList.remove("active"));
  activePanel = null;
  _selectedAssetType = null;
}

function showScopedPrompt(card) {
  const cards = document.getElementById("setup-type-cards");
  const promptCard = document.getElementById("setup-prompt-card");
  const recent = document.getElementById("setup-recent");
  const eyebrow = document.getElementById("setup-prompt-eyebrow");
  const input = document.getElementById("setup-prompt-input");
  if (!promptCard || !input) return;

  const assetType = card.dataset.assetType || "landing-page";
  const placeholder = card.dataset.promptPlaceholder || "Describe what you want to build...";
  const label = card.dataset.promptEyebrow || "Project";

  _selectedAssetType = assetType;
  promptCard.dataset.assetType = assetType;
  if (eyebrow) eyebrow.textContent = label;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder.replace(/\.\.\.$/, ""));

  // Stash the selected type so downstream session/chat code can read it later.
  window.__pendingAssetType = assetType;

  if (cards) cards.classList.add("hidden");
  if (recent) recent.classList.add("hidden");
  promptCard.classList.remove("hidden");

  setTimeout(() => input.focus(), 60);
}

async function saveAlertApiKey(key) {
  if (!key) return;
  // Detect provider from key prefix
  let provider;
  if (key.startsWith("sk-ant-")) provider = "anthropic";
  else if (key.startsWith("sk-")) provider = "openai";
  else if (key.startsWith("AIza")) provider = "gemini";
  else provider = "anthropic"; // default guess

  try {
    const res = await fetch("/api/settings/apikey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey: key }),
    });
    const data = await res.json();
    if (data.error) { await vibeAlert(data.error, "Error"); return; }

    // Update statusbar if engine was auto-selected
    if (data.autoSelectedEngine) {
      const statusEngine = document.getElementById("status-engine");
      if (statusEngine) statusEngine.textContent = ENGINE_DISPLAY_NAMES[data.autoSelectedEngine] || data.autoSelectedEngine;
    }

    // Re-init to refresh everything
    initSetup();
  } catch (err) {
    await vibeAlert("Failed to save API key: " + err.message, "Error");
  }
}

// ---------------------------------------------------------------------------
// Project list helpers
// ---------------------------------------------------------------------------

/** Dedup sessions + local themes into a single project list */
function deduplicateProjects(info) {
  const projects = [];
  const seen = new Set();

  for (const s of info.sessions || []) {
    if (!seen.has(s.themeName)) {
      seen.add(s.themeName);
      projects.push({
        name: s.themeName,
        type: "session",
        sessionId: s.id,
        updatedAt: s.updatedAt,
        moduleCount: s.moduleCount ?? null,
        templateCount: s.templateCount ?? null,
        pageCount: s.pageCount ?? 0,
        emailCount: s.emailCount ?? 0,
        hasBrandAssets: s.hasBrandAssets ?? false,
      });
    }
  }

  for (const t of info.localThemes || []) {
    const name = typeof t === "string" ? t : t.name;
    if (!seen.has(name)) {
      seen.add(name);
      projects.push({
        name,
        type: "local",
        sessionId: null,
        updatedAt: null,
        moduleCount: typeof t === "object" ? t.moduleCount ?? null : null,
        templateCount: null,
        pageCount: 0,
        emailCount: 0,
        hasBrandAssets: false,
      });
    }
  }

  return projects;
}

// ---------------------------------------------------------------------------
// "Continue where you left off" — recent projects above the create options
// ---------------------------------------------------------------------------

const RECENT_PROJECTS_LIMIT = 4;
let _allProjects = [];

function populateRecentProjects(info) {
  const section = document.getElementById("setup-recent");
  const list = document.getElementById("setup-recent-list");
  const viewAll = document.getElementById("setup-recent-all");
  if (!section || !list) return;

  const projects = deduplicateProjects(info);
  if (projects.length === 0) {
    _allProjects = [];
    section.classList.add("hidden");
    section.dataset.hasItems = "0";
    list.innerHTML = "";
    return;
  }
  section.dataset.hasItems = "1";

  // Most recently updated first; locals (no updatedAt) follow
  const withTime = projects.filter((p) => p.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const withoutTime = projects.filter((p) => !p.updatedAt);
  const ordered = [...withTime, ...withoutTime];
  _allProjects = ordered;
  const top = ordered.slice(0, RECENT_PROJECTS_LIMIT);

  list.innerHTML = "";
  for (const p of top) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "setup__recent-card";

    const initial = p.name.charAt(0).toUpperCase();
    const meta = p.updatedAt ? timeAgo(p.updatedAt) : "on disk";

    card.innerHTML =
      `<span class="setup__recent-card-bubble">${esc(initial)}</span>` +
      `<span class="setup__recent-card-text">` +
      `<span class="setup__recent-card-name">${esc(p.name)}</span>` +
      `<span class="setup__recent-card-meta">${esc(meta)}</span>` +
      `</span>`;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "setup__recent-card-delete";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete project";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteProject(p);
    });
    card.appendChild(delBtn);

    card.addEventListener("click", () => {
      if (typeof isStreaming !== "undefined" && isStreaming) {
        showError("Cannot switch projects while AI is generating.");
        return;
      }
      if (p.sessionId) resumeSession(p.sessionId);
      else openTheme(p.name);
    });
    list.appendChild(card);
  }

  if (viewAll) viewAll.classList.toggle("hidden", projects.length <= top.length);
  section.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Project switcher (rendered into the editor-mode rail popover)
// ---------------------------------------------------------------------------

const railTooltip = document.getElementById("project-rail-tooltip");

/**
 * Populate the project switcher menu with all projects. Item DOM uses the
 * stable `.project-rail__item*` class names so the rename / delete logic in
 * chat.js + setup.js can keep targeting them.
 */
function populateProjectRail(info) {
  const list = document.getElementById("project-switcher-list");
  if (!list) return;
  list.innerHTML = "";

  const projects = deduplicateProjects(info);

  if (projects.length === 0) {
    list.innerHTML = '<div class="project-switcher__empty">No projects yet.<br>Create one to get started.</div>';
    return;
  }

  for (const p of projects) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "project-rail__item";
    item.dataset.name = p.name;
    if (p.sessionId) item.dataset.sessionId = p.sessionId;

    const initial = p.name.charAt(0).toUpperCase();
    const meta = p.updatedAt ? timeAgo(p.updatedAt) : "on disk";

    const bubble = document.createElement("div");
    bubble.className = "project-rail__item-bubble";
    bubble.textContent = initial;
    item.appendChild(bubble);

    const infoEl = document.createElement("div");
    infoEl.className = "project-rail__item-info";
    infoEl.innerHTML = `
      <span class="project-rail__item-name">${esc(p.name)}</span>
      <span class="project-rail__item-meta">${meta}</span>`;
    item.appendChild(infoEl);

    const nameSpan = infoEl.querySelector(".project-rail__item-name");
    if (nameSpan) {
      nameSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startInlineRename(nameSpan, p);
      });
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "project-rail__item-delete";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete project";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteProject(p);
    });
    item.appendChild(delBtn);

    item.addEventListener("click", () => {
      if (typeof isStreaming !== "undefined" && isStreaming) {
        showError("Cannot switch projects while AI is generating.");
        return;
      }
      closeProjectSwitcher();
      if (p.sessionId) resumeSession(p.sessionId);
      else openTheme(p.name);
    });

    list.appendChild(item);
  }

  updateRailActive();
}

function updateRailActive() {
  const current = currentAppTheme || currentDashboardTheme || "";
  document.querySelectorAll(".project-rail__item").forEach((btn) => {
    btn.classList.toggle("project-rail__item--active", btn.dataset.name === current);
  });
  // Refresh the rail's current-project bubble + name (editor mode only).
  const bubble = document.getElementById("project-rail-current-bubble");
  const nameEl = document.getElementById("project-rail-current-name");
  if (bubble) bubble.textContent = current ? current.charAt(0).toUpperCase() : "P";
  if (nameEl) nameEl.textContent = current || "";
  const trigger = document.getElementById("project-rail-current");
  if (trigger) trigger.title = current ? current + " — switch project" : "Switch project";
}

// ---------------------------------------------------------------------------
// Switcher popover open/close
// ---------------------------------------------------------------------------

function openProjectSwitcher() {
  const popover = document.getElementById("project-switcher");
  const trigger = document.getElementById("project-rail-current");
  if (!popover || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  popover.style.top = Math.max(8, rect.top) + "px";
  popover.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  // Refresh data so the list reflects the latest sessions.
  fetch("/api/setup")
    .then((r) => r.json())
    .then((info) => populateProjectRail(info))
    .catch(() => {});
}

function closeProjectSwitcher() {
  const popover = document.getElementById("project-switcher");
  const trigger = document.getElementById("project-rail-current");
  if (popover) popover.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function toggleProjectSwitcher() {
  const popover = document.getElementById("project-switcher");
  if (!popover) return;
  if (popover.hidden) openProjectSwitcher();
  else closeProjectSwitcher();
}

document.getElementById("project-rail-current")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleProjectSwitcher();
});

document.getElementById("project-rail-back")?.addEventListener("click", () => {
  if (typeof isStreaming !== "undefined" && isStreaming) {
    showError("Cannot leave the editor while AI is generating.");
    return;
  }
  closeProjectSwitcher();
  showSetup();
});

document.getElementById("project-switcher-add")?.addEventListener("click", () => {
  closeProjectSwitcher();
  showSetup();
  togglePanel("new");
});

// Close on outside click / Escape
document.addEventListener("click", (e) => {
  const popover = document.getElementById("project-switcher");
  if (!popover || popover.hidden) return;
  const trigger = document.getElementById("project-rail-current");
  if (popover.contains(e.target) || (trigger && trigger.contains(e.target))) return;
  closeProjectSwitcher();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeProjectSwitcher();
});

// Tooltip on the current-project bubble (editor rail)
document.getElementById("project-rail-current")?.addEventListener("mouseenter", () => {
  const popover = document.getElementById("project-switcher");
  if (popover && !popover.hidden) return;
  const name = currentAppTheme || currentDashboardTheme || "";
  if (!name) return;
  railTooltip.innerHTML =
    '<div class="project-rail__tooltip-name">' + esc(name) + "</div>" +
    '<div class="project-rail__tooltip-stats">Click to switch project</div>';
  const rect = document.getElementById("project-rail-current").getBoundingClientRect();
  railTooltip.style.top = rect.top + "px";
  railTooltip.classList.add("project-rail__tooltip--visible");
});

document.getElementById("project-rail-current")?.addEventListener("mouseleave", () => {
  railTooltip.classList.remove("project-rail__tooltip--visible");
});

// ---------------------------------------------------------------------------
// Inline rename
// ---------------------------------------------------------------------------

function startInlineRename(nameSpan, project) {
  if (nameSpan.contentEditable === "true") return; // already editing

  const oldName = project.name;
  nameSpan.contentEditable = "true";
  nameSpan.classList.add("project-rail__item-name--editing");
  nameSpan.focus();

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(nameSpan);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function commit() {
    nameSpan.contentEditable = "false";
    nameSpan.classList.remove("project-rail__item-name--editing");

    const newName = nameSpan.textContent.trim();
    if (!newName || newName === oldName) {
      nameSpan.textContent = oldName;
      return;
    }

    fetch("/api/themes/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: project.sessionId, newName }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          // Update the in-memory project name + UI
          project.name = data.newName;
          nameSpan.textContent = data.newName;
          const item = nameSpan.closest(".project-rail__item");
          if (item) {
            item.dataset.name = data.newName;
            const bubble = item.querySelector(".project-rail__item-bubble");
            if (bubble) bubble.textContent = data.newName.charAt(0).toUpperCase();
          }
          // Update topbar if this is the active project
          if (currentAppTheme === oldName) {
            currentAppTheme = data.newName;
            const themeNameEl = document.getElementById("theme-name");
            if (themeNameEl) themeNameEl.textContent = data.newName;
            window.location.hash = "#/app/" + encodeURIComponent(data.newName);
          }
          updateRailActive();
        } else {
          nameSpan.textContent = oldName;
          showError(data.error || "Rename failed");
        }
      })
      .catch(() => {
        nameSpan.textContent = oldName;
        showError("Rename failed");
      });
  }

  nameSpan.addEventListener("blur", commit, { once: true });
  nameSpan.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameSpan.blur();
    }
    if (e.key === "Escape") {
      nameSpan.textContent = oldName;
      nameSpan.blur();
    }
  });
}

// ---------------------------------------------------------------------------
// Delete project confirmation
// ---------------------------------------------------------------------------

function confirmDeleteProject(project) {
  // Build a custom confirm dialog
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-dialog__title">Delete "${esc(project.name)}"?</div>
      <label class="confirm-dialog__check">
        <input type="checkbox" id="confirm-delete-files" checked />
        <span>Also delete local files</span>
      </label>
      <p class="confirm-dialog__warn">Deleting local files cannot be undone.</p>
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
    const deleteFiles = document.getElementById("confirm-delete-files").checked;
    overlay.remove();

    try {
      if (project.sessionId) {
        await fetch("/api/themes", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: project.sessionId, deleteFiles }),
        });
      } else if (deleteFiles) {
        // Local-only theme (no session) — delete via dedicated endpoint
        await fetch("/api/themes/delete-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ themeName: project.name }),
        });
      }
      // Refresh the sidebar
      initSetup();
    } catch {
      showError("Failed to delete project.");
    }
  });
}

// ---------------------------------------------------------------------------
// First-visit product intro walkthrough (3 steps)
// ---------------------------------------------------------------------------

const INTRO_SEEN_KEY = "vibespot:introSeen";
const INTRO_SAMPLE_PROMPT =
  "A landing page for a B2B SaaS product called Northwind Analytics. " +
  "Include a hero with a headline and CTA, three feature cards, a customer logo bar, " +
  "a testimonial, and a final call-to-action section.";

function renderIntroProgress(stepIndex, totalSteps) {
  let html = "";
  for (let i = 0; i < totalSteps; i++) {
    const cls = i === stepIndex ? "active" : i < stepIndex ? "done" : "";
    html += `<div class="walkthrough__step-dot ${cls}">${i < stepIndex ? vsIcon("check", {size: "sm"}) : i + 1}</div>`;
    if (i < totalSteps - 1) html += `<div class="walkthrough__step-line"></div>`;
  }
  return html;
}

function dismissIntroWalkthrough(info) {
  try { localStorage.setItem(INTRO_SEEN_KEY, "1"); } catch {}
  const url = new URL(location.href);
  if (url.searchParams.has("intro")) {
    url.searchParams.delete("intro");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  document.getElementById("walkthrough").classList.add("hidden");
  // If the user still has no AI engine on a fresh install, fall through to
  // the engine-setup walkthrough; otherwise reveal the normal setup options.
  if (info && !info.aiAvailable && (info.sessions || []).length === 0 && (info.localThemes || []).length === 0) {
    showWalkthrough();
  } else {
    document.getElementById("setup-options").classList.remove("hidden");
  }
}

function showIntroWalkthrough(info) {
  const walkthrough = document.getElementById("walkthrough");
  const options = document.getElementById("setup-options");
  const progress = document.getElementById("walkthrough-progress");
  const content = document.getElementById("walkthrough-content");
  if (!walkthrough || !options || !progress || !content) return;

  walkthrough.classList.remove("hidden");
  options.classList.add("hidden");

  const STEPS = [
    {
      title: "Welcome to vibeSpot",
      body: `
        <p>vibeSpot turns plain-language descriptions into native HubSpot CMS landing pages.
        Describe what you want, watch a live preview build, then upload the result straight to HubSpot.</p>
        <ul class="walkthrough__bullets">
          <li>Chat-driven editing with a side-by-side preview</li>
          <li>Generates real HubL modules, not screenshots or mockups</li>
          <li>Works with Claude, OpenAI, or Gemini &mdash; API key or CLI</li>
        </ul>
      `,
    },
    {
      title: "How it maps to HubSpot",
      body: `
        <p>Every vibeSpot page becomes a fully editable HubSpot theme. The pieces line up like this:</p>
        <ul class="walkthrough__bullets">
          <li><strong>Sections</strong> &rarr; HubSpot <strong>modules</strong> with editable fields</li>
          <li><strong>Shared CSS &amp; tokens</strong> &rarr; theme-level <code>:root</code> variables</li>
          <li><strong>Project</strong> &rarr; uploadable <strong>HubSpot CMS theme</strong> with templates</li>
        </ul>
        <p>Marketers can keep editing fields in HubSpot after upload &mdash; no code changes required.</p>
      `,
    },
    {
      title: "Try it with a pre-filled prompt",
      body: `
        <p>We&rsquo;ll drop a sample prompt into the builder so you can see vibeSpot in action.
        You can edit it before pressing <strong>Build</strong>.</p>
        <div class="walkthrough__card walkthrough__sample-prompt">
          <div class="walkthrough__card-title">Sample prompt</div>
          <div class="walkthrough__sample-prompt-body">${esc(INTRO_SAMPLE_PROMPT)}</div>
        </div>
      `,
    },
  ];

  let stepIndex = 0;

  function render() {
    const step = STEPS[stepIndex];
    progress.innerHTML = renderIntroProgress(stepIndex, STEPS.length);

    const isLast = stepIndex === STEPS.length - 1;
    const primaryLabel = isLast ? "Try it now" : "Next";
    const backBtn = stepIndex > 0
      ? `<button class="btn btn--secondary" id="intro-back">Back</button>`
      : "";

    content.innerHTML = `
      <div class="walkthrough__step-title">${esc(step.title)}</div>
      <div class="walkthrough__step-desc">${step.body}</div>
      <div class="walkthrough__actions">
        <button class="btn btn--ghost" id="intro-skip">Skip intro</button>
        <span class="walkthrough__actions-spacer"></span>
        ${backBtn}
        <button class="btn btn--primary" id="intro-next">${primaryLabel}</button>
      </div>
    `;

    document.getElementById("intro-skip").addEventListener("click", () => dismissIntroWalkthrough(info));
    document.getElementById("intro-next").addEventListener("click", () => {
      if (isLast) {
        // Pre-fill the prompt and hand off to the normal builder flow.
        const promptInput = document.getElementById("setup-prompt-input");
        if (promptInput) {
          promptInput.value = INTRO_SAMPLE_PROMPT;
          promptInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        dismissIntroWalkthrough(info);
        // Focus the prompt so the user lands ready to edit / submit.
        setTimeout(() => {
          const el = document.getElementById("setup-prompt-input");
          if (el) {
            el.focus();
            if (typeof el.scrollIntoView === "function") {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }
        }, 0);
        return;
      }
      stepIndex++;
      render();
    });
    const backEl = document.getElementById("intro-back");
    if (backEl) backEl.addEventListener("click", () => { stepIndex--; render(); });
  }

  render();
}

// ---------------------------------------------------------------------------
// Guided walkthrough (first-run experience)
// ---------------------------------------------------------------------------

async function showWalkthrough() {
  const walkthrough = document.getElementById("walkthrough");
  const options = document.getElementById("setup-options");

  walkthrough.classList.remove("hidden");
  options.classList.add("hidden");

  // Fetch full environment status for CLI tool details
  let envData;
  try {
    const res = await fetch("/api/settings/status");
    envData = await res.json();
  } catch {
    showError("Could not load environment status.");
    walkthrough.classList.add("hidden");
    options.classList.remove("hidden");
    return;
  }

  const env = envData.environment;
  const progress = document.getElementById("walkthrough-progress");
  const content = document.getElementById("walkthrough-content");
  progress.innerHTML = "";

  content.innerHTML = `
    <div class="walkthrough__step-title">Set up your AI engine</div>
    <div class="walkthrough__step-desc">vibeSpot needs an AI engine to build HubSpot pages. The fastest way is to paste an API key.</div>

    <div class="walkthrough__card walkthrough__card--highlight">
      <div class="walkthrough__card-title">Paste an API key <span class="walkthrough__badge">Easiest</span></div>
      <div class="walkthrough__key-row">
        <label>Anthropic</label>
        <input type="password" class="walkthrough__key-input" id="wt-key-anthropic" placeholder="sk-ant-api03-..." />
        <button class="btn btn--primary btn--sm" data-provider="anthropic">Save</button>
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" class="walkthrough__key-link">Get key</a>
      </div>
      <div class="walkthrough__key-row">
        <label>OpenAI</label>
        <input type="password" class="walkthrough__key-input" id="wt-key-openai" placeholder="sk-..." />
        <button class="btn btn--primary btn--sm" data-provider="openai">Save</button>
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="walkthrough__key-link">Get key</a>
      </div>
      <div class="walkthrough__key-row">
        <label>Google AI</label>
        <input type="password" class="walkthrough__key-input" id="wt-key-gemini" placeholder="AIza..." />
        <button class="btn btn--primary btn--sm" data-provider="gemini">Save</button>
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="walkthrough__key-link">Get key</a>
      </div>
    </div>

    <div class="walkthrough__card">
      <div class="walkthrough__card-title">Or use a CLI tool</div>
      <div class="walkthrough__tool-list">
        ${cliToolRow("Claude Code", "claude-code", env.tools.claudeCode)}
        ${cliToolRow("Gemini CLI", "gemini-cli", env.tools.geminiCli)}
        ${cliToolRow("Codex CLI", "codex-cli", env.tools.codexCli)}
      </div>
    </div>

    <div class="walkthrough__actions">
      <button class="btn btn--secondary" id="wt-skip">Skip for now</button>
    </div>
  `;

  // API key save handlers
  content.querySelectorAll(".walkthrough__card--highlight button[data-provider]").forEach((btn) => {
    const provider = btn.dataset.provider;
    const input = document.getElementById("wt-key-" + provider);
    const doSave = async () => {
      const key = input.value.trim();
      if (!key) return;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const res = await fetch("/api/settings/apikey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey: key }),
        });
        const data = await res.json();
        if (data.error) { await vibeAlert(data.error, "Error"); btn.disabled = false; btn.textContent = "Save"; return; }
        if (data.autoSelectedEngine) {
          const statusEngine = document.getElementById("status-engine");
          if (statusEngine) statusEngine.textContent = ENGINE_DISPLAY_NAMES[data.autoSelectedEngine] || data.autoSelectedEngine;
        }
        clearWalkthroughParam();
        walkthrough.classList.add("hidden");
        options.classList.remove("hidden");
        initSetup();
      } catch (err) {
        await vibeAlert("Failed to save: " + err.message, "Error");
        btn.disabled = false;
        btn.textContent = "Save";
      }
    };
    btn.addEventListener("click", doSave);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  });

  // CLI tool action handlers
  content.querySelectorAll("[data-cli-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleCliAction(btn.dataset.cliEngine, btn.dataset.cliAction, btn));
  });

  // Skip
  document.getElementById("wt-skip").addEventListener("click", () => {
    clearWalkthroughParam();
    walkthrough.classList.add("hidden");
    options.classList.remove("hidden");
  });
}

/** Strip ?walkthrough from URL so re-init doesn't re-show it */
function clearWalkthroughParam() {
  const url = new URL(location.href);
  if (url.searchParams.has("walkthrough")) {
    url.searchParams.delete("walkthrough");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}

function cliToolRow(name, engineId, toolInfo) {
  let statusHtml, actionHtml;
  if (toolInfo.found && toolInfo.authenticated) {
    statusHtml = `<span class="walkthrough__tool-status walkthrough__tool-status--ok">Ready</span>`;
    actionHtml = `<button class="btn btn--sm btn--primary" data-cli-action="select" data-cli-engine="${engineId}">Use</button>`;
  } else if (toolInfo.found && !toolInfo.authenticated) {
    statusHtml = `<span class="walkthrough__tool-status walkthrough__tool-status--missing">Not signed in</span>`;
    actionHtml = `<button class="btn btn--sm btn--secondary" data-cli-action="auth" data-cli-engine="${engineId}">Sign in</button>`;
  } else {
    statusHtml = `<span class="walkthrough__tool-status walkthrough__tool-status--missing">Not installed</span>`;
    actionHtml = `<button class="btn btn--sm btn--secondary" data-cli-action="install" data-cli-engine="${engineId}">Install</button>`;
  }
  return `<div class="walkthrough__tool-item">
    <span class="settings__dot settings__dot--${toolInfo.found && toolInfo.authenticated ? "success" : toolInfo.found ? "warn" : "muted"}"></span>
    <span class="walkthrough__tool-name">${esc(name)}</span>
    ${statusHtml}
    ${actionHtml}
  </div>`;
}

async function handleCliAction(engineId, action, btn) {
  const toolMap = { "claude-code": "claude", "gemini-cli": "gemini", "codex-cli": "codex" };
  const tool = toolMap[engineId];
  if (!tool) return;

  if (action === "select") {
    // Already installed + authed, just select
    await fetch("/api/settings/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: engineId }),
    });
    const statusEngine = document.getElementById("status-engine");
    if (statusEngine) statusEngine.textContent = ENGINE_DISPLAY_NAMES[engineId] || engineId;
    clearWalkthroughParam();
    document.getElementById("walkthrough").classList.add("hidden");
    document.getElementById("setup-options").classList.remove("hidden");
    initSetup();
    return;
  }

  const endpoint = action === "install" ? "/api/settings/install" : "/api/settings/cli-auth";
  btn.disabled = true;
  const origText = btn.textContent;
  btn.innerHTML = '<span class="upload-spinner"></span>';

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool }),
    });
    const data = await res.json();
    if (data.jobId) {
      // Poll until complete
      await pollJob(data.jobId);
    }
    // Refresh walkthrough to show updated status
    showWalkthrough();
  } catch {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function pollJob(jobId) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch("/api/settings/job/" + jobId);
      const data = await res.json();
      if (data.status === "completed" || data.status === "failed") return;
    } catch { return; }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createTheme() {
  const name = document.getElementById("new-theme-name").value.trim();
  if (!name) {
    showError("Please enter a name for your theme.");
    return;
  }

  showLoading("Creating theme...");

  try {
    const res = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();

    if (data.error) {
      showError(data.error);
      return;
    }

    showApp(data.themeName);
  } catch (err) {
    showError("Failed to create theme: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Primary path: "Describe the landing page you want to build..."
// Creates a fresh theme and forwards the prompt to the chat once it connects.
// ---------------------------------------------------------------------------

function generateThemeNameFromPrompt(prompt) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  if (slug) return slug;
  return "page-" + Date.now().toString(36);
}

async function startFromPrompt() {
  const input = document.getElementById("setup-prompt-input");
  const submitBtn = document.getElementById("setup-prompt-submit");
  const prompt = (input?.value || "").trim();
  if (!prompt) {
    input?.focus();
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  const themeName = generateThemeNameFromPrompt(prompt);
  showLoading("Creating theme...");

  try {
    const createBody = { name: themeName };
    if (window.__pendingAssetType) createBody.assetType = window.__pendingAssetType;
    const res = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const data = await res.json();

    if (data.error) {
      showError(data.error);
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    // chat.js will pick this up on the next ws "init" message
    window.__pendingInitialPrompt = prompt;
    if (input) input.value = "";
    showAppDirect(data.themeName);
  } catch (err) {
    showError("Failed to create theme: " + err.message);
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Starter templates
// ---------------------------------------------------------------------------

let _startersCache = null;
let _selectedStarterId = null;

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function loadStarterGrid() {
  const grid = document.getElementById("starter-grid");
  if (!grid) return;

  if (_startersCache !== null) {
    renderStarterGrid(_startersCache);
    return;
  }

  try {
    const res = await fetch("/api/starters");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _startersCache = data.starters || [];
    renderStarterGrid(_startersCache);
  } catch {
    // API unavailable — attach click listeners to any hardcoded static cards
    grid.querySelectorAll(".starter-card").forEach((card) => {
      card.addEventListener("click", () => selectStarter(card.dataset.starterId));
    });
  }
}

function renderStarterGrid(starters) {
  const grid = document.getElementById("starter-grid");
  if (!grid) return;

  if (starters.length === 0) {
    grid.innerHTML = '<p class="setup__hint">No starter templates available.</p>';
    return;
  }

  const pageStarters = starters.filter((s) => s.contentType !== "email");
  const emailStarters = starters.filter((s) => s.contentType === "email");

  const renderCards = (list) => list.map((s) => `
    <div class="starter-card${_selectedStarterId === s.id ? " selected" : ""}" data-starter-id="${escHtml(s.id)}">
      <span class="starter-card__name">${escHtml(s.name)}</span>
      <span class="starter-card__desc">${escHtml(s.description)}</span>
      <span class="starter-card__meta">${s.moduleCount} modules</span>
    </div>
  `).join("");

  const renderGroup = (title, list) =>
    `<div class="starter-grid__group">
      <h4 class="starter-grid__heading">${escHtml(title)}</h4>
      <div class="starter-grid__section">${renderCards(list)}</div>
    </div>`;

  let html = "";
  if (_serverContentMode === "email") {
    if (emailStarters.length > 0) html += renderGroup("Email Templates", emailStarters);
    if (pageStarters.length > 0) html += renderGroup("Page Templates", pageStarters);
  } else {
    if (pageStarters.length > 0) html += renderGroup("Page Templates", pageStarters);
    if (emailStarters.length > 0) html += renderGroup("Email Templates", emailStarters);
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".starter-card").forEach((card) => {
    card.addEventListener("click", () => selectStarter(card.dataset.starterId));
  });
}

function selectStarter(id) {
  _selectedStarterId = id;
  const starter = (_startersCache || []).find((s) => s.id === id);
  if (!starter) return;

  document.querySelectorAll(".starter-card").forEach((c) => c.classList.toggle("selected", c.dataset.starterId === id));

  const createSection = document.getElementById("starter-create");
  const label = document.getElementById("starter-create-label");
  if (createSection && label) {
    label.textContent = `Create theme from "${starter.name}":`;
    createSection.classList.remove("hidden");
    setTimeout(() => document.getElementById("starter-theme-name")?.focus(), 50);
  }
}

async function createFromStarter() {
  if (!_selectedStarterId) return;
  const name = document.getElementById("starter-theme-name").value.trim();
  if (!name) {
    showError("Please enter a name for your theme.");
    return;
  }

  showLoading("Creating theme from template...");

  try {
    const res = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, starterId: _selectedStarterId }),
    });
    const data = await res.json();

    if (data.error) {
      showError(data.error);
      return;
    }

    showApp(data.themeName);
  } catch (err) {
    showError("Failed to create theme: " + err.message);
  }
}

async function fetchTheme() {
  const nameEl = document.getElementById("fetch-theme-name") || document.getElementById("dl-theme-name");
  const name = nameEl ? nameEl.value.trim() : "";
  if (!name) {
    showError("Please enter the theme name from your HubSpot account.");
    return;
  }

  showLoading("Fetching theme from HubSpot...");

  try {
    const res = await fetch("/api/setup/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();

    if (data.error) {
      showError(data.error);
      return;
    }

    showApp(data.themeName);
  } catch (err) {
    showError("Failed to fetch theme: " + err.message);
  }
}

let _openThemePromise = null;
async function openTheme(pathOrName) {
  // Deduplicate concurrent calls for the same theme
  if (_openThemePromise) return _openThemePromise;
  showLoading("Opening theme...");

  _openThemePromise = (async () => {
    try {
      const res = await fetch("/api/setup/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathOrName }),
      });
      const data = await res.json();

      if (data.error) {
        showError(data.error);
        return;
      }

      showApp(data.themeName);
    } catch (err) {
      showError("Failed to open theme: " + err.message);
    } finally {
      _openThemePromise = null;
    }
  })();

  return _openThemePromise;
}

async function resumeSession(sessionId) {
  showLoading("Resuming session...");

  try {
    const res = await fetch("/api/setup/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();

    if (data.error) {
      showError(data.error);
      return;
    }

    showApp(data.themeName);
  } catch (err) {
    showError("Failed to resume session: " + err.message);
  }
}

// API key management moved to settings panel (settings.js)

// ---------------------------------------------------------------------------
// UI transitions
// ---------------------------------------------------------------------------

let currentAppTheme = "";

function showApp(themeName) {
  // Route through dashboard instead of going directly to chat
  if (typeof showDashboard === "function") {
    currentAppTheme = themeName;
    showDashboard(themeName);
    updateRailActive();
  } else {
    // Fallback if dashboard.js not loaded
    showAppDirect(themeName);
  }
}

/**
 * Direct app view — shows chat screen without dashboard.
 * Used as fallback or when navigating from dashboard to a specific template.
 */
function showAppDirect(themeName) {
  if (typeof hideDashboard === "function") hideDashboard();
  appBody.dataset.mode = "editor";
  appScreen.classList.remove("hidden");
  document.getElementById("project-rail")?.setAttribute("data-mode", "editor");
  document.getElementById("theme-name").textContent = themeName;

  currentAppTheme = themeName;
  const target = "#/app/" + encodeURIComponent(themeName);
  if (location.hash !== target) {
    history.pushState(null, "", target);
  }

  if (typeof connectWebSocket === "function") {
    connectWebSocket();
  }
  if (typeof refreshPreview === "function") {
    refreshPreview();
  }
  updateRailActive();
}

function showSetup() {
  appScreen.classList.add("hidden");
  if (typeof hideDashboard === "function") hideDashboard();
  appBody.dataset.mode = "project-home";
  document.getElementById("project-rail")?.setAttribute("data-mode", "project-home");
  closeProjectSwitcher();
  currentAppTheme = "";

  hideLoading();
  updateRailActive();

  if (location.hash && location.hash !== "#/") {
    history.pushState(null, "", "#/");
  }

  initSetup();
}

// Editor back button → go back to setup
document.getElementById("editor-back")?.addEventListener("click", () => {
  showSetup();
});

// Logo click → go back to setup
document.querySelectorAll(".topbar__brand").forEach((el) => {
  el.style.cursor = "pointer";
  el.addEventListener("click", () => {
    if (appBody.dataset.mode === "editor") {
      showSetup();
    }
  });
});

function showLoading(text) {
  hideError();
  document.getElementById("setup-options").classList.add("hidden");
  document.getElementById("setup-loading").classList.remove("hidden");
  document.getElementById("setup-loading-text").textContent = text;
}

function hideLoading() {
  document.getElementById("setup-options").classList.remove("hidden");
  document.getElementById("setup-loading").classList.add("hidden");
}

function showError(message) {
  hideLoading();
  const el = document.getElementById("setup-error");
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 8000);
}

function hideError() {
  document.getElementById("setup-error").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Action button panel toggling
// ---------------------------------------------------------------------------

let activePanel = null;
let remoteThemesLoaded = false;

function togglePanel(action) {
  const panels = document.querySelectorAll(".setup__panel");
  const buttons = document.querySelectorAll(".setup__entry-card");

  // Close if same panel clicked
  if (activePanel === action) {
    panels.forEach((p) => p.classList.add("hidden"));
    buttons.forEach((b) => b.classList.remove("active"));
    activePanel = null;
    return;
  }

  // Hide all, show target
  panels.forEach((p) => p.classList.add("hidden"));
  buttons.forEach((b) => b.classList.remove("active"));

  const panelMap = { starter: "panel-starter", new: "panel-new", continue: "panel-continue", download: "panel-download", figma: "panel-figma", convert: "panel-convert" };
  const panel = document.getElementById(panelMap[action]);
  if (panel) {
    panel.classList.remove("hidden");
    activePanel = action;
  }

  // Mark card active
  const btn = document.querySelector(`.setup__entry-card[data-action="${action}"]`);
  if (btn) btn.classList.add("active");

  // Focus input if applicable
  if (action === "starter") loadStarterGrid();
  if (action === "new") setTimeout(() => document.getElementById("new-theme-name")?.focus(), 50);
  if (action === "convert") setTimeout(() => document.getElementById("import-url")?.focus(), 50);
  if (action === "figma") initFigmaPanel();

  // Load remote themes on first open
  if (action === "download" && !remoteThemesLoaded) loadDownloadPanel();

  // Populate continue panel
  if (action === "continue") populateContinuePanel();
}

let _bulkSelected = new Set();

function populateContinuePanel() {
  const container = document.getElementById("continue-projects");
  const empty = document.getElementById("continue-empty");
  if (!container) return;

  const projects = _allProjects;
  if (!projects || projects.length === 0) {
    container.innerHTML = "";
    _bulkSelected.clear();
    if (empty) empty.classList.remove("hidden");
    return;
  }

  if (empty) empty.classList.add("hidden");
  _bulkSelected.clear();

  const toolbar = document.createElement("div");
  toolbar.className = "projects-bulk-toolbar hidden";
  toolbar.id = "projects-bulk-toolbar";
  toolbar.innerHTML =
    `<span class="projects-bulk-toolbar__count" id="bulk-count">0 selected</span>` +
    `<button type="button" class="btn btn--sm btn--secondary" id="bulk-duplicate">Duplicate</button>` +
    `<button type="button" class="btn btn--sm btn--danger" id="bulk-delete">Delete</button>`;

  const table = document.createElement("table");
  table.className = "projects-table";
  table.innerHTML = `<thead><tr>
    <th class="projects-table__th-check"><input type="checkbox" id="bulk-select-all" class="projects-table__checkbox" title="Select all" /></th>
    <th>Name</th>
    <th>Pages</th>
    <th>Emails</th>
    <th>Modules</th>
    <th>Brand Assets</th>
    <th></th>
  </tr></thead>`;

  const tbody = document.createElement("tbody");
  for (const p of projects) {
    const tr = document.createElement("tr");
    tr.dataset.projectName = p.name;

    const checkTd = document.createElement("td");
    checkTd.className = "projects-table__td-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "projects-table__checkbox";
    cb.dataset.projectName = p.name;
    cb.addEventListener("change", () => {
      if (cb.checked) _bulkSelected.add(p.name);
      else _bulkSelected.delete(p.name);
      tr.classList.toggle("projects-table__row--selected", cb.checked);
      syncBulkToolbar();
    });
    checkTd.appendChild(cb);
    tr.appendChild(checkTd);

    const nameTd = document.createElement("td");
    nameTd.className = "projects-table__name";
    nameTd.textContent = p.name;
    tr.appendChild(nameTd);

    for (const val of [p.pageCount ?? 0, p.emailCount ?? 0, p.moduleCount ?? 0]) {
      const td = document.createElement("td");
      td.textContent = String(val);
      tr.appendChild(td);
    }

    const brandTd = document.createElement("td");
    brandTd.textContent = p.hasBrandAssets ? "✓" : "—";
    tr.appendChild(brandTd);

    const actionsCell = document.createElement("td");
    actionsCell.className = "projects-table__actions";
    tr.appendChild(actionsCell);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn--sm btn--primary";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => {
      if (typeof isStreaming !== "undefined" && isStreaming) {
        showError("Cannot switch projects while AI is generating.");
        return;
      }
      if (p.sessionId) resumeSession(p.sessionId);
      else openTheme(p.name);
    });
    actionsCell.appendChild(openBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn--sm btn--danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      confirmDeleteProject(p);
    });
    actionsCell.appendChild(delBtn);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.innerHTML = "";
  container.appendChild(toolbar);
  container.appendChild(table);

  const selectAll = document.getElementById("bulk-select-all");
  selectAll.addEventListener("change", () => {
    const cbs = container.querySelectorAll("tbody .projects-table__checkbox");
    cbs.forEach((c) => {
      c.checked = selectAll.checked;
      const name = c.dataset.projectName;
      const row = c.closest("tr");
      if (selectAll.checked) _bulkSelected.add(name);
      else _bulkSelected.delete(name);
      if (row) row.classList.toggle("projects-table__row--selected", selectAll.checked);
    });
    syncBulkToolbar();
  });

  document.getElementById("bulk-delete").addEventListener("click", () => bulkDeleteProjects());
  document.getElementById("bulk-duplicate").addEventListener("click", () => bulkDuplicateProjects());
}

function syncBulkToolbar() {
  const toolbar = document.getElementById("projects-bulk-toolbar");
  const countEl = document.getElementById("bulk-count");
  const selectAll = document.getElementById("bulk-select-all");
  if (!toolbar) return;

  const n = _bulkSelected.size;
  toolbar.classList.toggle("hidden", n === 0);
  if (countEl) countEl.textContent = `${n} selected`;

  if (selectAll) {
    const total = document.querySelectorAll("#continue-projects tbody .projects-table__checkbox").length;
    selectAll.checked = n > 0 && n === total;
    selectAll.indeterminate = n > 0 && n < total;
  }
}

function bulkDeleteProjects() {
  if (_bulkSelected.size === 0) return;
  const names = [..._bulkSelected];
  const projects = _allProjects.filter((p) => names.includes(p.name));

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-dialog__title">Delete ${projects.length} project${projects.length > 1 ? "s" : ""}?</div>
      <div class="confirm-dialog__detail">${projects.map((p) => `<strong>${esc(p.name)}</strong>`).join(", ")}</div>
      <label class="confirm-dialog__check">
        <input type="checkbox" id="confirm-bulk-delete-files" checked />
        <span>Also delete local files</span>
      </label>
      <p class="confirm-dialog__warn">Deleting local files cannot be undone.</p>
      <div class="confirm-dialog__actions">
        <button class="btn btn--secondary" id="confirm-bulk-cancel">Cancel</button>
        <button class="btn btn--danger" id="confirm-bulk-delete">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("confirm-bulk-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  document.getElementById("confirm-bulk-delete").addEventListener("click", async () => {
    const deleteFiles = document.getElementById("confirm-bulk-delete-files").checked;
    overlay.remove();

    for (const p of projects) {
      try {
        if (p.sessionId) {
          await fetch("/api/themes", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: p.sessionId, deleteFiles }),
          });
        } else if (deleteFiles) {
          await fetch("/api/themes/delete-local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ themeName: p.name }),
          });
        }
      } catch { /* continue deleting others */ }
    }
    _bulkSelected.clear();
    await initSetup();
    populateContinuePanel();
  });
}

async function bulkDuplicateProjects() {
  if (_bulkSelected.size === 0) return;
  const names = [..._bulkSelected];
  const projects = _allProjects.filter((p) => names.includes(p.name) && p.sessionId);

  if (projects.length === 0) {
    showError("Only saved projects can be duplicated.");
    return;
  }

  for (const p of projects) {
    try {
      await fetch("/api/themes/duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: p.sessionId }),
      });
    } catch { /* continue */ }
  }
  _bulkSelected.clear();
  await initSetup();
  populateContinuePanel();
}

async function loadDownloadPanel() {
  const accountEl = document.getElementById("dl-account");
  const accountName = document.getElementById("dl-account-name");
  const switchArea = document.getElementById("dl-account-switch");
  const inputRow = document.getElementById("dl-input-row");
  const hint = document.getElementById("dl-hint");
  const noAccount = document.getElementById("dl-no-account");

  accountEl.classList.add("hidden");
  switchArea.classList.add("hidden");
  inputRow.classList.add("hidden");
  hint.classList.add("hidden");
  noAccount.classList.add("hidden");

  // Fetch active account info to show portal name
  try {
    const statusRes = await fetch("/api/settings/status");
    const statusData = await statusRes.json();
    const accounts = statusData.config?.hubspotAccounts || [];
    const activeId = statusData.config?.activeHubSpotAccount;
    const active = accounts.find((a) => a.portalId === activeId) || accounts[0];

    if (active) {
      accountName.textContent = `${active.portalName || active.portalId} (${active.portalId})`;
      accountEl.classList.remove("hidden");
      inputRow.classList.remove("hidden");
      hint.classList.remove("hidden");

      // Wire up change button
      initDlAccountSwitch(accounts, activeId);
      remoteThemesLoaded = true;
    } else {
      noAccount.classList.remove("hidden");
    }
  } catch {
    noAccount.classList.remove("hidden");
  }
}

function initDlAccountSwitch(accounts, activeId) {
  const changeBtn = document.getElementById("dl-account-change");
  const switchArea = document.getElementById("dl-account-switch");

  // Remove old listener by replacing the element
  const newBtn = changeBtn.cloneNode(true);
  changeBtn.parentNode.replaceChild(newBtn, changeBtn);

  newBtn.addEventListener("click", () => {
    if (!switchArea.classList.contains("hidden")) { switchArea.classList.add("hidden"); return; }
    switchArea.classList.remove("hidden");

    let html = '<div style="display:flex;flex-direction:column;gap:6px">';
    for (const acct of accounts) {
      const isActive = acct.portalId === activeId;
      html += `<button class="btn btn--${isActive ? "primary" : "secondary"} dl-acct-btn" data-portal="${esc(acct.portalId)}" style="text-align:left;padding:6px 12px;font-size:13px">${esc(acct.portalName || acct.portalId)} (${esc(acct.portalId)})${isActive ? ' <span class="vs-icon-inline">' + vsIcon("check", {size: "sm"}) + '</span>' : ""}</button>`;
    }
    html += `<button class="btn btn--secondary dl-acct-btn" data-portal="__new" style="text-align:left;padding:6px 12px;font-size:13px">+ Add another account</button>`;
    html += '</div>';
    switchArea.innerHTML = html;

    switchArea.querySelectorAll(".dl-acct-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.portal;
        if (pid === "__new") {
          switchArea.classList.add("hidden");
          if (typeof openSettings === "function") openSettings();
          return;
        }
        if (pid === activeId) { switchArea.classList.add("hidden"); return; }
        await fetch("/api/settings/hs-switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portalId: pid }),
        });
        switchArea.classList.add("hidden");
        // Reload themes for the new account
        remoteThemesLoaded = false;
        loadDownloadPanel();
      });
    });
  });
}

async function downloadThemeByName() {
  const input = document.getElementById("dl-theme-name");
  const name = input.value.trim();
  if (!name) { showError("Enter a theme name."); return; }

  showLoading(`Downloading ${name} from HubSpot...`);

  try {
    const res = await fetch("/api/setup/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();

    if (data.error) { showError(data.error); return; }
    showApp(data.themeName);
  } catch (err) {
    showError("Failed to download theme: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Asset-type cards (guided entry — VIB-255). The "From Template" card opens
// the existing starter grid; "Import" shows source picker; others reveal a
// pre-scoped describe prompt.
document.querySelectorAll(".setup__type-card").forEach((card) => {
  card.addEventListener("click", () => {
    const action = card.dataset.action;
    if (action === "starter") {
      activePanel = null;
      togglePanel("starter");
      setTimeout(() => {
        document.getElementById("panel-starter")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 60);
      return;
    }
    const assetType = card.dataset.assetType;
    if (assetType === "import") {
      showImportSources();
      return;
    }
    showScopedPrompt(card);
  });
});

// "Back" link inside the scoped describe prompt restores the asset-type cards.
document.getElementById("setup-prompt-back")?.addEventListener("click", () => {
  showAssetTypeCards();
});

// Import source picker
function showImportSources() {
  const cards = document.getElementById("setup-type-cards");
  const importPanel = document.getElementById("setup-import-sources");
  const question = document.getElementById("setup-question");
  if (cards) cards.classList.add("hidden");
  if (question) question.classList.add("hidden");
  if (importPanel) importPanel.classList.remove("hidden");
}

document.getElementById("setup-import-back")?.addEventListener("click", () => {
  const importPanel = document.getElementById("setup-import-sources");
  if (importPanel) importPanel.classList.add("hidden");
  showAssetTypeCards();
});

document.querySelectorAll(".setup__import-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    const importPanel = document.getElementById("setup-import-sources");
    if (importPanel) importPanel.classList.add("hidden");
    showAssetTypeCards();
    togglePanel(action);
  });
});

// "View all" link in recent projects → open the full Continue panel
document.getElementById("setup-recent-all")?.addEventListener("click", () => {
  togglePanel("continue");
  setTimeout(() => {
    document.getElementById("panel-continue")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 60);
});

// Primary "describe-it" prompt
const promptInputEl = document.getElementById("setup-prompt-input");
const promptSubmitEl = document.getElementById("setup-prompt-submit");
if (promptInputEl && promptSubmitEl) {
  const syncSubmitState = () => {
    promptSubmitEl.disabled = promptInputEl.value.trim().length === 0;
  };
  promptInputEl.addEventListener("input", syncSubmitState);
  promptInputEl.addEventListener("keydown", (e) => {
    // ⌘/Ctrl + Enter submits; plain Enter inserts newline like a normal textarea.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!promptSubmitEl.disabled) startFromPrompt();
    }
  });
  promptSubmitEl.addEventListener("click", () => {
    if (!promptSubmitEl.disabled) startFromPrompt();
  });
  syncSubmitState();
  const shortcutEl = document.getElementById("setup-prompt-shortcut");
  if (shortcutEl && !/Mac|iPhone|iPad/.test(navigator.platform)) shortcutEl.textContent = "Ctrl+↩";
}

// Starter templates
document.getElementById("btn-create-from-starter").addEventListener("click", createFromStarter);
document.getElementById("starter-theme-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); createFromStarter(); }
});

// New theme
document.getElementById("btn-create-theme").addEventListener("click", createTheme);
document.getElementById("new-theme-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); createTheme(); }
});

// Download from HubSpot
document.getElementById("btn-fetch-theme").addEventListener("click", downloadThemeByName);
document.getElementById("dl-theme-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); downloadThemeByName(); }
});

// Settings link in download panel
const dlSettingsLink = document.getElementById("dl-open-settings");
if (dlSettingsLink) {
  dlSettingsLink.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });
}

// Import from GitHub / Lovable
document.getElementById("import-btn").addEventListener("click", async () => {
  const urlInput = document.getElementById("import-url");
  const url = urlInput.value.trim();
  if (!url) return;

  // Extract repo name to use as theme name
  const repoMatch = url.match(/(?:github\.com|lovable\.dev)\/[\w.-]+\/([\w.-]+)/);
  const themeName = repoMatch ? repoMatch[1].replace(/\.git$/, "") : "imported-project";

  showLoading(`Importing ${themeName}...`);
  urlInput.disabled = true;
  document.getElementById("import-btn").disabled = true;

  try {
    // First create the theme
    const setupRes = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: themeName }),
    });
    const setupData = await setupRes.json();
    if (setupData.error) {
      showError(`Failed to create theme: ${setupData.error}`);
      urlInput.disabled = false;
      document.getElementById("import-btn").disabled = false;
      return;
    }

    // Now import
    const importRes = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const importData = await importRes.json();
    if (importData.error) {
      showError(`Import failed: ${importData.error}`);
      urlInput.disabled = false;
      document.getElementById("import-btn").disabled = false;
      return;
    }

    // Show the app and send conversion prompt
    showApp(themeName);
    if (typeof sendMessage === "function" && importData.conversionPrompt) {
      sendMessage(importData.conversionPrompt);
    }
  } catch (err) {
    showError(`Import failed: ${err.message}`);
    urlInput.disabled = false;
    document.getElementById("import-btn").disabled = false;
  }
});
document.getElementById("import-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("import-btn").click(); }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Figma import
// ---------------------------------------------------------------------------

let figmaExtractionId = null;

async function initFigmaPanel() {
  const tokenPrompt = document.getElementById("figma-token-prompt");
  const urlSection = document.getElementById("figma-url-section");

  // Check if token is configured
  try {
    const res = await fetch("/api/settings/status");
    const data = await res.json();
    const hasToken = !!data.config?.figmaToken;
    tokenPrompt.classList.toggle("hidden", hasToken);
    urlSection.style.opacity = hasToken ? "1" : "0.5";
    urlSection.style.pointerEvents = hasToken ? "auto" : "none";
  } catch {
    tokenPrompt.classList.remove("hidden");
  }

  setTimeout(() => {
    const urlInput = document.getElementById("figma-url");
    if (urlInput && !urlInput.closest(".hidden")) urlInput.focus();
  }, 50);
}

// Inline token save
document.getElementById("figma-save-token")?.addEventListener("click", async () => {
  const input = document.getElementById("figma-inline-token");
  const token = input.value.trim();
  if (!token) return;
  const btn = document.getElementById("figma-save-token");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    await fetch("/api/settings/apikey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "figma", apiKey: token }),
    });
    input.value = "";
    btn.textContent = "Saved!";
    setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 1500);
    initFigmaPanel(); // refresh state
  } catch {
    btn.textContent = "Failed";
    setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 2000);
  }
});

// Settings link in Figma panel
document.getElementById("figma-open-settings")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (typeof openSettings === "function") openSettings("figma");
});

// Extract button
document.getElementById("figma-extract-btn")?.addEventListener("click", async () => {
  const urlInput = document.getElementById("figma-url");
  const url = urlInput.value.trim();
  if (!url) return;

  // Basic client-side validation
  if (!url.match(/figma\.com\/(design|file)\//)) {
    showError("Not a valid Figma URL. Expected: figma.com/design/...");
    return;
  }

  const btn = document.getElementById("figma-extract-btn");
  btn.disabled = true;
  btn.textContent = "Extracting...";
  urlInput.disabled = true;

  const progressEl = document.getElementById("figma-progress");
  progressEl.classList.remove("hidden");
  progressEl.innerHTML = `<span class="figma-progress__line">Connecting to Figma...</span>`;

  try {
    const res = await fetch("/api/figma/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "progress") {
            const span = document.createElement("span");
            span.className = "figma-progress__line";
            span.textContent = event.message;
            progressEl.appendChild(span);
            progressEl.scrollTop = progressEl.scrollHeight;
          } else if (event.type === "complete") {
            result = event;
          }
        } catch { /* skip malformed lines */ }
      }
    }

    if (!result || !result.ok) {
      showError(result?.error || "Extraction failed");
      btn.disabled = false;
      btn.textContent = "Extract";
      urlInput.disabled = false;
      return;
    }

    figmaExtractionId = result.extractionId;
    progressEl.classList.add("hidden");
    renderFigmaSummary(result.summary);

    // Auto-fill theme name from extraction summary
    const nameInput = document.getElementById("figma-theme-name");
    if (nameInput) {
      nameInput.value = result.summary.suggestedThemeName || result.summary.fileName
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 40) || "";
    }

    document.getElementById("figma-generate").classList.remove("hidden");
    btn.textContent = "Extracted";
  } catch (err) {
    showError("Extraction failed: " + err.message);
    btn.disabled = false;
    btn.textContent = "Extract";
    urlInput.disabled = false;
  }
});

function renderFigmaSummary(summary) {
  const container = document.getElementById("figma-summary");
  container.classList.remove("hidden");

  let html = `<div class="figma-summary">`;
  html += `<div class="figma-summary__title">${esc(summary.fileName)}</div>`;
  html += `<div class="figma-summary__stats">`;
  html += `<span>${summary.sectionCount} section${summary.sectionCount !== 1 ? "s" : ""}</span>`;
  html += `<span>${summary.assetCount} asset${summary.assetCount !== 1 ? "s" : ""}</span>`;
  html += `<span>${summary.fontFamilies?.length || 0} font${(summary.fontFamilies?.length || 0) !== 1 ? "s" : ""}</span>`;
  html += `</div>`;

  // Color swatches
  if (summary.colorPalette?.length) {
    html += `<div class="figma-swatches">`;
    for (const color of summary.colorPalette.slice(0, 8)) {
      html += `<span class="figma-swatch" style="background:${esc(color)}" title="${esc(color)}"></span>`;
    }
    html += `</div>`;
  }

  // Section names
  if (summary.sectionNames?.length) {
    html += `<div class="figma-summary__sections">`;
    for (const name of summary.sectionNames) {
      html += `<span class="figma-summary__section-tag">${esc(name)}</span>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

// Image mode toggle hint
document.getElementById("figma-use-assets")?.addEventListener("change", (e) => {
  const hint = document.getElementById("figma-image-hint");
  if (hint) {
    hint.textContent = e.target.checked
      ? "Images uploaded to HubSpot, no manual replacement needed"
      : "Image fields with placeholders, swap in HubSpot editor";
  }
});

// Generate button
document.getElementById("figma-generate-btn")?.addEventListener("click", () => {
  const nameInput = document.getElementById("figma-theme-name");
  const themeName = nameInput.value.trim();
  if (!themeName) { nameInput.focus(); return; }
  if (!figmaExtractionId) { showError("No extraction available — extract first"); return; }
  const useAssets = document.getElementById("figma-use-assets")?.checked ?? true;
  startFigmaImport(figmaExtractionId, themeName, useAssets);
});

document.getElementById("figma-theme-name")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("figma-generate-btn")?.click(); }
});

async function startFigmaImport(extractionId, themeName, useAssets = true) {
  // Disable generate button
  const genBtn = document.getElementById("figma-generate-btn");
  if (genBtn) { genBtn.disabled = true; genBtn.textContent = "Converting..."; }

  // Show progress in the same progress element
  const progressEl = document.getElementById("figma-progress");
  progressEl.classList.remove("hidden");
  progressEl.innerHTML = `<span class="figma-progress__line">Creating theme...</span>`;

  // 1. Create theme on server first
  try {
    const res = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: themeName }),
    });
    const data = await res.json();
    if (data.error) {
      showError(data.error);
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = "Generate Page"; }
      return;
    }
  } catch (err) {
    showError("Failed to create theme: " + err.message);
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = "Generate Page"; }
    return;
  }

  // 2. Run pipeline via SSE — stay on setup screen
  try {
    const res = await fetch("/api/figma/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extractionId, themeName, useAssets }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "progress") {
            const span = document.createElement("span");
            span.className = "figma-progress__line";
            span.textContent = event.message;
            progressEl.appendChild(span);
            progressEl.scrollTop = progressEl.scrollHeight;
          } else if (event.type === "complete") {
            result = event;
          }
        } catch { /* skip malformed */ }
      }
    }

    if (!result || !result.ok) {
      showError(result?.error || "Conversion failed");
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = "Generate Page"; }
      return;
    }

    // 3. Done — navigate directly to chat (skip dashboard)
    if (genBtn) genBtn.textContent = "Done!";
    setTimeout(() => showAppDirect(themeName), 500);
  } catch (err) {
    showError("Conversion failed: " + err.message);
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = "Generate Page"; }
  }
}

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 7) return days + "d ago";
  return new Date(timestamp).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Hash router — enables bookmarks and browser back/forward
// ---------------------------------------------------------------------------

function handleRoute() {
  const hash = location.hash || "#/";

  // #/app/{themeName}/{templateId} → open specific template in chat
  const appTemplateMatch = hash.match(/^#\/app\/([^/]+)\/(.+)$/);
  if (appTemplateMatch) {
    const themeName = decodeURIComponent(appTemplateMatch[1]);
    const templateId = decodeURIComponent(appTemplateMatch[2]);
    if (currentAppTheme === themeName && appBody.dataset.mode === "editor") return;
    // Open theme then activate template
    openTheme(themeName).then(() => {
      if (typeof showChat === "function") {
        showChat(themeName, templateId);
      }
    });
    return;
  }

  // #/app/{themeName} → open theme (goes to dashboard or direct)
  const appMatch = hash.match(/^#\/app\/([^/]+)$/);
  if (appMatch) {
    const themeName = decodeURIComponent(appMatch[1]);
    if (currentAppTheme === themeName && appBody.dataset.mode === "editor") return;
    openTheme(themeName);
    return;
  }

  // #/dashboard/{themeName} → show editor for theme
  const dashMatch = hash.match(/^#\/dashboard\/(.+)$/);
  if (dashMatch) {
    const themeName = decodeURIComponent(dashMatch[1]);
    if (currentDashboardTheme === themeName && appBody.dataset.mode === "editor") return;
    openTheme(themeName);
    return;
  }

  // Default: show setup
  if (appBody.dataset.mode === "editor") {
    showSetup();
  }
}

// ---------------------------------------------------------------------------
// Initialize — check URL hash first, fall back to setup screen
// ---------------------------------------------------------------------------

let _initialized = false;
window.addEventListener("popstate", () => { if (_initialized) handleRoute(); });

// Always initialize setup (loads project rail, engine status, etc.)
// then handle the hash route if present.
initSetup().then(() => {
  _initialized = true;
  if (location.hash && (location.hash.startsWith("#/app/") || location.hash.startsWith("#/dashboard/"))) {
    handleRoute();
  }
});
