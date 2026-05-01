/**
 * Navigation — owns the two-mode (Project Home + Editor) screen architecture
 * and the workspace tab layout introduced in VIB-187.
 *
 * Routes:
 *   #/home                                 → Project Home mode
 *   #/editor/{themeName}                   → Editor mode, default tab
 *   #/editor/{themeName}/{tab}             → Editor mode, specific tab
 *   tab ∈ {pages, brand, library, marketplace, settings}
 */

const WORKSPACE_TABS = ["pages", "brand", "library", "marketplace", "settings"];
const DEFAULT_WORKSPACE_TAB = "pages";
const TAB_STORAGE_PREFIX = "vibespot:lastTab:";

const appBody = document.getElementById("app-body");
const projectRail = document.getElementById("project-rail");
const projectHomeEl = document.getElementById("project-home");
const editorEl = document.getElementById("editor");

let currentEditorTheme = "";
let currentWorkspaceTab = DEFAULT_WORKSPACE_TAB;
let _navInitialized = false;

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

function setMode(mode) {
  if (!appBody) return;
  appBody.dataset.mode = mode;
  if (mode === "project-home") {
    projectRail?.classList.add("project-rail--expanded");
    projectHomeEl?.classList.remove("hidden");
    editorEl?.classList.add("hidden");
  } else {
    projectRail?.classList.remove("project-rail--expanded");
    projectHomeEl?.classList.add("hidden");
    editorEl?.classList.remove("hidden");
  }
}

function isEditorMode() {
  return appBody?.dataset.mode === "editor";
}

// ---------------------------------------------------------------------------
// Workspace tabs
// ---------------------------------------------------------------------------

function getStoredTab(theme) {
  if (!theme) return DEFAULT_WORKSPACE_TAB;
  try {
    const stored = localStorage.getItem(TAB_STORAGE_PREFIX + theme);
    return WORKSPACE_TABS.includes(stored) ? stored : DEFAULT_WORKSPACE_TAB;
  } catch {
    return DEFAULT_WORKSPACE_TAB;
  }
}

function setStoredTab(theme, tab) {
  if (!theme || !WORKSPACE_TABS.includes(tab)) return;
  try { localStorage.setItem(TAB_STORAGE_PREFIX + theme, tab); } catch { /* quota */ }
}

function applyTabClasses(tab) {
  document.querySelectorAll(".workspace-tab").forEach((btn) => {
    const isActive = btn.dataset.wsTab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".workspace-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.wsPanel === tab);
  });
}

function switchWorkspaceTab(tab, opts = {}) {
  if (!WORKSPACE_TABS.includes(tab)) tab = DEFAULT_WORKSPACE_TAB;
  if (!isEditorMode()) {
    // Tab clicks while in project-home shouldn't fight the mode; ignore.
    return;
  }
  const theme = currentEditorTheme;
  const previous = currentWorkspaceTab;
  currentWorkspaceTab = tab;
  applyTabClasses(tab);
  setStoredTab(theme, tab);

  if (!opts.skipHash) {
    syncEditorHash(theme, tab);
  }

  if (previous !== tab) onTabActivated(tab);
}

function onTabActivated(tab) {
  // Lazy-load tab content. Most renderers are defined in dashboard.js / settings.js.
  switch (tab) {
    case "brand":
    case "library":
      if (typeof refreshDashboard === "function") refreshDashboard();
      break;
    case "marketplace":
      if (typeof renderMarketplacePanel === "function") {
        const panel = document.getElementById("ws-panel-marketplace");
        if (panel) renderMarketplacePanel(panel);
      }
      break;
    case "settings":
      if (typeof refreshSettings === "function") refreshSettings();
      break;
  }
}

// Wire tab clicks once
document.querySelectorAll(".workspace-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchWorkspaceTab(btn.dataset.wsTab));
});

// ---------------------------------------------------------------------------
// Screen transitions
// ---------------------------------------------------------------------------

let _showEditorPromise = null;

function showProjectHome() {
  setMode("project-home");
  currentEditorTheme = "";
  if (typeof currentAppTheme !== "undefined") currentAppTheme = "";
  if (typeof currentDashboardTheme !== "undefined") currentDashboardTheme = "";
  if (typeof updateRailActive === "function") updateRailActive();
  if (typeof initSetup === "function") initSetup();
  syncHomeHash();
}

async function showEditor(themeName, tab) {
  if (!themeName) return;
  // Deduplicate concurrent transitions to the same theme
  if (_showEditorPromise && currentEditorTheme === themeName) return _showEditorPromise;

  const targetTab = tab && WORKSPACE_TABS.includes(tab) ? tab : getStoredTab(themeName);

  _showEditorPromise = (async () => {
    try {
      // Activate session/theme on the server if the active theme differs
      if (typeof currentAppTheme === "undefined" || currentAppTheme !== themeName) {
        try {
          const res = await fetch("/api/setup/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: themeName }),
          });
          const data = await res.json();
          if (data.error) {
            if (typeof showError === "function") showError(data.error);
            return;
          }
          themeName = data.themeName || themeName;
        } catch (err) {
          if (typeof showError === "function") showError("Failed to open theme: " + err.message);
          return;
        }
      }

      currentEditorTheme = themeName;
      if (typeof currentAppTheme !== "undefined") currentAppTheme = themeName;
      if (typeof currentDashboardTheme !== "undefined") currentDashboardTheme = themeName;

      const themeNameEl = document.getElementById("theme-name");
      if (themeNameEl) themeNameEl.textContent = themeName;
      const urlEl = document.getElementById("browser-url");
      if (urlEl) urlEl.textContent = themeName + ".vibespot.app";

      setMode("editor");
      switchWorkspaceTab(targetTab, { skipHash: true });
      syncEditorHash(themeName, targetTab);

      if (typeof connectWebSocket === "function") connectWebSocket();
      if (typeof refreshPreview === "function") refreshPreview();
      if (typeof updateRailActive === "function") updateRailActive();
    } finally {
      _showEditorPromise = null;
    }
  })();

  return _showEditorPromise;
}

