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

    // Check if we should show the walkthrough (fresh environment)
    // Add ?walkthrough to URL to force-show it for testing
    if (new URLSearchParams(location.search).has("walkthrough") ||
        (!info.aiAvailable && info.sessions.length === 0 && info.localThemes.length === 0)) {
      showWalkthrough();
      return;
    }

    // Track server content mode (email vs page)
    _serverContentMode = info.contentMode || "page";

    // Reset panel state
    remoteThemesLoaded = false;

    // Reset starter cache so each visit re-fetches from server
    _startersCache = null;

    // Auto-expand the starter template panel so templates are visible by default
    activePanel = null;
    togglePanel("starter");

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
// "Continue where you left off" — recent projects above the create options
// ---------------------------------------------------------------------------

const RECENT_PROJECTS_LIMIT = 4;

function populateRecentProjects(info) {
  const section = document.getElementById("setup-recent");
  const list = document.getElementById("setup-recent-list");
  const viewAll = document.getElementById("setup-recent-all");
  if (!section || !list) return;

  const projects = deduplicateProjects(info);
  if (projects.length === 0) {
    section.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  // Most recently updated first; locals (no updatedAt) follow
  const withTime = projects.filter((p) => p.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const withoutTime = projects.filter((p) => !p.updatedAt);
  const ordered = [...withTime, ...withoutTime];
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
        stats = p.moduleCount + " section" + (p.moduleCount !== 1 ? "s" : "");
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

// "+" button → open New Theme panel (return to Project Home if needed)
document.getElementById("project-rail-add")?.addEventListener("click", () => {
  if (typeof showProjectHome === "function") showProjectHome();
  togglePanel("new");
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
    const res = await fetch("/api/setup/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: themeName }),
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

  let html = "";
  if (_serverContentMode === "email") {
    if (emailStarters.length > 0) {
      html += `<h4 class="starter-grid__heading">Email Templates</h4>`;
      html += `<div class="starter-grid__section">${renderCards(emailStarters)}</div>`;
    }
    if (pageStarters.length > 0) {
      html += `<h4 class="starter-grid__heading">Page Templates</h4>`;
      html += `<div class="starter-grid__section">${renderCards(pageStarters)}</div>`;
    }
  } else {
    if (pageStarters.length > 0) {
      html += `<h4 class="starter-grid__heading">Page Templates</h4>`;
      html += `<div class="starter-grid__section">${renderCards(pageStarters)}</div>`;
    }
    if (emailStarters.length > 0) {
      html += `<h4 class="starter-grid__heading">Email Templates</h4>`;
      html += `<div class="starter-grid__section">${renderCards(emailStarters)}</div>`;
    }
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
// UI transitions — delegate to navigation.js (showProjectHome / showEditor /
// enterEditor). The legacy showApp/showAppDirect/showSetup names are kept as
// thin shims so existing call sites continue to work during the transition.
// ---------------------------------------------------------------------------

let currentAppTheme = "";

function showApp(themeName) {
  if (typeof enterEditor === "function") enterEditor(themeName);
}

function showAppDirect(themeName) {
  if (typeof enterEditor === "function") enterEditor(themeName, "pages");
}

function showSetup() {
  hideLoading();
  if (typeof showProjectHome === "function") showProjectHome();
}

// Logo click → return to Project Home from anywhere in Editor mode
document.querySelectorAll(".topbar__brand").forEach((el) => {
  el.style.cursor = "pointer";
  el.addEventListener("click", () => {
    if (typeof showProjectHome === "function") showProjectHome();
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
  const buttons = document.querySelectorAll(".setup__action-btn");

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

  // Mark button active
  const btn = document.querySelector(`.setup__action-btn[data-action="${action}"]`);
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

function populateContinuePanel() {
  const container = document.getElementById("continue-projects");
  const empty = document.getElementById("continue-empty");
  if (!container) return;

  // Gather projects from the rail
  const railItems = document.querySelectorAll(".project-rail__item");
  if (railItems.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  container.innerHTML = "";

  railItems.forEach((item) => {
    const name = item.dataset.name || item.querySelector(".project-rail__name")?.textContent || "";
    const sessionId = item.dataset.sessionId || "";
    const meta = item.querySelector(".project-rail__meta")?.textContent || "";

    const pill = document.createElement("button");
    pill.className = "setup__pill";
    pill.innerHTML = `<span>${esc(name)}</span>${meta ? `<span class="setup__pill__meta">${esc(meta)}</span>` : ""}`;
    pill.addEventListener("click", () => {
      if (sessionId) {
        resumeSession(sessionId);
      } else {
        openTheme(name);
      }
    });
    container.appendChild(pill);
  });
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
      html += `<button class="btn btn--${isActive ? "primary" : "secondary"} dl-acct-btn" data-portal="${esc(acct.portalId)}" style="text-align:left;padding:6px 12px;font-size:13px">${esc(acct.portalName || acct.portalId)} (${esc(acct.portalId)})${isActive ? " ✓" : ""}</button>`;
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

// Action buttons (advanced "More ways to start" panel)
document.querySelectorAll(".setup__action-btn").forEach((btn) => {
  btn.addEventListener("click", () => togglePanel(btn.dataset.action));
});

// Secondary "Start from Template" button — always opens, never toggles closed
document.querySelectorAll(".setup__secondary-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activePanel = null;
    togglePanel(btn.dataset.action);
    setTimeout(() => {
      document.getElementById("panel-starter")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
  });
});

// "More ways to start" toggle
function expandMoreOptions(expand) {
  const toggle = document.getElementById("setup-more-toggle");
  const panel = document.getElementById("setup-more-panel");
  if (!toggle || !panel) return;
  const willExpand = expand ?? panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !willExpand);
  toggle.setAttribute("aria-expanded", willExpand ? "true" : "false");
  toggle.classList.toggle("setup__more-toggle--open", willExpand);
}
document.getElementById("setup-more-toggle")?.addEventListener("click", () => expandMoreOptions());

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
// Hash router and screen boot live in navigation.js. We just kick off the
// initial Project Home data load (rail, engines, sessions) and let
// navigation.js choose which screen to render based on the URL.
// ---------------------------------------------------------------------------

initSetup().then(() => {
  if (typeof bootNavigation === "function") bootNavigation();
});
