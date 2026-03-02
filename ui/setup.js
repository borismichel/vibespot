/**
 * Setup screen — onboarding flow in the browser.
 * Handles theme creation, fetching, opening, and session resume.
 */

const setupScreen = document.getElementById("setup-screen");
const appScreen = document.getElementById("app-screen");

// ---------------------------------------------------------------------------
// Load setup info on page load
// ---------------------------------------------------------------------------

async function initSetup() {
  try {
    const res = await fetch("/api/setup");
    const info = await res.json();

    // Populate sidebar with all projects (sessions + local themes)
    populateSidebar(info);

    // Show environment alerts
    const alerts = document.getElementById("setup-alerts");
    alerts.innerHTML = ""; // Clear on re-init
    if (!info.aiAvailable) {
      alerts.innerHTML += `<div class="setup__alert setup__alert--warn">No AI engine configured. <a href="#" id="alert-setup-link">Set up an AI engine</a> to start building.</div>`;
      setTimeout(() => {
        const link = document.getElementById("alert-setup-link");
        if (link) link.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });
      }, 0);
    }

    // Check if we should show the walkthrough (fresh environment)
    if (!info.aiAvailable && info.sessions.length === 0 && info.localThemes.length === 0) {
      showWalkthrough(info);
      return;
    }

    // Show fetch section if hs is installed
    if (info.hsInstalled) {
      document.getElementById("section-fetch").classList.remove("hidden");
    }

  } catch (err) {
    showError("Could not connect to server. Is vibeSpot running?");
  }
}

// ---------------------------------------------------------------------------
// Sidebar — project list (like Lovable)
// ---------------------------------------------------------------------------

function populateSidebar(info) {
  const list = document.getElementById("sidebar-project-list");
  const countEl = document.getElementById("sidebar-project-count");
  list.innerHTML = "";

  // Build a combined, deduplicated list of projects
  const projects = [];
  const seen = new Set();

  // Add sessions first (most recent)
  for (const s of info.sessions || []) {
    if (!seen.has(s.themeName)) {
      seen.add(s.themeName);
      projects.push({
        name: s.themeName,
        type: "session",
        sessionId: s.id,
        updatedAt: s.updatedAt,
      });
    }
  }

  // Add local themes that aren't already sessions
  for (const name of info.localThemes || []) {
    if (!seen.has(name)) {
      seen.add(name);
      projects.push({ name, type: "local", sessionId: null, updatedAt: null });
    }
  }

  countEl.textContent = projects.length;

  if (projects.length === 0) {
    list.innerHTML = `<div class="setup-sidebar__empty">No projects yet.<br>Create one to get started.</div>`;
    return;
  }

  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "setup-sidebar__item";
    const initial = p.name.charAt(0).toUpperCase();
    const meta = p.updatedAt ? timeAgo(p.updatedAt) : "on disk";

    const openBtn = document.createElement("button");
    openBtn.className = "setup-sidebar__item-open";
    openBtn.innerHTML = `
      <div class="setup-sidebar__item-icon">${esc(initial)}</div>
      <div class="setup-sidebar__item-info">
        <span class="setup-sidebar__item-name">${esc(p.name)}</span>
        <span class="setup-sidebar__item-meta">${meta}</span>
      </div>
    `;
    openBtn.addEventListener("click", () => {
      if (p.sessionId) {
        resumeSession(p.sessionId);
      } else {
        openTheme(p.name);
      }
    });
    item.appendChild(openBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "setup-sidebar__item-delete";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete project";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteProject(p);
    });
    item.appendChild(delBtn);

    list.appendChild(item);
  }
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
// Guided walkthrough (first-run experience)
// ---------------------------------------------------------------------------

