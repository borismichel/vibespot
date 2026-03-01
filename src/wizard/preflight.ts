import {
  detectNode,
  detectGit,
  detectHubSpotCLI,
  detectClaudeCode,
  detectGeminiCLI,
  detectCodexCLI,
  detectHubSpotAuth,
  hasAnthropicKey,
  nodeVersionOk,
} from "../utils/detect.js";
import { run, runPassthrough } from "../utils/shell.js";
import { saveConfig, loadConfig, type AIEngineType } from "../utils/config.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";

export interface PreflightResult {
  aiEngine: AIEngineType;
  model?: string;
  portalId: string;
  portalName: string;
}

export async function runPreflight(): Promise<PreflightResult> {
  await ui.intro("Checking your environment");

  // Node.js
  const node = detectNode();
  if (!node.found) {
    ui.logError("Node.js not found. Install it from https://nodejs.org");
    process.exit(1);
  }
  if (!nodeVersionOk(node.version)) {
    ui.logError(
      `Node.js ${node.version} is too old. Version 18+ required. Update at https://nodejs.org`
    );
    process.exit(1);
  }
  ui.logSuccess(`Node.js v${node.version}`);

  // Git
  const git = detectGit();
  if (!git.found) {
    ui.logError("Git not found. Install it from https://git-scm.com");
    process.exit(1);
  }
  ui.logSuccess(`Git ${git.version}`);

  // HubSpot CLI
  let hs = detectHubSpotCLI();
  if (!hs.found) {
    ui.logWarn("HubSpot CLI not found");
    await ui.note(
      "The HubSpot CLI is required to upload your theme.\nI'll install it for you now.",
      "Missing dependency"
    );

    const install = await ui.confirm({
      message: "Install HubSpot CLI globally?",
    });

    if (!install) {
      ui.logError(
        "HubSpot CLI is required. Install manually: npm install -g @hubspot/cli"
      );
      process.exit(1);
    }

    const s = await ui.spinner();
    s.start("Installing HubSpot CLI...");

    const result = run("npm install -g @hubspot/cli");
    if (!result.success) {
      s.stop("Failed to install HubSpot CLI");
      ui.logError("Try running manually: npm install -g @hubspot/cli");
      process.exit(1);
    }

    hs = detectHubSpotCLI();
    s.stop(`HubSpot CLI v${hs.version} installed`);
  } else {
    ui.logSuccess(`HubSpot CLI v${hs.version}`);
  }

  // HubSpot authentication
  let auth = detectHubSpotAuth();
  if (!auth.authenticated) {
    ui.logWarn("HubSpot not authenticated");
    await ui.note(
      "You need to connect the CLI to your HubSpot account.\nThis will open a browser window — log in and authorize.",
      "Authentication required"
    );

    const doAuth = await ui.confirm({ message: "Run `hs init` now?" });

    if (!doAuth) {
      ui.logError("HubSpot authentication is required. Run `hs init` manually.");
      process.exit(1);
    }

    const s = await ui.spinner();
    s.start("Waiting for HubSpot authentication...");

    const authOk = runPassthrough("hs init");
    if (!authOk) {
      s.stop("Authentication failed");
      ui.logError("HubSpot authentication failed. Try running `hs init` manually.");
      process.exit(1);
    }

    auth = detectHubSpotAuth();
    s.stop(
      `Connected to portal${auth.portalName ? `: ${auth.portalName}` : ""} (ID: ${auth.portalId})`
    );
  } else {
    ui.logSuccess(
      `HubSpot portal${auth.portalName ? `: ${auth.portalName}` : ""} (ID: ${auth.portalId})`
    );
  }

  // AI Engine selection
  const claude = detectClaudeCode();
  const gemini = detectGeminiCLI();
  const codex = detectCodexCLI();
  const hasKey = hasAnthropicKey();
  const config = loadConfig();

  const engineLabels: Record<AIEngineType, string> = {
    "claude-code": "Claude Code",
    "api": "Anthropic API",
    "anthropic-api": "Anthropic API",
    "openai-api": "OpenAI API",
    "gemini-api": "Gemini API",
    "gemini-cli": "Gemini CLI",
    "codex-cli": "OpenAI Codex",
  };

  let aiEngine: AIEngineType;
  const lastUsed = config.aiEngine;

  // Always build list of available engines
  const available: { value: AIEngineType; label: string; hint: string }[] = [];

  if (claude.found) {
    available.push({
      value: "claude-code",
      label: "Claude Code",
      hint: lastUsed === "claude-code"
        ? "last used — recommended"
        : "uses your existing Claude subscription — recommended",
    });
  }
  if (gemini.found) {
    available.push({
      value: "gemini-cli",
      label: "Gemini CLI",
      hint: lastUsed === "gemini-cli"
        ? "last used"
        : "uses your existing Gemini setup",
    });
  }
  if (codex.found) {
    available.push({
      value: "codex-cli",
      label: "OpenAI Codex",
      hint: lastUsed === "codex-cli"
        ? "last used"
        : "uses your existing OpenAI setup",
    });
  }
  if (hasKey) {
    available.push({
      value: "api",
      label: "Anthropic API",
      hint: lastUsed === "api"
        ? "last used"
        : "uses your API key",
    });
  }

  // Sort last-used engine to the top
  if (lastUsed) {
    available.sort((a, b) =>
      a.value === lastUsed ? -1 : b.value === lastUsed ? 1 : 0
    );
  }

  if (available.length === 1) {
    // Only one option — use it automatically
    aiEngine = available[0].value;
    ui.logSuccess(`AI engine: ${engineLabels[aiEngine]} (auto-detected)`);
  } else if (available.length > 1) {
    // Multiple available — always ask
    aiEngine = await ui.select({
      message: "Choose your AI engine:",
      options: available,
    });
  } else {
    // None available — guide the user
    await ui.note(
      "You need an AI coding assistant to power the conversion.\n\n" +
        `${theme.bold("Option 1:")} Install Claude Code ${theme.muted("(recommended)")}\n` +
        "  https://claude.ai/code\n\n" +
        `${theme.bold("Option 2:")} Install Gemini CLI\n` +
        "  https://github.com/google-gemini/gemini-cli\n\n" +
        `${theme.bold("Option 3:")} Install OpenAI Codex\n` +
        "  https://github.com/openai/codex\n\n" +
        `${theme.bold("Option 4:")} Set an Anthropic API key\n` +
        "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  (get one at https://console.anthropic.com)",
      "AI engine required"
    );

    aiEngine = await ui.select({
      message: "Which will you set up?",
      options: [
        {
          value: "claude-code" as const,
          label: "Claude Code",
          hint: "I'll install it now",
        },
        {
          value: "gemini-cli" as const,
          label: "Gemini CLI",
          hint: "I'll install it now",
        },
        {
          value: "codex-cli" as const,
          label: "OpenAI Codex",
          hint: "I'll install it now",
        },
        {
          value: "api" as const,
          label: "Anthropic API",
          hint: "I'll enter my key",
        },
      ],
    });

    if (aiEngine === "api") {
      const key = await ui.text({
        message: "Enter your Anthropic API key:",
        placeholder: "sk-ant-api03-...",
        validate: (v) =>
          v.startsWith("sk-ant-") ? undefined : "Key should start with sk-ant-",
      });
      process.env.ANTHROPIC_API_KEY = key;
      saveConfig({ anthropicApiKey: key });
    }
  }

  // Model selection for Claude Code
  let model: string | undefined;
  if (aiEngine === "claude-code") {
    model = await ui.select({
      message: "Which model?",
      options: [
        { value: "sonnet", label: "Sonnet", hint: "fast, recommended" },
        { value: "opus", label: "Opus", hint: "most capable" },
        { value: "haiku", label: "Haiku", hint: "fastest, cheapest" },
      ],
    });
  }

  saveConfig({ aiEngine });

  await ui.outro("Environment ready!");

  return {
    aiEngine,
    model,
    portalId: auth.portalId,
    portalName: auth.portalName,
  };
}
