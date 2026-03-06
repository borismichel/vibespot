/* Theme init — runs synchronously before DOM to prevent flash */
(function initTheme() {
  const stored = localStorage.getItem("vibespot-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = stored || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("vibespot-theme", next);
}

/**
 * Setup screen — onboarding flow in the browser.
 * Handles theme creation, fetching, opening, and session resume.
 */

const setupScreen = document.getElementById("setup-screen");
const appScreen = document.getElementById("app-screen");

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
    // Show loading spinner in rail while fetching
    const railItems = document.getElementById("project-rail-items");
    if (railItems) {
      railItems.innerHTML = `
        <div class="project-rail__loading">
          <div class="setup__spinner"></div>
          <span>Loading projects...</span>
        </div>`;
    }

    const res = await fetch("/api/setup");
    const info = await res.json();

    // Populate the project rail with all projects
    populateProjectRail(info);

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

    // Check if we should show the walkthrough (fresh environment)
    // Add ?walkthrough to URL to force-show it for testing
    if (new URLSearchParams(location.search).has("walkthrough") ||
        (!info.aiAvailable && info.sessions.length === 0 && info.localThemes.length === 0)) {
      showWalkthrough();
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
      });
    }
  }

  return projects;
}

// ---------------------------------------------------------------------------
// Collapsible Project Rail (expanded on setup, collapsed on dashboard/chat)
// ---------------------------------------------------------------------------

const railTooltip = document.getElementById("project-rail-tooltip");

function populateProjectRail(info) {
  const rail = document.getElementById("project-rail-items");
  const countEl = document.getElementById("rail-project-count");
  if (!rail) return;
  rail.innerHTML = "";

  const projects = deduplicateProjects(info);
  if (countEl) countEl.textContent = projects.length;

  if (projects.length === 0) {
    rail.innerHTML = '<div class="project-rail__empty">No projects yet.<br>Create one to get started.</div>';
    return;
  }

  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "project-rail__item";
    item.dataset.name = p.name;

    const initial = p.name.charAt(0).toUpperCase();
    const meta = p.updatedAt ? timeAgo(p.updatedAt) : "on disk";

    // Bubble (always visible — in collapsed mode this is the only thing shown)
    const bubble = document.createElement("div");
    bubble.className = "project-rail__item-bubble";
    bubble.textContent = initial;
    item.appendChild(bubble);

    // Info (visible when expanded via CSS)
    const infoEl = document.createElement("div");
    infoEl.className = "project-rail__item-info";
    infoEl.innerHTML = `
      <span class="project-rail__item-name">${esc(p.name)}</span>
      <span class="project-rail__item-meta">${meta}</span>`;
    item.appendChild(infoEl);

    // Double-click on name to rename
    const nameSpan = infoEl.querySelector(".project-rail__item-name");
    if (nameSpan) {
      nameSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startInlineRename(nameSpan, p);
      });
    }

    // Delete button (visible when expanded + hover)
    const delBtn = document.createElement("button");
    delBtn.className = "project-rail__item-delete";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete project";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteProject(p);
    });
    item.appendChild(delBtn);

    // Tooltip (only when collapsed — skip when expanded since name is visible)
    item.addEventListener("mouseenter", () => {
      const railEl = document.getElementById("project-rail");
      if (railEl && railEl.classList.contains("project-rail--expanded")) return;

      let stats = "";
      if (p.moduleCount != null) {
        stats = p.moduleCount + " module" + (p.moduleCount !== 1 ? "s" : "");
        if (p.templateCount > 1) stats += " \u00b7 " + p.templateCount + " templates";
        stats += p.updatedAt ? " \u00b7 " + timeAgo(p.updatedAt) : " \u00b7 on disk";
      } else {
        stats = p.updatedAt ? timeAgo(p.updatedAt) : "on disk";
      }

      railTooltip.innerHTML =
        '<div class="project-rail__tooltip-name">' + esc(p.name) + "</div>" +
        '<div class="project-rail__tooltip-stats">' + stats + "</div>";

      const rect = item.getBoundingClientRect();
      railTooltip.style.top = rect.top + "px";
      railTooltip.classList.add("project-rail__tooltip--visible");
    });

    item.addEventListener("mouseleave", () => {
      railTooltip.classList.remove("project-rail__tooltip--visible");
    });

    // Click to open (blocked while AI is generating)
    item.addEventListener("click", () => {
      if (typeof isStreaming !== "undefined" && isStreaming) {
        showError("Cannot switch projects while AI is generating.");
        return;
      }
      if (p.sessionId) resumeSession(p.sessionId);
      else openTheme(p.name);
    });

    rail.appendChild(item);
  }

  updateRailActive();
}

