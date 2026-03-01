import { printBanner } from "../cli/banner.js";
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
import { loadConfig } from "../utils/config.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";

export async function doctorCommand(): Promise<void> {
  printBanner();
  await ui.intro("Environment Diagnostics");

  let issues = 0;

  // Node.js
  const node = detectNode();
  if (!node.found) {
    ui.logError("Node.js — not installed");
    ui.log("  Install from https://nodejs.org");
    issues++;
  } else if (!nodeVersionOk(node.version)) {
    ui.logWarn(`Node.js v${node.version} — too old (need 18+)`);
    ui.log("  Update at https://nodejs.org");
    issues++;
  } else {
    ui.logSuccess(`Node.js v${node.version}`);
  }

  // Git
  const git = detectGit();
  if (!git.found) {
    ui.logError("Git — not installed");
    ui.log("  Install from https://git-scm.com");
    issues++;
  } else {
    ui.logSuccess(`Git ${git.version}`);
  }

  // HubSpot CLI
  const hs = detectHubSpotCLI();
  if (!hs.found) {
    ui.logError("HubSpot CLI — not installed");
    ui.log("  Install: npm install -g @hubspot/cli");
    issues++;
  } else {
    ui.logSuccess(`HubSpot CLI v${hs.version}`);
  }

  // HubSpot auth
  const auth = detectHubSpotAuth();
  if (!auth.authenticated) {
    ui.logWarn("HubSpot — not authenticated");
    ui.log("  Run: hs init");
    issues++;
  } else {
    ui.logSuccess(
      `HubSpot portal${auth.portalName ? `: ${auth.portalName}` : ""} (ID: ${auth.portalId})`
    );
  }

  // AI engines
  const claude = detectClaudeCode();
  if (claude.found) {
    ui.logSuccess(`Claude Code ${claude.version} at ${claude.path}`);
  } else {
    ui.log(theme.muted("Claude Code — not installed"));
  }

  const gemini = detectGeminiCLI();
  if (gemini.found) {
    ui.logSuccess(`Gemini CLI ${gemini.version} at ${gemini.path}`);
  } else {
    ui.log(theme.muted("Gemini CLI — not installed"));
  }

  const codex = detectCodexCLI();
  if (codex.found) {
    ui.logSuccess(`OpenAI Codex ${codex.version} at ${codex.path}`);
  } else {
    ui.log(theme.muted("OpenAI Codex — not installed"));
  }

  // API key
  if (hasAnthropicKey()) {
    ui.logSuccess("Anthropic API key set");
  } else {
    ui.log(theme.muted("Anthropic API key — not set"));
  }

  // Config
  const config = loadConfig();
  const engineLabels: Record<string, string> = {
    "claude-code": "Claude Code",
    "api": "Anthropic API",
    "anthropic-api": "Anthropic API",
    "openai-api": "OpenAI API",
    "gemini-api": "Gemini API",
    "gemini-cli": "Gemini CLI",
    "codex-cli": "OpenAI Codex",
  };
  if (config.aiEngine) {
    ui.logSuccess(`AI engine: ${engineLabels[config.aiEngine] || config.aiEngine}`);
  }
  if (config.lastThemePath) {
    ui.log(theme.muted(`Last theme: ${config.lastThemePath}`));
  }

  // No AI option available
  if (!claude.found && !gemini.found && !codex.found && !hasAnthropicKey()) {
    ui.logWarn("No AI engine available");
    ui.log("  Option 1: Install Claude Code — https://claude.ai/code");
    ui.log("  Option 2: Install Gemini CLI — https://github.com/google-gemini/gemini-cli");
    ui.log("  Option 3: Install OpenAI Codex — https://github.com/openai/codex");
    ui.log("  Option 4: Set ANTHROPIC_API_KEY environment variable");
    issues++;
  }

  console.log();
  if (issues === 0) {
    await ui.outro("Everything looks good!");
  } else {
    await ui.outro(
      theme.warn(`${issues} issue${issues > 1 ? "s" : ""} found — see above`)
    );
  }
}
