/**
 * Settings panel — tabbed layout with AI, HubSpot, GitHub, vibeSpot tabs.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settingsData = null;
let activeTab = "ai";
const activePolls = {};

const ENGINE_LABELS = {
  "claude-code": "Claude Code",
  "anthropic-api": "Anthropic API",
  "claude-oauth": "Claude (OAuth)",
  "openai-api": "OpenAI API",
  "gemini-cli": "Gemini CLI",
  "gemini-api": "Gemini API",
  "codex-cli": "OpenAI Codex",
};

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

let _prevWorkspaceTab = "pages";

function openSettings(tab) {
  if (typeof closeMenu === "function") closeMenu();
  if (tab) {
    activeTab = tab;
    const tabs = document.querySelectorAll("#settings-tabs .settings__tab");
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  }
  const overlay = document.getElementById("settings-overlay");
  if (overlay) {
    overlay.classList.remove("hidden");
  } else if (typeof switchWorkspaceTab === "function") {
    const activeWs = document.querySelector(".workspace-tab.active");
    if (activeWs && activeWs.dataset.wsTab !== "settings") _prevWorkspaceTab = activeWs.dataset.wsTab;
    switchWorkspaceTab("settings");
  }
  refreshSettings();
}

function closeSettings() {
  const overlay = document.getElementById("settings-overlay");
  if (overlay) {
    overlay.classList.add("hidden");
  } else if (typeof switchWorkspaceTab === "function") {
    switchWorkspaceTab(_prevWorkspaceTab || "pages");
  }
  Object.keys(activePolls).forEach((id) => {
    clearInterval(activePolls[id]);
    delete activePolls[id];
  });
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function initTabs() {
  const tabs = document.querySelectorAll("#settings-tabs .settings__tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeTab = tab.dataset.tab;
      if (settingsData) renderSettings(settingsData);
    });
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
  body.innerHTML = "";

  switch (activeTab) {
    case "ai": renderAITab(body, data); break;
    case "hubspot": renderHubSpotTab(body, data); break;
    case "figma": renderFigmaTab(body, data); break;
    case "github": renderGitHubTab(body, data); break;
    case "vibespot": renderVibeSpotTab(body, data); break;
  }
}

// ---------------------------------------------------------------------------
// AI Tab
// ---------------------------------------------------------------------------

function renderAITab(body, data) {
  const env = data.environment;
  const config = data.config;

  // Engine selector
  const section = el("section", "settings__section");
  section.appendChild(sectionTitle("Engine"));
  section.appendChild(desc("Choose which AI engine generates your HubSpot modules. API engines need an API key. CLI engines need the tool installed on your system."));

  const selectEl = el("div", "settings__engine-select");
  const allEngines = [
    { id: "claude-code", label: "Claude Code" },
    { id: "anthropic-api", label: "Anthropic API" },
    { id: "claude-oauth", label: "Claude (OAuth)" },
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
    btn.addEventListener("click", () => setEngine(eng.id));
    selectEl.appendChild(btn);
  }
  section.appendChild(selectEl);

  // Model selector
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
    section.appendChild(modelRow);
  }

  body.appendChild(section);

  // Agentic Pipeline section
  const agenticSection = el("section", "settings__section");
  agenticSection.appendChild(sectionTitle("Agentic Pipeline"));

  const isCli = activeEngine && ["claude-code", "gemini-cli", "codex-cli"].includes(activeEngine);
  const agenticMode = config.agenticMode;

  if (isCli) {
    agenticSection.appendChild(desc("Decompose AI generation into specialized agents with per-module parallel calls. Better quality and structured output enforcement. CLI engines use subprocess calls — may be slower than API engines."));
  } else {
    agenticSection.appendChild(desc("Decompose AI generation into specialized agents with per-module parallel calls. Better quality and structured output enforcement."));
  }

  const toggleRow = el("div", "settings__toggle-row");
  const labelWrap = el("div", "");
  const label = el("div", "settings__toggle-label");
  label.textContent = "Enable Agentic Pipeline";
  labelWrap.appendChild(label);

  const sub = el("div", "settings__toggle-label-sub");
  if (agenticMode === true) {
    sub.textContent = "Active — multi-stage pipeline with parallel module generation";
    sub.style.color = "var(--success)";
  } else if (agenticMode === false) {
    sub.textContent = "Disabled — using single-call mode";
    sub.style.color = "var(--text-muted)";
  } else {
    sub.textContent = "Not configured — will be prompted on first generation";
    sub.style.color = "var(--warning)";
  }
  labelWrap.appendChild(sub);
  toggleRow.appendChild(labelWrap);

  const toggle = el("button", "settings__toggle" + (agenticMode === true ? " active" : ""));
  toggle.addEventListener("click", async () => {
    const newVal = agenticMode !== true;
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agenticMode: newVal }),
    });
    refreshSettings();
  });
  toggleRow.appendChild(toggle);
  agenticSection.appendChild(toggleRow);
  body.appendChild(agenticSection);

  // AI Capabilities section — exposes Anthropic SDK features (extended
  // thinking) and shows the status of features that auto-engage based on
  // engine (prompt caching).
  body.appendChild(renderAICapabilitiesSection(activeEngine, config));

  // API Keys section
  const keysSection = el("section", "settings__section");
  keysSection.appendChild(sectionTitle("API Keys"));
  keysSection.appendChild(desc("API keys are stored locally in ~/.vibespot/config.json and never sent anywhere except the provider\u2019s API."));

  const providers = [
    { key: "anthropic", name: "Anthropic", placeholder: "sk-ant-api03-..." },
    { key: "openai", name: "OpenAI", placeholder: "sk-..." },
    { key: "gemini", name: "Google AI", placeholder: "AIza..." },
  ];

  for (const prov of providers) {
    const keyInfo = env.apiKeys[prov.key];
    keysSection.appendChild(createApiKeyCard(prov.key, prov.name, prov.placeholder, keyInfo));
  }
  body.appendChild(keysSection);

  // Claude OAuth section
  const oauthSection = el("section", "settings__section");
  oauthSection.appendChild(sectionTitle("Claude OAuth"));
  oauthSection.appendChild(desc("Use your Claude Pro/Max subscription. Run `claude setup-token` in your terminal to get a token, then paste it below."));

  const oauthCard = el("div", "settings__card");
  const oauthInfo = env.tools?.claudeOAuth;

  if (oauthInfo?.authenticated) {
    const statusRow = el("div", "settings__card-row");
    const statusLabel = el("span", "settings__card-label");
    statusLabel.textContent = "Connected";
    statusLabel.style.color = "var(--vibe-green)";
    if (oauthInfo.expiresAt) {
      const hrs = Math.max(0, Math.round((new Date(oauthInfo.expiresAt) - Date.now()) / 3600000));
      statusLabel.textContent += ` (token expires in ${hrs}h)`;
    }
    statusRow.appendChild(statusLabel);

    const disconnectBtn = el("button", "btn btn--sm btn--danger");
    disconnectBtn.textContent = "Disconnect";
    disconnectBtn.addEventListener("click", async () => {
      await fetch("/api/settings/claude-oauth/logout", { method: "POST" });
      refreshSettings();
    });
    statusRow.appendChild(disconnectBtn);
    oauthCard.appendChild(statusRow);
  }

  const inputRow = el("div", "settings__card-row");
  inputRow.style.gap = "8px";
  const tokenInput = el("input", "settings__apikey-input");
  tokenInput.type = "password";
  tokenInput.placeholder = oauthInfo?.authenticated ? "••••••••••••• (saved)" : "sk-ant-oat01-...";
  inputRow.appendChild(tokenInput);

  const saveBtn = el("button", "btn btn--sm btn--primary");
  saveBtn.textContent = "Save Token";
  saveBtn.addEventListener("click", async () => {
    const token = tokenInput.value.trim();
    if (!token) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      const res = await fetch("/api/settings/claude-oauth/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token }),
      });
      const data = await res.json();
      if (data.ok) {
        tokenInput.value = "";
        refreshSettings();
      } else {
        alert(data.error || "Failed to save token");
      }
    } catch (err) {
      alert("Failed: " + err.message);
    }
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Token";
  });
  inputRow.appendChild(saveBtn);
  oauthCard.appendChild(inputRow);

  oauthSection.appendChild(oauthCard);
  body.appendChild(oauthSection);

  // CLI Tools section with toggles
  const cliSection = el("section", "settings__section");
  cliSection.appendChild(sectionTitle("CLI Tools"));
  cliSection.appendChild(desc("Enable CLI tools you have installed. Install status is only checked when you toggle a tool on, so disabled tools add zero overhead."));

  const cliTools = [
    { key: "claudeCode", id: "claude-code", name: "Claude Code", installId: "claude", url: "https://claude.ai/code" },
    { key: "geminiCli", id: "gemini-cli", name: "Gemini CLI", installId: "gemini", url: "https://github.com/google-gemini/gemini-cli" },
    { key: "codexCli", id: "codex-cli", name: "Codex CLI", installId: "codex", url: "https://github.com/openai/codex" },
  ];

  const enabledTools = config.enabledCLITools || [];

  for (const tool of cliTools) {
    const enabled = enabledTools.includes(tool.id);
    const info = env.tools[tool.key];
    const row = el("div", "settings__card");

    const toggleRow = el("div", "settings__toggle-row");
    const labelWrap = el("div", "");
    const label = el("div", "settings__toggle-label");
    label.textContent = tool.name;
    labelWrap.appendChild(label);

    if (enabled && info.found) {
      const sub = el("div", "settings__toggle-label-sub");
      sub.textContent = `v${info.version}` + (info.authenticated ? " \u2014 authenticated" : " \u2014 not authenticated");
      sub.style.color = info.authenticated ? "var(--success)" : "var(--warning)";
      labelWrap.appendChild(sub);
    } else if (enabled && !info.found) {
      const sub = el("div", "settings__toggle-label-sub");
      sub.textContent = "Not installed";
      sub.style.color = "var(--text-muted)";
      labelWrap.appendChild(sub);
    }

    toggleRow.appendChild(labelWrap);

    const toggle = el("button", "settings__toggle" + (enabled ? " active" : ""));
    toggle.addEventListener("click", async () => {
      const newVal = !enabled;
      await fetch("/api/settings/cli-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId: tool.id, enabled: newVal }),
      });
      refreshSettings();
    });
    toggleRow.appendChild(toggle);

    row.appendChild(toggleRow);

    // If enabled but not installed, show install button
    if (enabled && !info.found) {
      const installRow = el("div", "settings__card-row");
      const installBtn = el("button", "settings__btn settings__btn--primary");
      installBtn.textContent = "Install";
      installBtn.addEventListener("click", () => installTool(tool.installId, installBtn));
      installRow.appendChild(installBtn);
      if (tool.url) {
        const link = el("a", "settings__btn");
        link.textContent = "Docs";
        link.href = tool.url;
        link.target = "_blank";
        link.style.textDecoration = "none";
        installRow.appendChild(link);
      }
      row.appendChild(installRow);
    }

    // If enabled, installed, but not authenticated — show sign in
    if (enabled && info.found && !info.authenticated) {
      const authRow = el("div", "settings__card-row");
      const authBtn = el("button", "settings__btn settings__btn--primary");
      authBtn.textContent = "Sign in";
      authBtn.addEventListener("click", () => authCLI(tool.installId, authBtn));
      authRow.appendChild(authBtn);
      row.appendChild(authRow);
    }

    cliSection.appendChild(row);
  }
  body.appendChild(cliSection);
}

// ---------------------------------------------------------------------------
// AI Capabilities — feature toggles + capability status per engine
// ---------------------------------------------------------------------------

function renderAICapabilitiesSection(activeEngine, config) {
  const section = el("section", "settings__section");
  section.appendChild(sectionTitle("AI Capabilities"));
  section.appendChild(desc("Advanced model features. Some are configurable directly; some auto-engage based on the active engine."));

  // Engine classification — different engines have different feature surfaces.
  const isAnthropicAPI = activeEngine === "anthropic-api" || activeEngine === "claude-oauth";
  const isClaudeCode = activeEngine === "claude-code";
  const isAnthropicAny = isAnthropicAPI || isClaudeCode;

  // ---- Prompt Caching (auto on Anthropic engines — status indicator only) ----
  section.appendChild(capabilityRow({
    label: "Prompt Caching",
    description: isClaudeCode
      ? "Claude Code manages prompt caching internally — automatic, no configuration needed."
      : "System prompts and tool schemas cached on Anthropic. Automatic — no setup needed.",
    status: isAnthropicAny ? "active" : "n/a",
    statusText: isAnthropicAPI ? "Active" : isClaudeCode ? "Auto (CLI-managed)" : "Anthropic only",
  }));

  // ---- Extended Thinking (toggle + budget) ----
  const thinkingActive = !!config.extendedThinking && isAnthropicAPI;
  const thinkingRow = capabilityRow({
    label: "Extended Thinking",
    description: isClaudeCode
      ? "Claude Code uses thinking automatically when the model supports it. Budget can't be tuned via the CLI."
      : "The model deliberates internally before responding. Higher quality on the Page Architect stage; slower and slightly more expensive.",
    status: isAnthropicAPI ? (thinkingActive ? "active" : "off") : isClaudeCode ? "active" : "n/a",
    statusText: isAnthropicAPI
      ? thinkingActive ? "On" : "Off"
      : isClaudeCode ? "Auto (CLI-managed)" : "Anthropic only",
    toggle: isAnthropicAPI
      ? {
          active: thinkingActive,
          onChange: async (val) => {
            await fetch("/api/settings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ extendedThinking: val }),
            });
            refreshSettings();
          },
        }
      : null,
  });
  section.appendChild(thinkingRow);

  // Budget selector — only meaningful when thinking is enabled
  if (isAnthropicAPI && thinkingActive) {
    const budgetRow = el("div", "settings__capability-sub");
    const budgetLabel = el("span", "settings__capability-sub-label");
    budgetLabel.textContent = "Budget";
    budgetRow.appendChild(budgetLabel);

    const budgetSelect = el("select", "settings__capability-select");
    const budgets = [
      { id: "low", label: "Low (~4k tokens)" },
      { id: "medium", label: "Medium (~16k tokens)" },
      { id: "high", label: "High (~32k tokens)" },
    ];
    for (const b of budgets) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.label;
      if ((config.extendedThinkingBudget || "medium") === b.id) opt.selected = true;
      budgetSelect.appendChild(opt);
    }
    budgetSelect.addEventListener("change", async () => {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extendedThinkingBudget: budgetSelect.value }),
      });
      refreshSettings();
    });
    budgetRow.appendChild(budgetSelect);

    const hint = el("span", "settings__capability-sub-hint");
    hint.textContent = "Higher = more deliberation, more cost";
    budgetRow.appendChild(hint);

    section.appendChild(budgetRow);
  }

  // ---- Web Search (toggle on Anthropic API + Claude Code CLI) ----
  const webSearchSupported = isAnthropicAny;
  const webSearchActive = !!config.webSearch && webSearchSupported;
  section.appendChild(capabilityRow({
    label: "Web Search",
    description: isClaudeCode
      ? "Allow Claude Code to search the web (passes --allowed-tools WebSearch). Adds cost and may surface irrelevant results."
      : "Let the AI search the web for context (competitor pages, industry references) during planning. Adds cost and may surface irrelevant results.",
    status: !webSearchSupported ? "n/a" : webSearchActive ? "active" : "off",
    statusText: !webSearchSupported
      ? "Anthropic / Claude Code only"
      : webSearchActive ? "On" : "Off",
    toggle: webSearchSupported
      ? {
          active: webSearchActive,
          onChange: async (val) => {
            await fetch("/api/settings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ webSearch: val }),
            });
            refreshSettings();
          },
        }
      : null,
  }));

  // ---- Citations (auto-on for documents — status only) ----
  section.appendChild(capabilityRow({
    label: "Citations",
    description: "When you upload PDFs/docs, the model can cite specific passages it referenced.",
    status: "soon",
    statusText: "Coming soon",
  }));

  return section;
}

function capabilityRow({ label, description, status, statusText, toggle }) {
  const row = el("div", "settings__capability-row");

  const labelWrap = el("div", "settings__capability-label-wrap");
  const labelEl = el("div", "settings__capability-label");
  labelEl.textContent = label;
  const badge = el("span", "settings__capability-badge settings__capability-badge--" + status);
  badge.textContent = statusText;
  labelEl.appendChild(badge);
  labelWrap.appendChild(labelEl);

  const descEl = el("div", "settings__capability-desc");
  descEl.textContent = description;
  labelWrap.appendChild(descEl);

  row.appendChild(labelWrap);

  if (toggle) {
    const btn = el("button", "settings__toggle" + (toggle.active ? " active" : ""));
    btn.addEventListener("click", () => toggle.onChange(!toggle.active));
    row.appendChild(btn);
  }

  return row;
}

// ---------------------------------------------------------------------------
// Figma Tab
// ---------------------------------------------------------------------------

function renderFigmaTab(body, data) {
  const config = data.config;

  const section = el("section", "settings__section");
  section.appendChild(sectionTitle("Personal Access Token"));
  section.appendChild(desc("Connect your Figma account to import designs directly into HubSpot CMS sections. Tokens are stored locally and only used to call the Figma API."));

  const figmaToken = config.figmaToken;
  const figmaKeyInfo = {
    configured: !!figmaToken,
    masked: figmaToken || "",
  };
  section.appendChild(createApiKeyCard("figma", "Figma PAT", "figd_...", figmaKeyInfo));

  // Help link + Test Connection
  const actionsRow = el("div", "settings__card-row");
  actionsRow.style.paddingTop = "4px";
  const helpLink = el("a", "settings__btn");
  helpLink.textContent = "How to get a token";
  helpLink.href = "https://help.figma.com/hc/en-us/articles/8085703771159";
  helpLink.target = "_blank";
  helpLink.style.textDecoration = "none";
  helpLink.style.fontSize = "12px";
  actionsRow.appendChild(helpLink);

  const testBtn = el("button", "settings__btn settings__btn--small");
  testBtn.textContent = "Test Connection";
  testBtn.disabled = !figmaKeyInfo.configured;
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
    try {
      const res = await fetch("/api/figma/test-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await res.json();
      if (result.ok) {
        testBtn.textContent = "\u2713 Connected as " + result.user;
        testBtn.style.color = "var(--success)";
      } else {
        testBtn.textContent = "\u2717 " + (result.error || "Failed");
        testBtn.style.color = "var(--warning)";
      }
    } catch {
      testBtn.textContent = "\u2717 Connection failed";
      testBtn.style.color = "var(--warning)";
    }
    setTimeout(() => {
      testBtn.textContent = "Test Connection";
      testBtn.style.color = "";
      testBtn.disabled = !figmaKeyInfo.configured;
    }, 3000);
  });
  actionsRow.appendChild(testBtn);
  section.appendChild(actionsRow);
  body.appendChild(section);
}

// ---------------------------------------------------------------------------
// HubSpot Tab
// ---------------------------------------------------------------------------

function renderHubSpotTab(body, data) {
  const env = data.environment;
  const config = data.config;
  const hs = env.tools.hubspot;

  // Upload mode toggle
  const modeSection = el("section", "settings__section");
  modeSection.appendChild(sectionTitle("Upload Mode"));

  const currentMode = config.hubspotUploadMode || "api";
  const pills = el("div", "settings__mode-pills");

  const apiPill = el("button", "settings__mode-pill" + (currentMode === "api" ? " active" : ""));
  apiPill.textContent = "API (recommended)";
  apiPill.addEventListener("click", () => setHsMode("api"));
  pills.appendChild(apiPill);

  const cliPill = el("button", "settings__mode-pill" + (currentMode === "cli" ? " active" : ""));
  cliPill.textContent = "CLI (legacy)";
  cliPill.addEventListener("click", () => setHsMode("cli"));
  pills.appendChild(cliPill);

  modeSection.appendChild(pills);

  if (currentMode === "api") {
    modeSection.appendChild(desc("Uploads directly to HubSpot via API. No CLI installation needed. Supports parallel file uploads for faster deployments."));
  } else {
    modeSection.appendChild(desc("Uses the HubSpot CLI (hs command). Requires @hubspot/cli installed globally. Slower sequential uploads."));
  }

  body.appendChild(modeSection);

  // Accounts section
  const acctSection = el("section", "settings__section");
  acctSection.appendChild(sectionTitle("Accounts"));

  if (currentMode === "api") {
    acctSection.appendChild(desc("Connect HubSpot accounts with a Personal Access Key. Keys are stored locally and used to authenticate API requests."));

    const accounts = config.hubspotAccounts || [];
    if (accounts.length > 0) {
      for (const acct of accounts) {
        const isActive = acct.portalId === config.activeHubSpotAccount;
        const card = el("div", "settings__card");
        const row = el("div", "settings__card-row");
        row.appendChild(dot(isActive ? "success" : "muted"));
        const label = el("span", "settings__card-label");
        label.textContent = `${acct.portalName} (${acct.portalId})`;
        if (isActive) label.textContent += " \u2014 active";
        row.appendChild(label);

        const actions = el("span", "settings__card-actions");
        if (!isActive) {
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
        acctSection.appendChild(card);
      }
    } else {
      const empty = el("div", "settings__card");
      const emptyRow = el("div", "settings__card-row");
      emptyRow.appendChild(dot("muted"));
      const emptyLabel = el("span", "settings__card-label");
      emptyLabel.textContent = "No accounts connected";
      emptyRow.appendChild(emptyLabel);
      empty.appendChild(emptyRow);
      acctSection.appendChild(empty);
    }

    // Add account button + PAK input
    const addCard = el("div", "settings__card");
    const addRow = el("div", "settings__card-row");
    const addBtn = el("button", "settings__btn settings__btn--primary");
    addBtn.textContent = "Add Account";
    addBtn.addEventListener("click", () => showPakInput(addCard, addBtn));
    addRow.appendChild(addBtn);
    addCard.appendChild(addRow);
    acctSection.appendChild(addCard);
  } else {
    // CLI mode — show CLI status and accounts from hs accounts list
    acctSection.appendChild(desc("HubSpot CLI accounts are managed by the hs command. Use \u201chs auth\u201d to add accounts."));

    const cliCard = el("div", "settings__card");
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
    cliCard.appendChild(cliRow);
    acctSection.appendChild(cliCard);

    if (hs.found) {
      const accounts = hs.accounts || [];
      for (const acct of accounts) {
        const card = el("div", "settings__card");
        const row = el("div", "settings__card-row");
        row.appendChild(dot(acct.isDefault ? "success" : "muted"));
        const label = el("span", "settings__card-label");
        label.textContent = `${acct.name} (${acct.portalId})`;
        if (acct.isDefault) label.textContent += " \u2014 active";
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
        acctSection.appendChild(card);
      }

      const addRow2 = el("div", "settings__card");
      const addBtnRow = el("div", "settings__card-row");
      const addBtn2 = el("button", "settings__btn settings__btn--primary");
      addBtn2.textContent = "Add Account";
      addBtn2.addEventListener("click", () => startHsAuth(addBtn2, addRow2));
      addBtnRow.appendChild(addBtn2);
      addRow2.appendChild(addBtnRow);
      acctSection.appendChild(addRow2);
    }
  }

  body.appendChild(acctSection);
}

function showPakInput(container, addBtn) {
  // Hide the add button, show PAK input
  addBtn.style.display = "none";

  const instructions = el("div", "settings__instructions");
  instructions.innerHTML = `
    <strong>Connect your HubSpot account:</strong>
    <ol>
      <li>Open <a href="https://app.hubspot.com/l/personal-access-key" target="_blank" rel="noopener">HubSpot Personal Access Key</a></li>
      <li>Create a key with the <strong>Content</strong> scope enabled</li>
      <li>Copy the key and paste it below</li>
    </ol>
    <div class="settings__pak-row">
      <input type="password" class="settings__apikey-input" placeholder="Personal access key (pat-na1-...)" />
      <button class="settings__btn settings__btn--primary">Connect</button>
    </div>
  `;
  container.appendChild(instructions);

  const input = instructions.querySelector("input");
  const saveBtn = instructions.querySelector("button");
  input.focus();

  const doSave = async () => {
    const key = input.value.trim();
    if (!key) return;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="settings__spinner"></span> Validating...';

    try {
      const res = await fetch("/api/settings/hs-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personalAccessKey: key }),
      });
      const data = await res.json();
      if (data.ok) {
        refreshSettings();
      } else if (data.jobId) {
        pollJob(data.jobId, () => refreshSettings(), () => {
          saveBtn.textContent = "Failed";
          saveBtn.disabled = false;
        });
      } else {
        saveBtn.textContent = data.error || "Failed";
        saveBtn.disabled = false;
        setTimeout(() => { saveBtn.textContent = "Connect"; }, 2000);
      }
    } catch {
      saveBtn.textContent = "Failed";
      setTimeout(() => { saveBtn.textContent = "Connect"; saveBtn.disabled = false; }, 2000);
    }
  };

  saveBtn.addEventListener("click", doSave);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSave(); }
  });
}

// ---------------------------------------------------------------------------
// GitHub Tab
// ---------------------------------------------------------------------------

function renderGitHubTab(body, data) {
  const gh = data.environment.tools.github;

  const section = el("section", "settings__section");
  section.appendChild(sectionTitle("GitHub CLI"));
  section.appendChild(desc("GitHub CLI enables pushing your theme to a repository. Optional \u2014 not needed for HubSpot deployment."));

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

  section.appendChild(card);
  body.appendChild(section);
}

// ---------------------------------------------------------------------------
// vibeSpot Tab
// ---------------------------------------------------------------------------

function renderVibeSpotTab(body, data) {
  const section = el("section", "settings__section");
  section.appendChild(sectionTitle("About"));
  section.appendChild(desc("General vibeSpot configuration and information."));

  const card = el("div", "settings__card");

  // Version
  const versionRow = el("div", "settings__card-row");
  const versionLabel = el("span", "settings__card-label");
  versionLabel.textContent = "Version";
  versionRow.appendChild(versionLabel);
  const versionVal = el("span", "settings__card-meta");
  versionVal.textContent = data.version || "dev";
  versionRow.appendChild(versionVal);

  const changelogBtn = el("button", "settings__btn settings__btn--small");
  changelogBtn.textContent = "Changelog";
  changelogBtn.style.marginLeft = "8px";
  changelogBtn.addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/changelog");
      const json = await resp.json();
      if (json.changelog) {
        vibeViewContent(json.changelog, "Changelog");
      } else {
        vibeAlert("Changelog not available.");
      }
    } catch {
      vibeAlert("Failed to load changelog.");
    }
  });
  versionRow.appendChild(changelogBtn);

  card.appendChild(versionRow);

  // Workspace
  const wsRow = el("div", "settings__card-row");
  const wsLabel = el("span", "settings__card-label");
  wsLabel.textContent = "Workspace";
  wsRow.appendChild(wsLabel);
  const wsVal = el("span", "settings__card-meta");
  wsVal.textContent = "~/vibespot-themes";
  wsVal.style.fontFamily = "var(--font-mono, monospace)";
  wsVal.style.fontSize = "11px";
  wsRow.appendChild(wsVal);
  card.appendChild(wsRow);

  // Session count
  if (data.sessionCount !== undefined) {
    const sessRow = el("div", "settings__card-row");
    const sessLabel = el("span", "settings__card-label");
    sessLabel.textContent = "Saved sessions";
    sessRow.appendChild(sessLabel);
    const sessVal = el("span", "settings__card-meta");
    sessVal.textContent = String(data.sessionCount);
    sessRow.appendChild(sessVal);
    card.appendChild(sessRow);
  }

  // Local themes count
  if (data.localThemeCount !== undefined) {
    const themeRow = el("div", "settings__card-row");
    const themeLabel = el("span", "settings__card-label");
    themeLabel.textContent = "Local themes";
    themeRow.appendChild(themeLabel);
    const themeVal = el("span", "settings__card-meta");
    themeVal.textContent = String(data.localThemeCount);
    themeRow.appendChild(themeVal);
    card.appendChild(themeRow);
  }

  section.appendChild(card);
  body.appendChild(section);
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

  const statusEngine = document.getElementById("status-engine");
  if (statusEngine) {
    statusEngine.textContent = ENGINE_LABELS[engineId] || engineId;
  }

  refreshSettings();
}

async function setHsMode(mode) {
  await fetch("/api/settings/hs-mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
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
    const res = await fetch("/api/settings/gh-logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.jobId) {
      pollJob(data.jobId, () => {
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

async function authCLI(cli, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="settings__spinner"></span>';

  try {
    const res = await fetch("/api/settings/cli-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cli }),
    });
    const data = await res.json();

    if (data.error) {
      btn.textContent = "Failed";
      setTimeout(() => { btn.textContent = "Sign in"; btn.disabled = false; }, 2000);
      return;
    }

    if (data.hint) {
      btn.innerHTML = '<span class="settings__spinner"></span> Check browser...';
    }

    if (data.jobId) {
      pollJob(data.jobId, () => refreshSettings(), () => {
        btn.textContent = "Failed \u2014 try again";
        btn.disabled = false;
      });
    } else {
      refreshSettings();
    }
  } catch {
    btn.textContent = "Failed";
    setTimeout(() => { btn.textContent = "Sign in"; btn.disabled = false; }, 2000);
  }
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
    const value = el("span", "settings__apikey-value");
    value.textContent = keyInfo.masked;
    card.appendChild(value);

    const actions = el("div", "settings__apikey-actions");

    const editBtn = el("button", "settings__btn");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
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
// Model selection helpers
// ---------------------------------------------------------------------------

function getModelsForEngine(engine) {
  if (settingsData && settingsData.models && settingsData.models[engine]) {
    return settingsData.models[engine];
  }
  switch (engine) {
    case "claude-code":
      return [
        { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ];
    case "anthropic-api":
    case "claude-oauth":
      return [
        { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      ];
    case "openai-api":
      return [
        { id: "gpt-5.5", label: "GPT-5.5 (default)" },
        { id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      ];
    case "gemini-cli":
    case "gemini-api":
      return [
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (default)" },
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      ];
    case "codex-cli":
      return [
        { id: "gpt-5.5", label: "GPT-5.5 (default)" },
        { id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
        { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
        { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
        { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
        { id: "codex-mini-latest", label: "Codex Mini (latest)" },
      ];
    default:
      return [];
  }
}

function getCurrentModel(engine, config) {
  switch (engine) {
    case "claude-code": return config.claudeCodeModel || "claude-sonnet-4-6";
    case "anthropic-api":
    case "claude-oauth": return config.anthropicApiModel || "claude-sonnet-4-6";
    case "openai-api": return config.openaiApiModel || "gpt-5.5";
    case "codex-cli": return config.codexCliModel || "gpt-5.5";
    case "gemini-cli": return config.geminiCliModel || "gemini-2.5-pro";
    case "gemini-api": return config.geminiApiModel || "gemini-2.5-pro";
    default: return null;
  }
}

async function setEngineModel(engine, model) {
  await fetch("/api/settings/engine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine, model }),
  });

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
  return el("span", `settings__dot settings__dot--${variant}`);
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

function desc(text) {
  const p = el("p", "settings__description");
  p.textContent = text;
  return p;
}

function escSettings(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

document.getElementById("btn-setup-settings")?.addEventListener("click", () => openSettings());

document.addEventListener("keydown", (e) => {
  const settingsTabActive = document.querySelector('.workspace-tab[data-ws-tab="settings"].active');
  if (e.key === "Escape" && settingsTabActive) {
    closeSettings();
  }
});

// Initialize tabs
initTabs();
