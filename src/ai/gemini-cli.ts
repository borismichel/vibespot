import { SimpleCLIEngine } from "./cli-engine.js";

export class GeminiCLIEngine extends SimpleCLIEngine {
  constructor() {
    super({
      binary: "gemini",
      args: [],
      progressMessage: "Running Gemini CLI (this may take a few minutes)...",
      timeoutMs: 600_000,
    });
  }
}
