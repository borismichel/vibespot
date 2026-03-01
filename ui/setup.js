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

    // If there's already an active session, skip setup
    if (info.hasActiveSession) {
      showApp(info.activeSession.themeName);
      return;
    }

    // Show environment alerts
    const alerts = document.getElementById("setup-alerts");
    if (!info.aiAvailable) {
      alerts.innerHTML += `<div class="setup__alert setup__alert--warn">No AI engine configured. <a href="#" id="alert-setup-link">Set up an AI engine</a> to start building.</div>`;
      // Wire up alert link to open settings
      setTimeout(() => {
        const link = document.getElementById("alert-setup-link");
        if (link) link.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });
      }, 0);
    }

    // Always show settings link
    document.getElementById("setup-settings-link").classList.remove("hidden");

    // Check if we should show the walkthrough (fresh environment)
    if (!info.aiAvailable && info.sessions.length === 0 && info.localThemes.length === 0) {
      showWalkthrough(info);
      return;
    }

    // Show previous sessions
    if (info.sessions.length > 0) {
      const section = document.getElementById("section-recent");
      section.classList.remove("hidden");
      const container = document.getElementById("recent-sessions");

      for (const s of info.sessions) {
        const card = document.createElement("button");
        card.className = "setup__card";
        card.innerHTML = `
          <span class="setup__card-name">${esc(s.themeName)}</span>
          <span class="setup__card-meta">${timeAgo(s.updatedAt)}</span>
        `;
        card.addEventListener("click", () => resumeSession(s.id));
        container.appendChild(card);
      }
    }

    // Show local themes
    if (info.localThemes.length > 0) {
      const section = document.getElementById("section-local");
      section.classList.remove("hidden");
      const container = document.getElementById("local-themes");

      for (const name of info.localThemes) {
        const card = document.createElement("button");
        card.className = "setup__card";
        card.innerHTML = `<span class="setup__card-name">${esc(name)}</span>`;
        card.addEventListener("click", () => openTheme(name));
        container.appendChild(card);
      }
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

function showApp(themeName) {
  setupScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  document.getElementById("theme-name").textContent = themeName;

  // Connect WebSocket (defined in chat.js)
  if (typeof connectWebSocket === "function") {
    connectWebSocket();
  }

  // Load initial preview
  if (typeof refreshPreview === "function") {
    refreshPreview();
  }
}

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
// Initialize
// ---------------------------------------------------------------------------

initSetup();