async function showWalkthrough(setupInfo) {
  const walkthrough = document.getElementById("walkthrough");
  const options = document.getElementById("setup-options");

  walkthrough.classList.remove("hidden");
  options.classList.add("hidden");

  // Fetch full environment status
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
  let step = 1;

  function renderProgress() {
    const progress = document.getElementById("walkthrough-progress");
    progress.innerHTML = "";
    for (let i = 1; i <= 3; i++) {
      const dot = document.createElement("div");
      dot.className = `walkthrough__step-dot${i < step ? " done" : i === step ? " active" : ""}`;
      dot.textContent = i < step ? "\u2713" : i;
      progress.appendChild(dot);
      if (i < 3) {
        const line = document.createElement("div");
        line.className = "walkthrough__step-line";
        progress.appendChild(line);
      }
    }
  }

  function renderStep() {
    renderProgress();
    const content = document.getElementById("walkthrough-content");

    if (step === 1) {
      // Environment check
      content.innerHTML = `
        <div class="walkthrough__step-title">Environment Check</div>
        <div class="walkthrough__step-desc">Let's see what tools you have installed.</div>
        <div class="walkthrough__tool-list">
          ${toolItem("Node.js", env.tools.node.found, env.tools.node.found ? `v${env.tools.node.version}` : "Not found")}
          ${toolItem("Git", env.tools.git.found, env.tools.git.found ? `v${env.tools.git.version}` : "Not found")}
          ${toolItem("HubSpot CLI", env.tools.hubspot.found, env.tools.hubspot.found ? `v${env.tools.hubspot.version}` : "Not installed")}
          ${toolItem("GitHub CLI", env.tools.github.found, env.tools.github.found ? `v${env.tools.github.version}` : "Not installed")}
        </div>
        <div class="walkthrough__actions">
          <button class="btn btn--primary" id="wt-next-1">Continue</button>
        </div>
      `;
      document.getElementById("wt-next-1").addEventListener("click", () => { step = 2; renderStep(); });

    } else if (step === 2) {
      // AI engine setup
      content.innerHTML = `
        <div class="walkthrough__step-title">Set Up an AI Engine</div>
        <div class="walkthrough__step-desc">vibeSpot needs an AI engine to generate HubSpot modules. Choose one:</div>
        <div class="walkthrough__tool-list">
          ${toolItem("Claude Code", env.tools.claudeCode.found, env.tools.claudeCode.found ? "Installed" : "Not installed")}
          ${toolItem("Gemini CLI", env.tools.geminiCli.found, env.tools.geminiCli.found ? "Installed" : "Not installed")}
          ${toolItem("Codex CLI", env.tools.codexCli.found, env.tools.codexCli.found ? "Installed" : "Not installed")}
          ${toolItem("Anthropic API Key", env.apiKeys.anthropic.configured, env.apiKeys.anthropic.configured ? "Configured" : "Not set")}
          ${toolItem("OpenAI API Key", env.apiKeys.openai.configured, env.apiKeys.openai.configured ? "Configured" : "Not set")}
          ${toolItem("Gemini API Key", env.apiKeys.gemini.configured, env.apiKeys.gemini.configured ? "Configured" : "Not set")}
        </div>
        <div class="walkthrough__actions">
          <button class="btn btn--primary" id="wt-open-settings">Open Settings to Configure</button>
          <button class="btn btn--secondary" id="wt-next-2">Skip for now</button>
        </div>
      `;
      document.getElementById("wt-open-settings").addEventListener("click", () => {
        if (typeof openSettings === "function") openSettings();
      });
      document.getElementById("wt-next-2").addEventListener("click", () => { step = 3; renderStep(); });

    } else if (step === 3) {
      // Ready
      const hasAI = env.availableEngines.length > 0;
      content.innerHTML = `
        <div class="walkthrough__step-title">${hasAI ? "Ready to Build!" : "Almost There"}</div>
        <div class="walkthrough__step-desc">
          ${hasAI
            ? "Your environment is configured. Create a new theme to get started."
            : "No AI engine is configured yet. You can still create a theme, but you'll need to set up an AI engine before chatting."}
        </div>
        <div class="walkthrough__actions">
          <button class="btn btn--primary" id="wt-finish">Start Building</button>
          ${!hasAI ? `<button class="btn btn--secondary" id="wt-back-settings">Configure AI</button>` : ""}
        </div>
      `;
      document.getElementById("wt-finish").addEventListener("click", () => {
        walkthrough.classList.add("hidden");
        options.classList.remove("hidden");
      });
      const backBtn = document.getElementById("wt-back-settings");
      if (backBtn) backBtn.addEventListener("click", () => {
        if (typeof openSettings === "function") openSettings();
      });
    }
  }

  renderStep();
}