// Direct entry from setup that already created/opened a theme — avoids
// re-hitting /api/setup/open. Used by createTheme(), createFromStarter(),
// startFromPrompt(), etc.
function enterEditor(themeName, tab) {
  const targetTab = tab && WORKSPACE_TABS.includes(tab) ? tab : getStoredTab(themeName);

  currentEditorTheme = themeName;
  if (typeof currentAppTheme !== "undefined") currentAppTheme = themeName;
  if (typeof currentDashboardTheme !== "undefined") currentDashboardTheme = themeName;

  const themeNameEl = document.getElementById("theme-name");
  if (themeNameEl) themeNameEl.textContent = themeName;
  const urlEl = document.getElementById("browser-url");
  if (urlEl) urlEl.textContent = themeName + ".vibespot.app";

  setMode("editor");
  switchWorkspaceTab(targetTab, { skipHash: true });
  syncEditorHash(themeName, targetTab);

  if (typeof connectWebSocket === "function") connectWebSocket();
  if (typeof refreshPreview === "function") refreshPreview();
  if (typeof updateRailActive === "function") updateRailActive();
}

// ---------------------------------------------------------------------------
// Hash routing
// ---------------------------------------------------------------------------

function syncHomeHash() {
  if (location.hash !== "#/home") {
    history.pushState(null, "", "#/home");
  }
}

function syncEditorHash(theme, tab) {
  if (!theme) return;
  const enc = encodeURIComponent(theme);
  const target = tab && tab !== DEFAULT_WORKSPACE_TAB
    ? `#/editor/${enc}/${encodeURIComponent(tab)}`
    : `#/editor/${enc}`;
  if (location.hash !== target) {
    history.pushState(null, "", target);
  }
}

function handleRoute() {
  const hash = location.hash || "#/home";

  // #/editor/{theme}/{tab}?
  const editorMatch = hash.match(/^#\/editor\/([^/]+)(?:\/([^/]+))?$/);
  if (editorMatch) {
    const themeName = decodeURIComponent(editorMatch[1]);
    const tab = editorMatch[2] ? decodeURIComponent(editorMatch[2]) : null;

    if (currentEditorTheme === themeName && isEditorMode()) {
      // Same theme — just update the active tab if needed
      if (tab && tab !== currentWorkspaceTab) switchWorkspaceTab(tab, { skipHash: true });
      return;
    }
    showEditor(themeName, tab);
    return;
  }

  if (hash === "#/home" || hash === "#/" || hash === "") {
    if (!isEditorMode()) return;
    showProjectHome();
    return;
  }

  // Legacy hashes: redirect rather than break bookmarks
  // #/dashboard/{name} → editor brand tab
  const legacyDashMatch = hash.match(/^#\/dashboard\/(.+)$/);
  if (legacyDashMatch) {
    showEditor(decodeURIComponent(legacyDashMatch[1]), "brand");
    return;
  }
  // #/app/{name}[/{templateId}] → editor pages tab (templateId becomes irrelevant)
  const legacyAppMatch = hash.match(/^#\/app\/([^/]+)/);
  if (legacyAppMatch) {
    showEditor(decodeURIComponent(legacyAppMatch[1]), "pages");
    return;
  }
  // Unknown hash — fall back to project home
  if (isEditorMode()) showProjectHome();
}

window.addEventListener("popstate", () => { if (_navInitialized) handleRoute(); });
window.addEventListener("hashchange", () => { if (_navInitialized) handleRoute(); });

// ---------------------------------------------------------------------------
// Editor back button (topbar) — return to project home
// ---------------------------------------------------------------------------

document.getElementById("editor-back")?.addEventListener("click", showProjectHome);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bootNavigation() {
  _navInitialized = true;
  const hash = location.hash || "";
  if (hash.startsWith("#/editor/") || hash.startsWith("#/app/") || hash.startsWith("#/dashboard/")) {
    handleRoute();
  } else {
    showProjectHome();
  }
}

// Expose globals so the legacy function names continue to resolve
window.showProjectHome = showProjectHome;
window.showEditor = showEditor;
window.enterEditor = enterEditor;
window.switchWorkspaceTab = switchWorkspaceTab;
window.bootNavigation = bootNavigation;
window.getCurrentEditorTab = () => currentWorkspaceTab;
window.getCurrentEditorTheme = () => currentEditorTheme;
