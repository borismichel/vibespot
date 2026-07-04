import { SimpleCLIEngine } from "./cli-engine.js";

export class CodexCLIEngine extends SimpleCLIEngine {
  constructor() {
    super({
      binary: "codex",
      args: ["exec", "--full-auto"],
      progressMessage: "Running OpenAI Codex (this may take a few minutes)...",
      timeoutMs: 600_000,
    });
  }
}