function toolItem(name, ok, detail) {
  return `<div class="walkthrough__tool-item">
    <span class="settings__dot settings__dot--${ok ? "success" : "warn"}"></span>
    <span class="walkthrough__tool-name">${esc(name)}</span>
    <span class="walkthrough__tool-status walkthrough__tool-status--${ok ? "ok" : "missing"}">${esc(detail)}</span>
  </div>`;
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

async function fetchTheme() {
  const name = document.getElementById("fetch-theme-name").value.trim();
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

async function openTheme(pathOrName) {
  showLoading("Opening theme...");

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
  }
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
  setupScreen.classList.add("hidden");
  document.getElementById("setup-topbar").classList.add("hidden");
  appScreen.classList.remove("hidden");
  document.getElementById("theme-name").textContent = themeName;

  // Update browser chrome URL bar
  const urlEl = document.getElementById("browser-url");
  if (urlEl) urlEl.textContent = themeName + ".vibespot.app";

  // Push route (avoid duplicate pushes)
  currentAppTheme = themeName;
  const target = "#/app/" + encodeURIComponent(themeName);
  if (location.hash !== target) {
    history.pushState(null, "", target);
  }

  // Connect WebSocket (defined in chat.js)
  if (typeof connectWebSocket === "function") {
    connectWebSocket();
  }

  // Load initial preview
  if (typeof refreshPreview === "function") {
    refreshPreview();
  }
}

function showSetup() {
  appScreen.classList.add("hidden");
  setupScreen.classList.remove("hidden");
  document.getElementById("setup-topbar").classList.remove("hidden");
  currentAppTheme = "";

  // Clear any leftover loading state from previous navigation
  hideLoading();

  if (location.hash && location.hash !== "#/") {
    history.pushState(null, "", "#/");
  }

  // Re-fetch setup info to refresh sessions / themes
  initSetup();
}

// Logo click → go back to setup (home)
document.querySelectorAll(".topbar__brand").forEach((el) => {
  el.style.cursor = "pointer";
  el.addEventListener("click", () => {
    // Only navigate back if we're in the app screen
    if (!appScreen.classList.contains("hidden")) {
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
// Event listeners
// ---------------------------------------------------------------------------

document.getElementById("btn-create-theme").addEventListener("click", createTheme);
document.getElementById("new-theme-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); createTheme(); }
});

document.getElementById("btn-fetch-theme").addEventListener("click", fetchTheme);
document.getElementById("fetch-theme-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); fetchTheme(); }
});

document.getElementById("btn-open-theme").addEventListener("click", () => {
  openTheme(document.getElementById("open-theme-path").value.trim());
});
document.getElementById("open-theme-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("btn-open-theme").click(); }
});

// Import from GitHub (on setup screen)
document.getElementById("import-btn").addEventListener("click", async () => {
  const urlInput = document.getElementById("import-url");
  const url = urlInput.value.trim();
  if (!url) return;

  // Extract repo name to use as theme name
  const repoMatch = url.match(/github\.com\/[\w.-]+\/([\w.-]+)/);
  const themeName = repoMatch ? repoMatch[1].replace(/\.git$/, "") : "imported-project";

  showLoading(`Importing ${themeName}...`);
  urlInput.disabled = true;
  document.getElementById("import-btn").disabled = true;

  try {
    // First create the theme
    const setupRes = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeName }),
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

// API key is now handled in the settings panel (settings.js)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  // #/app/{themeName} → open that theme
  const appMatch = hash.match(/^#\/app\/(.+)$/);
  if (appMatch) {
    const themeName = decodeURIComponent(appMatch[1]);
    // Already showing this theme — nothing to do
    if (currentAppTheme === themeName && !appScreen.classList.contains("hidden")) return;
    // Try to open the theme
    openTheme(themeName);
    return;
  }

  // Default: show setup
  if (!appScreen.classList.contains("hidden")) {
    showSetup();
  }
}

window.addEventListener("popstate", handleRoute);

// ---------------------------------------------------------------------------
// Initialize — check URL hash first, fall back to setup screen
// ---------------------------------------------------------------------------

if (location.hash && location.hash.startsWith("#/app/")) {
  handleRoute();
} else {
  initSetup();
}
