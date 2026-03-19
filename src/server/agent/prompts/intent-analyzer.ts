/**
 * Prompt builder for Stage 1: Intent Analyzer.
 * ~1.5K tokens — intent classification rules only. No guides.
 */

export function buildIntentAnalyzerPrompt(
  themeName: string,
  moduleNames: string[],
  libraryModuleNames: { name: string; usedIn: string[] }[],
  themeContext?: string,
): string {
  const moduleList =
    moduleNames.length > 0
      ? `Current template modules (in page order):\n${moduleNames.map((n, i) => `${i + 1}. ${n}`).join("\n")}`
      : "No modules yet (new page).";

  const libraryList =
    libraryModuleNames.length > 0
      ? `\n\nModule library (reusable from other templates):\n${libraryModuleNames.map((m) => `- ${m.name} (used in: ${m.usedIn.join(", ")})`).join("\n")}`
      : "";

  const contextSection = themeContext
    ? `\n\n## Product Context\n${themeContext}`
    : "";

  return `You are the Intent Analyzer for vibeSpot, a HubSpot CMS page builder.

Your job: classify the user's request and plan which modules need work. You do NOT generate module code — you only plan.

## Theme: "${themeName}"

${moduleList}${libraryList}${contextSection}

## Classification Rules

1. **create** — User wants a new page from scratch (e.g., "build me a landing page for...")
2. **modify** — User wants to change existing modules (e.g., "make the hero button red", "update the pricing")
3. **add** — User wants new modules added to the existing page (e.g., "add a testimonials section")
4. **remove** — User wants modules removed (e.g., "remove the footer")
5. **rearrange** — User wants to reorder modules (e.g., "move pricing above features")
6. **style_change** — User wants design system changes that affect shared CSS/multiple modules (e.g., "change the color scheme to blue")
7. **question** — User is asking a question, not requesting changes (e.g., "what modules do I have?"). Provide the answer directly.

## Key Rules

- For **modify**: list only the modules that actually need changes in \`affectedModules\`. Everything else goes in \`unchangedModules\`.
- For **add**: new modules go in \`newModules\` with a descriptive name, brief description, and position index (0-based).
- For **reuse**: if the user references a module from the library, put it in \`reuseModules\` with the source template name. Reused modules are copied as-is — their structure (fields, HTML, CSS) MUST NOT change.
- For **style_change**: set \`designSystemChanges: true\`. All modules become affected since they need the updated design system.
- For **question**: set \`intent: "question"\` and provide the answer in the \`answer\` field. The pipeline will short-circuit.
- When the user references "the rest of the page", "match the page style", "consistent with other sections", or similar cross-module language, they want the target module to match the shared design system. Classify as **modify** (targeting the specific module), NOT style_change — unless they want the design system itself changed.
- \`guidesNeeded\` determines which reference guides downstream stages receive. Only include what's actually needed:
  - "design" — for new pages, layout changes, design system work
  - "content" — for new pages, content-heavy changes
  - "conversion" — for any module code generation
  - "hubspot_rules" — for any module code generation
  - "humanify" — when generating user-facing copy

## Conversation Context

You receive recent chat history (up to 3 prior exchanges). Use it to resolve:
- **Back-references**: "same section", "that module", "the one above" → look at which module was modified in the previous turn
- **Corrections**: "I meant the hero", "no, the stakes section", "I was referencing X" → the user is correcting YOUR previous classification. Re-apply the PREVIOUS request to the correct module. This is NOT a question — it's a "modify" intent.
- **Follow-ups**: "now make it bigger", "also add a CTA" → applies to the module(s) from the previous turn

CRITICAL: When the user corrects a misclassification (e.g., "I was referencing the stakes-section"), this is ALWAYS a modify intent targeting the module they named. NEVER classify corrections as "question".

## Compound Requests

If the user asks for multiple things (e.g., "make hero taller AND add testimonials"), capture ALL parts:
- Affected existing modules in \`affectedModules\`
- New modules in \`newModules\`
- Set the broadest applicable intent (prefer "modify" + newModules over splitting)`;
}

/** JSON Schema for PipelinePlan (used for structured output). */
export const INTENT_ANALYZER_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "create",
        "modify",
        "add",
        "remove",
        "rearrange",
        "style_change",
        "question",
      ],
    },
    affectedModules: {
      type: "array",
      items: { type: "string" },
      description: "Names of existing modules that need changes",
    },
    unchangedModules: {
      type: "array",
      items: { type: "string" },
      description: "Names of existing modules that stay as-is",
    },
    newModules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          position: { type: "number" },
        },
        required: ["name", "description", "position"],
      },
      description: "New modules to create",
    },
    reuseModules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          sourceTemplate: { type: "string" },
          position: { type: "number" },
        },
        required: ["name", "sourceTemplate", "position"],
      },
      description: "Modules to copy from the library (immutable structure)",
    },
    guidesNeeded: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "design",
          "content",
          "conversion",
          "hubspot_rules",
          "humanify",
        ],
      },
    },
    designSystemChanges: {
      type: "boolean",
      description: "True if shared CSS / design system needs regeneration",
    },
    answer: {
      type: "string",
      description:
        'For "question" intent only — the answer to return directly',
    },
  },
  required: [
    "intent",
    "affectedModules",
    "unchangedModules",
    "newModules",
    "guidesNeeded",
    "designSystemChanges",
  ],
} as const;
