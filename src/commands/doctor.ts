import { printBanner } from "../cli/banner.js";
import {
  detectNode,
  detectGit,
  detectHubSpotCLI,
  detectClaudeCode,
  detectGeminiCLI,
  detectCodexCLI,
  detectHubSpotAuth,
  nodeVersionOk,
  hsCliVersionOk,
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

  // HubSpot CLI (only needed for deployment)
  const hs = detectHubSpotCLI();
  if (!hs.found) {
    ui.logWarn("HubSpot CLI — not installed (only needed for deployment)");
    ui.log("  Install: npm install -g @hubspot/cli");
  } else if (!hsCliVersionOk(hs.version)) {
    ui.logWarn(`HubSpot CLI v${hs.version} — too old (need v8+)`);
    ui.log("  Update: npm install -g @hubspot/cli@latest");
    issues++;
  } else {
    ui.logSuccess(`HubSpot CLI v${hs.version}`);

    // HubSpot auth
    const auth = detectHubSpotAuth();
    if (!auth.authenticated) {
      ui.logWarn("HubSpot — not authenticated");
      ui.log("  Run: hs init");
    } else {
      ui.logSuccess(
        `HubSpot portal${auth.portalName ? `: ${auth.portalName}` : ""} (ID: ${auth.portalId})`
      );
    }
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

  // API keys
  const config = loadConfig();

  const anthropicKey = !!(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const openaiKey = !!(config.openaiApiKey || process.env.OPENAI_API_KEY);
  const geminiKey = !!(config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY);

  if (anthropicKey) ui.logSuccess("Anthropic API key configured");
  else ui.log(theme.muted("Anthropic API key — not set"));

  if (openaiKey) ui.logSuccess("OpenAI API key configured");
  else ui.log(theme.muted("OpenAI API key — not set"));

  if (geminiKey) ui.logSuccess("Google AI API key configured");
  else ui.log(theme.muted("Google AI API key — not set"));
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
  if (!claude.found && !gemini.found && !codex.found && !anthropicKey && !openaiKey && !geminiKey) {
    ui.logWarn("No AI engine available");
    ui.log("  Fastest: Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)");
    ui.log("  Or install: Claude Code — https://claude.ai/code");
    ui.log("             Gemini CLI — https://github.com/google-gemini/gemini-cli");
    ui.log("             Codex CLI — https://github.com/openai/codex");
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