function updateRailActive() {
  const current = currentAppTheme || currentDashboardTheme || "";
  document.querySelectorAll(".project-rail__item").forEach((btn) => {
    btn.classList.toggle("project-rail__item--active", btn.dataset.name === current);
  });
}

// "+" button → go to setup
document.getElementById("project-rail-add")?.addEventListener("click", () => {
  showSetup();
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
  setupScreen.classList.add("hidden");
  document.getElementById("setup-topbar").classList.add("hidden");
  document.getElementById("project-rail")?.classList.remove("project-rail--expanded");
  if (typeof hideDashboard === "function") hideDashboard();
  appScreen.classList.remove("hidden");
  document.getElementById("theme-name").textContent = themeName;

  const urlEl = document.getElementById("browser-url");
  if (urlEl) urlEl.textContent = themeName + ".vibespot.app";

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
  setupScreen.classList.remove("hidden");
  document.getElementById("setup-topbar").classList.remove("hidden");
  document.getElementById("project-rail")?.classList.add("project-rail--expanded");
  currentAppTheme = "";

  hideLoading();
  updateRailActive();

  if (location.hash && location.hash !== "#/") {
    history.pushState(null, "", "#/");
  }

  initSetup();
}

// App back button → go back to dashboard from chat
document.getElementById("app-back")?.addEventListener("click", () => {
  if (currentAppTheme && typeof showDashboard === "function") {
    appScreen.classList.add("hidden");
    showDashboard(currentAppTheme);
  }
});

// Logo click → go back to setup (from dashboard)
document.querySelectorAll(".topbar__brand").forEach((el) => {
  el.style.cursor = "pointer";
  el.addEventListener("click", () => {
    const dashEl = document.getElementById("dashboard-screen");
    if (dashEl && !dashEl.classList.contains("hidden")) {
      showSetup();
      return;
    }
    // Fallback
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

  // #/app/{themeName}/{templateId} → open specific template in chat
  const appTemplateMatch = hash.match(/^#\/app\/([^/]+)\/(.+)$/);
  if (appTemplateMatch) {
    const themeName = decodeURIComponent(appTemplateMatch[1]);
    const templateId = decodeURIComponent(appTemplateMatch[2]);
    // Already showing this — nothing to do
    if (currentAppTheme === themeName && !appScreen.classList.contains("hidden")) return;
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
    if (currentAppTheme === themeName && !appScreen.classList.contains("hidden")) return;
    openTheme(themeName);
    return;
  }

  // #/dashboard/{themeName} → show dashboard for theme
  const dashMatch = hash.match(/^#\/dashboard\/(.+)$/);
  if (dashMatch) {
    const themeName = decodeURIComponent(dashMatch[1]);
    const dashEl = document.getElementById("dashboard-screen");
    if (currentDashboardTheme === themeName && dashEl && !dashEl.classList.contains("hidden")) return;
    openTheme(themeName);
    return;
  }

  // Default: show setup
  const dashEl = document.getElementById("dashboard-screen");
  if (!appScreen.classList.contains("hidden") || (dashEl && !dashEl.classList.contains("hidden"))) {
    showSetup();
  }
}

window.addEventListener("popstate", handleRoute);

// ---------------------------------------------------------------------------
// Initialize — check URL hash first, fall back to setup screen
// ---------------------------------------------------------------------------

if (location.hash && (location.hash.startsWith("#/app/") || location.hash.startsWith("#/dashboard/"))) {
  handleRoute();
} else {
  initSetup();
}
