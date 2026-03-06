/**
 * Settings panel — environment detection, AI engine selection, API keys, tool install, auth flows.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settingsData = null;
const activePolls = {};

const ENGINE_LABELS = {
  "claude-code": "Claude Code",
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
  "gemini-cli": "Gemini CLI",
  "gemini-api": "Gemini API",
  "codex-cli": "OpenAI Codex",
};

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

function openSettings() {
  // Close menu if open
  if (typeof closeMenu === "function") closeMenu();
  document.getElementById("settings-overlay").classList.remove("hidden");
  refreshSettings();
}

function closeSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
  Object.keys(activePolls).forEach((id) => {
    clearInterval(activePolls[id]);
    delete activePolls[id];
  });
}

// ---------------------------------------------------------------------------
// Fetch and render
// ---------------------------------------------------------------------------

async function refreshSettings() {
  const body = document.getElementById("settings-body");
  body.innerHTML = `<div class="settings__loading"><div class="settings__spinner-lg"></div><span>Loading environment...</span></div>`;

  try {
    const res = await fetch("/api/settings/status");
    settingsData = await res.json();
    renderSettings(settingsData);
  } catch (err) {
    body.innerHTML = `<div class="settings__loading" style="color:var(--error)">Failed to load settings</div>`;
  }
}

function renderSettings(data) {
  const body = document.getElementById("settings-body");
  const env = data.environment;
  const config = data.config;

  body.innerHTML = "";

  // --- AI Engines section ---
  const aiSection = el("section", "settings__section");
  aiSection.appendChild(sectionTitle("AI Engine"));

  // Engine selector pills
  const selectEl = el("div", "settings__engine-select");
  const allEngines = [
    { id: "claude-code", label: "Claude Code" },
    { id: "anthropic-api", label: "Anthropic API" },
    { id: "openai-api", label: "OpenAI API" },
    { id: "gemini-cli", label: "Gemini CLI" },
    { id: "gemini-api", label: "Gemini API" },
    { id: "codex-cli", label: "Codex CLI" },
  ];

  for (const eng of allEngines) {
    const available = env.availableEngines.includes(eng.id);
    const btn = el("button", "settings__engine-option");
    btn.textContent = eng.label;
    btn.disabled = !available;
    if (config.aiEngine === eng.id) btn.classList.add("active");
    if (!config.aiEngine && available && env.availableEngines[0] === eng.id) {
      // Highlight first available if none selected
    }
    btn.addEventListener("click", () => setEngine(eng.id));
    selectEl.appendChild(btn);
  }
  aiSection.appendChild(selectEl);

  // Model selector (for the active engine)
  const activeEngine = config.aiEngine || (env.availableEngines.length > 0 ? env.availableEngines[0] : null);
  if (activeEngine) {
    const modelRow = el("div", "settings__model-row");
    const modelLabel = el("span", "settings__card-label");
    modelLabel.textContent = "Model";
    modelRow.appendChild(modelLabel);

    const modelSelect = el("select", "settings__model-select");
    const models = getModelsForEngine(activeEngine);
    const currentModel = getCurrentModel(activeEngine, config);

    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === currentModel) opt.selected = true;
      modelSelect.appendChild(opt);
    }

    // Custom model option
    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "Custom...";
    if (currentModel && !models.find((m) => m.id === currentModel)) {
      customOpt.selected = true;
    }
    modelSelect.appendChild(customOpt);

    modelSelect.addEventListener("change", async () => {
      if (modelSelect.value === "__custom__") {
        const custom = await vibePrompt("Enter model name");
        if (custom) setEngineModel(activeEngine, custom);
        else refreshSettings();
      } else {
        setEngineModel(activeEngine, modelSelect.value);
      }
    });

    modelRow.appendChild(modelSelect);
    aiSection.appendChild(modelRow);
  }

  // CLI tools subsection
  aiSection.appendChild(subsectionTitle("CLI Tools"));
  const cliTools = [
    { key: "claudeCode", name: "Claude Code", installId: "claude", url: "https://claude.ai/code" },
    { key: "geminiCli", name: "Gemini CLI", installId: "gemini", url: "https://github.com/google-gemini/gemini-cli" },
    { key: "codexCli", name: "Codex CLI", installId: "codex", url: "https://github.com/openai/codex" },
  ];

  for (const tool of cliTools) {
    const info = env.tools[tool.key];
    aiSection.appendChild(createToolCard(tool.name, info, tool.installId, tool.url));
  }

  // API keys subsection
  aiSection.appendChild(subsectionTitle("API Keys"));
  const providers = [
    { key: "anthropic", name: "Anthropic", placeholder: "sk-ant-api03-..." },
    { key: "openai", name: "OpenAI", placeholder: "sk-..." },
    { key: "gemini", name: "Google AI", placeholder: "AIza..." },
  ];

  for (const prov of providers) {
    const keyInfo = env.apiKeys[prov.key];
    aiSection.appendChild(createApiKeyCard(prov.key, prov.name, prov.placeholder, keyInfo));
  }

  body.appendChild(aiSection);

  // --- HubSpot section ---
  const hsSection = el("section", "settings__section");
  hsSection.appendChild(sectionTitle("HubSpot"));
  hsSection.appendChild(createHubSpotCard(env.tools.hubspot));
  body.appendChild(hsSection);

  // --- GitHub section ---
  const ghSection = el("section", "settings__section");
  ghSection.appendChild(sectionTitle("GitHub"));
  ghSection.appendChild(createGitHubCard(env.tools.github));
  body.appendChild(ghSection);
}

// ---------------------------------------------------------------------------
// Tool card
// ---------------------------------------------------------------------------

function createToolCard(name, info, installId, url) {
  const card = el("div", "settings__card");

  const row = el("div", "settings__card-row");

  if (info.found) {
    row.appendChild(dot(info.authenticated ? "success" : "warn"));
  } else {
    row.appendChild(dot("muted"));
  }

  const label = el("span", "settings__card-label");
  label.textContent = name;
  row.appendChild(label);

  if (info.found) {
    const meta = el("span", "settings__card-meta");
    meta.textContent = `v${info.version}`;
    row.appendChild(meta);
  } else {
    const installBtn = el("button", "settings__btn");
    installBtn.textContent = "Install";
    installBtn.addEventListener("click", () => installTool(installId, installBtn));
    row.appendChild(installBtn);

    if (url) {
      const link = el("a", "settings__btn");
      link.textContent = "Docs";
      link.href = url;
      link.target = "_blank";
      link.style.textDecoration = "none";
      row.appendChild(link);
    }
  }

  card.appendChild(row);

  // Auth action row for installed but not authenticated CLI tools
  if (info.found && !info.authenticated) {
    const authRow = el("div", "settings__card-row settings__card-row--sub");

    {
      // Claude Code / Gemini CLI — browser-based sign in
      const authLabel = el("span", "settings__card-meta");
      authLabel.textContent = info.authDetail || "Not authenticated";
      authLabel.style.color = "var(--warning, #f59e0b)";
      authRow.appendChild(authLabel);

      const authBtn = el("button", "settings__btn settings__btn--primary");
      authBtn.textContent = "Sign in";
      authBtn.addEventListener("click", () => authCLI(installId, authBtn));
      authRow.appendChild(authBtn);

      card.appendChild(authRow);
    }
  } else if (info.found && info.authenticated) {
    const authRow = el("div", "settings__card-row settings__card-row--sub");
    const authLabel = el("span", "settings__card-meta");
    authLabel.textContent = "Authenticated";
    authLabel.style.color = "var(--success, #22c55e)";
    authRow.appendChild(authLabel);
    card.appendChild(authRow);
  }

  return card;
}

// ---------------------------------------------------------------------------
// API key card
// ---------------------------------------------------------------------------

function createApiKeyCard(provider, name, placeholder, keyInfo) {
  const card = el("div", "settings__apikey-row");

  const label = el("span", "settings__apikey-label");
  label.textContent = name;
  card.appendChild(label);

  if (keyInfo.configured) {
    // Show masked key + edit/clear buttons
    const value = el("span", "settings__apikey-value");
    value.textContent = keyInfo.masked;
    card.appendChild(value);

    const actions = el("div", "settings__apikey-actions");

    const editBtn = el("button", "settings__btn");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      // Replace card content with input
      showApiKeyInput(card, provider, name, placeholder);
    });
    actions.appendChild(editBtn);

    const clearBtn = el("button", "settings__btn");
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", async () => {
      await fetch("/api/settings/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: null }),
      });
      refreshSettings();
    });
    actions.appendChild(clearBtn);

    card.appendChild(actions);
  } else {
    showApiKeyInput(card, provider, name, placeholder);
  }

  return card;
}

function showApiKeyInput(container, provider, name, placeholder) {
  // Clear existing content except label
  const label = container.querySelector(".settings__apikey-label");
  container.innerHTML = "";
  if (label) container.appendChild(label);
  else {
    const lbl = el("span", "settings__apikey-label");
    lbl.textContent = name;
    container.appendChild(lbl);
  }

  const input = el("input", "settings__apikey-input");
  input.type = "password";
  input.placeholder = placeholder;
  container.appendChild(input);

  const saveBtn = el("button", "settings__btn settings__btn--primary");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => saveApiKey(provider, input.value, saveBtn));
  container.appendChild(saveBtn);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
  });

  input.focus();
}

// ---------------------------------------------------------------------------
// HubSpot card
// ---------------------------------------------------------------------------

function createHubSpotCard(hs) {
  const card = el("div", "settings__card");

  // CLI status
  const cliRow = el("div", "settings__card-row");
  cliRow.appendChild(dot(hs.found ? "success" : "warn"));
  const cliLabel = el("span", "settings__card-label");
  cliLabel.textContent = "HubSpot CLI";
  cliRow.appendChild(cliLabel);

  if (hs.found) {
    const meta = el("span", "settings__card-meta");
    meta.textContent = `v${hs.version}`;
    cliRow.appendChild(meta);
  } else {
    const installBtn = el("button", "settings__btn");
    installBtn.textContent = "Install";
    installBtn.addEventListener("click", () => installTool("hubspot", installBtn));
    cliRow.appendChild(installBtn);
  }
  card.appendChild(cliRow);

  // Accounts list (if CLI is installed)
  if (hs.found) {
    const accounts = hs.accounts || [];

    if (accounts.length > 0) {
      // Show each account with switch/remove actions
      accounts.forEach((acct) => {
        const row = el("div", "settings__card-row");
        row.appendChild(dot(acct.isDefault ? "success" : "muted"));
        const label = el("span", "settings__card-label");
        label.textContent = `${acct.name} (${acct.portalId})`;
        if (acct.isDefault) label.textContent += " — active";
        row.appendChild(label);

        const actions = el("span", "settings__card-actions");

        if (!acct.isDefault) {
          const useBtn = el("button", "settings__btn settings__btn--small");
          useBtn.textContent = "Use";
          useBtn.addEventListener("click", () => switchHsAccount(acct.portalId, useBtn));
          actions.appendChild(useBtn);
        }

        const removeBtn = el("button", "settings__btn settings__btn--small settings__btn--danger");
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => removeHsAccount(acct.portalId, removeBtn));
        actions.appendChild(removeBtn);

        row.appendChild(actions);
        card.appendChild(row);
      });
    } else if (!hs.authenticated) {
      const authRow = el("div", "settings__card-row");
      authRow.appendChild(dot("warn"));
      const authLabel = el("span", "settings__card-label");
      authLabel.textContent = "Not authenticated";
      authRow.appendChild(authLabel);
      card.appendChild(authRow);
    }

    // "Add account" button (always available when CLI is installed)
    const addRow = el("div", "settings__card-row");
    const addBtn = el("button", "settings__btn settings__btn--primary");
    addBtn.textContent = "Add Account";
    addBtn.addEventListener("click", () => startHsAuth(addBtn, card));
    addRow.appendChild(addBtn);
    card.appendChild(addRow);
  }

  return card;
}

// ---------------------------------------------------------------------------
// GitHub card
// ---------------------------------------------------------------------------

function createGitHubCard(gh) {
  const card = el("div", "settings__card");

  // CLI status
  const cliRow = el("div", "settings__card-row");
  cliRow.appendChild(dot(gh.found ? "success" : "muted"));
  const cliLabel = el("span", "settings__card-label");
  cliLabel.textContent = "GitHub CLI";
  cliRow.appendChild(cliLabel);

  if (gh.found) {
    const meta = el("span", "settings__card-meta");
    meta.textContent = `v${gh.version}`;
    cliRow.appendChild(meta);
  } else {
    const installBtn = el("button", "settings__btn");
    installBtn.textContent = "Install";
    installBtn.addEventListener("click", () => installTool("gh", installBtn));
    cliRow.appendChild(installBtn);
  }
  card.appendChild(cliRow);

  // Auth status
  if (gh.found) {
    const authRow = el("div", "settings__card-row");
    authRow.appendChild(dot(gh.authenticated ? "success" : "muted"));
    const authLabel = el("span", "settings__card-label");
    authLabel.textContent = gh.authenticated
      ? `Logged in as ${gh.username}`
      : "Not authenticated";
    authRow.appendChild(authLabel);

    const actions = el("span", "settings__card-actions");

    if (gh.authenticated) {
      // Switch account = logout + login
      const switchBtn = el("button", "settings__btn settings__btn--small");
      switchBtn.textContent = "Switch";
      switchBtn.addEventListener("click", () => switchGhAccount(switchBtn));
      actions.appendChild(switchBtn);

      const logoutBtn = el("button", "settings__btn settings__btn--small settings__btn--danger");
      logoutBtn.textContent = "Log out";
      logoutBtn.addEventListener("click", () => logoutGh(logoutBtn));
      actions.appendChild(logoutBtn);
    } else {
      const authBtn = el("button", "settings__btn settings__btn--primary");
      authBtn.textContent = "Log in";
      authBtn.addEventListener("click", () => startGhAuth(authBtn));
      actions.appendChild(authBtn);
    }

    authRow.appendChild(actions);
    card.appendChild(authRow);
  }

  return card;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function setEngine(engineId) {
  await fetch("/api/settings/engine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine: engineId }),
  });

  // Update statusbar engine label
  const statusEngine = document.getElementById("status-engine");
  if (statusEngine) {
    statusEngine.textContent = ENGINE_LABELS[engineId] || engineId;
  }

  refreshSettings();
}

async function saveApiKey(provider, key, btn) {
  if (!key || !key.trim()) return;
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const res = await fetch("/api/settings/apikey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey: key.trim() }),
    });
    const data = await res.json();
    if (data.ok) {
      refreshSettings();
    } else {
      btn.textContent = "Error";
      setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 2000);
    }
  } catch {
    btn.textContent = "Error";
    setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 2000);
  }
}

async function installTool(toolId, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const res = await fetch("/api/settings/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: toolId }),
    });
    const data = await res.json();

    if (data.jobId) {
      pollJob(data.jobId, () => {
        refreshSettings();
      }, (err) => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

async function switchHsAccount(portalId, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const res = await fetch("/api/settings/hs-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portalId }),
    });
    const data = await res.json();
    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    } else {
      refreshSettings();
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

async function removeHsAccount(portalId, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const res = await fetch("/api/settings/hs-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portalId, action: "remove" }),
    });
    const data = await res.json();
    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    } else {
      refreshSettings();
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

async function logoutGh(btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const res = await fetch("/api/settings/gh-logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    } else {
      refreshSettings();
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

async function switchGhAccount(btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    // Logout first, then trigger login
    const res = await fetch("/api/settings/gh-logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.jobId) {
      pollJob(data.jobId, () => {
        // After logout completes, start login flow
        startGhAuth(btn);
      }, () => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

async function startHsAuth(btn, card) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const res = await fetch("/api/settings/hs-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const data = await res.json();

    if (data.needsKey) {
      // Show instructions to get a personal access key
      btn.textContent = "Connect";
      btn.disabled = false;

      const instructions = el("div", "settings__instructions");
      instructions.innerHTML = `
        <strong>Connect your HubSpot account:</strong>
        <ol>
          ${data.steps.map((s) => `<li>${escSettings(s)}</li>`).join("")}
        </ol>
        <a href="${escSettings(data.url)}" target="_blank">Open HubSpot &rarr;</a>
        <div class="settings__pak-row">
          <input type="password" class="settings__apikey-input" id="hs-pak-input" placeholder="Personal access key..." />
          <button class="settings__btn settings__btn--primary" id="hs-pak-save">Save</button>
        </div>
      `;
      card.appendChild(instructions);

      document.getElementById("hs-pak-save").addEventListener("click", async () => {
        const key = document.getElementById("hs-pak-input").value.trim();
        if (!key) return;
        const saveBtn = document.getElementById("hs-pak-save");
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="settings__spinner"></span>';

        const authRes = await fetch("/api/settings/hs-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personalAccessKey: key }),
        });
        const authData = await authRes.json();

        if (authData.jobId) {
          pollJob(authData.jobId, () => refreshSettings(), () => {
            saveBtn.textContent = "Failed";
            saveBtn.disabled = false;
          });
        } else {
          refreshSettings();
        }
      });
      return;
    }

    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

async function startGhAuth(btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span> Check browser...';

  try {
    const res = await fetch("/api/settings/gh-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    if (data.alreadyAuthenticated) {
      refreshSettings();
      return;
    }

    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed";
        btn.disabled = false;
      });
    }
  } catch {
    btn.textContent = "Failed";
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Job polling
// ---------------------------------------------------------------------------

function pollJob(jobId, onComplete, onError) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/settings/job/${jobId}`);
      const job = await res.json();

      if (job.status === "completed") {
        clearInterval(interval);
        delete activePolls[jobId];
        onComplete();
      } else if (job.status === "failed") {
        clearInterval(interval);
        delete activePolls[jobId];
        onError(job.output);
      }
    } catch {
      clearInterval(interval);
      delete activePolls[jobId];
      onError("Connection lost");
    }
  }, 2000);

  activePolls[jobId] = interval;
}

// ---------------------------------------------------------------------------
// CLI auth
// ---------------------------------------------------------------------------

async function authCLI(cli, btn, apiKey) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const payload = { cli };
    if (apiKey) payload.apiKey = apiKey;

    const res = await fetch("/api/settings/cli-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.error) {
      btn.textContent = "Failed";
      setTimeout(() => { btn.textContent = "Sign in"; btn.disabled = false; }, 2000);
      return;
    }

    if (data.hint) {
      // Show hint to user (e.g., check browser)
      btn.innerHTML = '<span class="settings__spinner"></span> Check browser...';
    }

    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed — try again";
        btn.disabled = false;
      });
    } else {
      // Immediate success (e.g., Codex API key saved)
      refreshSettings();
    }
  } catch {
    btn.textContent = "Failed";
    setTimeout(() => { btn.textContent = "Sign in"; btn.disabled = false; }, 2000);
  }
}

// ---------------------------------------------------------------------------
// Model selection helpers
// ---------------------------------------------------------------------------

function getModelsForEngine(engine) {
  // Use server-provided model catalog if available
  if (settingsData && settingsData.models && settingsData.models[engine]) {
    return settingsData.models[engine];
  }
  // Fallback to hardcoded defaults
  switch (engine) {
    case "claude-code":
      return [
        { id: "sonnet", label: "Claude Sonnet (default)" },
        { id: "opus", label: "Claude Opus" },
        { id: "haiku", label: "Claude Haiku" },
      ];
    case "anthropic-api":
      return [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ];
    case "openai-api":
      return [
        { id: "gpt-4o", label: "GPT-4o (default)" },
        { id: "gpt-4o-mini", label: "GPT-4o Mini" },
        { id: "o3", label: "o3" },
        { id: "o4-mini", label: "o4 Mini" },
      ];
    case "gemini-cli":
    case "gemini-api":
      return [
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (default)" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      ];
    case "codex-cli":
      return [
        { id: "o4-mini", label: "o4 Mini (default)" },
        { id: "o3", label: "o3" },
        { id: "gpt-4o", label: "GPT-4o" },
      ];
    default:
      return [];
  }
}

function getCurrentModel(engine, config) {
  switch (engine) {
    case "claude-code": return config.claudeCodeModel || "sonnet";
    case "anthropic-api": return config.anthropicApiModel || "claude-sonnet-4-6";
    case "openai-api": return config.openaiApiModel || "gpt-4o";
    default: return null;
  }
}

async function setEngineModel(engine, model) {
  await fetch("/api/settings/engine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine, model }),
  });

  // Update statusbar
  const statusEngine = document.getElementById("status-engine");
  if (statusEngine) {
    const label = ENGINE_LABELS[engine] || engine;
    statusEngine.textContent = label;
  }

  refreshSettings();
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function dot(variant) {
  const d = el("span", `settings__dot settings__dot--${variant}`);
  return d;
}

function sectionTitle(text) {
  const h = el("h3", "settings__section-title");
  h.textContent = text;
  return h;
}

function subsectionTitle(text) {
  const h = el("h4", "settings__subsection-title");
  h.textContent = text;
  return h;
}

function escSettings(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

document.getElementById("settings-close").addEventListener("click", closeSettings);
document.getElementById("settings-overlay").addEventListener("click", (e) => {
  if (e.target.id === "settings-overlay") closeSettings();
});

// Setup screen settings button
document.getElementById("btn-setup-settings").addEventListener("click", openSettings);

// Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("settings-overlay").classList.contains("hidden")) {
    closeSettings();
  }
});
