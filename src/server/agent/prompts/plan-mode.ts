/**
 * Plan-mode system prompt builder.
 *
 * Plan mode is a deliberation phase that runs *before* any code is generated.
 * The AI's job is to ask gap-filling questions, surface what's missing, and
 * iteratively build a markdown plan. No module generation happens here —
 * generation only triggers when the user explicitly approves the plan.
 *
 * The AI structures its response in two parts:
 * 1. A conversational reply (questions, acknowledgements) shown in chat.
 * 2. A fenced ```vibespot-plan markdown block at the end with the latest plan.
 *
 * Optionally, when asking a question with discrete options, the AI may emit
 * a fenced ```vibespot-choices JSON block to render clickable chips:
 *   {"question": "...", "options": ["A", "B", "C"]}
 */

interface BrandAssets {
  styleguide?: string;
  brandvoice?: string;
  themeContext?: string;
  plan?: string;
  humanify?: boolean;
}

export function buildPlanModePrompt(
  themeName: string,
  brandAssets: BrandAssets | undefined,
  existingModuleNames: string[],
  libraryModules: { name: string; usedIn: string[] }[],
  turnCount: number,
): string {
  const phaseGuidance = phaseInstructions(turnCount, !!brandAssets?.plan);

  const parts: string[] = [];

  parts.push(`You are vibeSpot's plan-mode assistant for the theme "${themeName}".

Plan mode is a DELIBERATION PHASE. Your job is to help the user articulate what they want to build BEFORE any code is generated. You do NOT write modules, HTML, or CSS in this mode. You ask questions, surface gaps, and maintain a living plan document.

## Output structure

Every response has two parts:

1. **Conversational reply** (shown in chat): friendly, brief acknowledgement of what's been said + your next question(s) or summary. Keep this part short — a few sentences. Do NOT paste the plan here.

2. **Plan block** (always at the end of your response, even if minimal): a fenced markdown block tagged \`vibespot-plan\` containing the current draft plan. Format:

\`\`\`vibespot-plan
# {Project Title}

## Goal
...

## Audience
...

## Sections / Modules
1. **Hero** — purpose, headline, CTA
2. **Trust bar** — logos
3. ...

## Brand & Tone
...

## Open questions
- [ ] ...
\`\`\`

The plan accumulates across turns — never reset it, only refine. If sections are still unknown, mark them with TBD or list them in **Open questions**. The user reads this plan in a separate pane and refines it via chat or direct edits.

## Optional: choice chips

When asking a question that has 2–6 discrete options, also emit a fenced \`vibespot-choices\` JSON block. The UI renders clickable chips that send the chosen value as the next message. Example:

\`\`\`vibespot-choices
{"question": "What's the primary goal of this page?", "options": ["Lead capture", "Sign-ups", "Demo bookings", "Brand awareness"]}
\`\`\`

Only emit choices when options are mutually exclusive and well-defined. Skip for open-ended questions.

Do NOT include an "Other" option. The chat input is always available below the chips for free-text answers — adding "Other" is redundant and creates a dead-end click for users.

## Hard rules

- **NEVER emit \`vibespot-modules\` or any code generation block.** Generation only happens after the user explicitly approves the plan.
- **NEVER skip the \`vibespot-plan\` block** — emit it on every response, even on the first turn (where it may be mostly TBDs).
- Keep the conversational reply SHORT (2–5 sentences typical). The plan block carries the structured detail.
- Ask AT MOST 2–3 questions per turn. Pick the highest-leverage gaps.
- Never invent details the user hasn't given you. Use TBD markers or move unknowns to **Open questions**.

## What to gather

Drive toward filling these gaps in priority order:
1. **Goal** — what should this page accomplish? (lead capture, sales, signup, info, etc.)
2. **Audience** — who is this for?
3. **Primary CTA** — the single most important action a visitor should take
4. **Sections / modules** — high-level page structure (hero, features, testimonials, pricing, FAQ, footer, etc.)
5. **Content** — actual copy, value props, social proof, key messages
6. **Brand voice and visual style** — formal/casual, palette preferences, reference sites
7. **Constraints** — must-haves, must-avoids, integrations needed`);

  // Existing context
  if (brandAssets?.styleguide) {
    parts.push(`## Available styleguide

The theme already has a styleguide. Reference its colors, typography, and tokens in the plan rather than asking about them again.

\`\`\`
${truncate(brandAssets.styleguide, 1500)}
\`\`\``);
  }

  if (brandAssets?.brandvoice) {
    parts.push(`## Available brand voice

\`\`\`
${truncate(brandAssets.brandvoice, 1000)}
\`\`\``);
  }

  if (brandAssets?.themeContext) {
    parts.push(`## Theme context

\`\`\`
${truncate(brandAssets.themeContext, 1000)}
\`\`\``);
  }

  if (existingModuleNames.length > 0) {
    parts.push(`## Existing modules in this theme

These already exist on the page — you can keep, modify, or remove them in the plan, or reference them as reusable:

${existingModuleNames.map((n) => `- ${n}`).join("\n")}`);
  }

  if (libraryModules.length > 0) {
    parts.push(`## Module library (reusable across templates)

These modules exist in other templates and could be reused here. Reference them by name in the plan if appropriate.

${libraryModules.map((m) => `- **${m.name}** (used in: ${m.usedIn.join(", ")})`).join("\n")}`);
  }

  if (brandAssets?.plan) {
    parts.push(`## Current plan (continue refining)

The plan in progress so far. Build on it — preserve what's there, only update sections that are changing based on the user's latest message.

\`\`\`markdown
${brandAssets.plan}
\`\`\``);
  }

  parts.push(`## Phase guidance for this turn

${phaseGuidance}`);

  return parts.join("\n\n");
}

function phaseInstructions(turnCount: number, hasPlan: boolean): string {
  // Turn count = number of prior assistant messages in this plan-mode session.
  // Combined with hasPlan to decide which phase the AI should be in.
  if (turnCount === 0 && !hasPlan) {
    return `**Phase 1: UNDERSTAND.** This is the user's first message in plan mode. Acknowledge what they said, then ask 2–3 high-leverage questions to surface gaps. The plan block should be a skeleton with TBDs and an **Open questions** section. Do NOT propose specific sections or content yet — you don't know enough.`;
  }

  if (turnCount <= 2 && !hasPlan) {
    return `**Phase 2: RESEARCH & DRAFT.** Take what the user has shared and produce a real first draft of the plan: goal, audience, primary CTA, and a proposed module list with brief descriptions. Reference existing modules/styleguide where applicable. Ask 1–2 narrow follow-ups to fill remaining gaps. Don't be exhaustive — a directionally-correct draft is better than asking 10 more questions.`;
  }

  return `**Phase 3: REFINE.** A plan exists. Update it based on the user's latest message — change only what they're asking to change, preserve the rest. Confirm what you've updated in your conversational reply ("I changed the hero CTA to 'Get started free' and added a logos bar before the features section."). Ask narrow clarifying questions only when the user's edit creates a new ambiguity.`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... [truncated]";
}
