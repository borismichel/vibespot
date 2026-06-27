import { describe, it, expect } from "vitest";
import { resumeAgentPipeline } from "../src/server/agent/pipeline.js";
import type {
  CheckpointResumeState,
  CheckpointResolution,
  PipelineEvent,
} from "../src/server/agent/types.js";
import type { SessionSnapshot } from "../src/server/session/types.js";

// VIB-1883: a checkpoint parked before a server restart loses its in-memory
// `checkpointResumeStore` entry. The resume state is persisted on the session
// (`pendingCheckpoint.resumeState`) and handed back to `resumeAgentPipeline` as
// `fallbackState`, which rehydrates the store so the run continues instead of
// erroring "expired". These tests exercise the rehydration seam via the `cancel`
// action — it returns immediately after the store lookup, so no engine call is
// made (engine/apiKey/model are unused on that path).

function makeSnapshot(): SessionSnapshot {
  return {
    modules: [],
    moduleOrder: [],
    sharedCss: ":root{}",
    sharedJs: "",
    messages: [],
    themeName: "test-theme",
    themePath: "/tmp/test-theme",
  };
}

function makeFallbackState(): CheckpointResumeState {
  return {
    kind: "design",
    userMessage: "build me a landing page",
    plan: {
      intent: "create",
      contentType: "page",
      affectedModules: [],
      unchangedModules: [],
      newModules: [],
      guidesNeeded: ["design"],
      designSystemChanges: true,
    },
    designSystem: {
      cssVariables: { "--accent": "#e8613a" },
      sharedCss: ":root{--accent:#e8613a}",
      aesthetic: "warm",
    },
    sharedCss: ":root{--accent:#e8613a}",
    sharedJs: "",
    startTime: 1_700_000_000_000,
    libraryModules: [],
  };
}

const noop = (_e: PipelineEvent) => {};
const cancel: CheckpointResolution = { kind: "design", action: "cancel" };

describe("durable checkpoint resume (VIB-1883)", () => {
  it("rehydrates the store from fallbackState after a server restart (store miss)", async () => {
    // Token the in-memory store has never seen — simulates a fresh process.
    const result = await resumeAgentPipeline(
      "cp_restarted_token",
      cancel,
      makeSnapshot(),
      "anthropic",
      "unused-key",
      "claude-sonnet-4-6",
      20,
      noop,
      undefined,
      makeFallbackState(),
    );
    expect(result.canceled).toBe(true);
    expect(result.assistantMessage).toContain("Cancelled");
  });

  it("still errors 'expired' when neither the store nor a fallback has the state", async () => {
    await expect(
      resumeAgentPipeline(
        "cp_no_state_anywhere",
        cancel,
        makeSnapshot(),
        "anthropic",
        "unused-key",
        "claude-sonnet-4-6",
        20,
        noop,
        // no signal, no fallbackState
      ),
    ).rejects.toThrow(/expired/i);
  });
});
