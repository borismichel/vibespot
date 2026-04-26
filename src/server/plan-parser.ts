/**
 * Parses plan-mode AI output: extracts vibespot-plan and vibespot-choices
 * fenced blocks and returns them alongside the cleaned chat-visible content.
 */

export interface PlanChoice {
  question: string;
  options: string[];
}

export interface ParsedPlanResponse {
  /** AI response with both fenced blocks stripped — safe to show in chat. */
  cleanedContent: string;
  /** Markdown plan extracted from ```vibespot-plan ... ``` block, if any. */
  plan?: string;
  /** Choice chip prompt extracted from ```vibespot-choices ... ``` block, if any. */
  choices?: PlanChoice;
}

const PLAN_BLOCK_RE = /```vibespot-plan\s*\n([\s\S]*?)```/g;
const CHOICES_BLOCK_RE = /```vibespot-choices\s*\n([\s\S]*?)```/g;

/**
 * Parse a plan-mode AI response. Extracts fenced blocks and returns the
 * cleaned content (with the blocks removed) plus the parsed values.
 */
export function parsePlanResponse(content: string): ParsedPlanResponse {
  let plan: string | undefined;
  let choices: PlanChoice | undefined;

  // Last vibespot-plan block wins (in case the AI emits multiple)
  let planMatch: RegExpExecArray | null;
  PLAN_BLOCK_RE.lastIndex = 0;
  while ((planMatch = PLAN_BLOCK_RE.exec(content)) !== null) {
    plan = planMatch[1].trim();
  }

  // Last vibespot-choices block wins
  let choicesMatch: RegExpExecArray | null;
  CHOICES_BLOCK_RE.lastIndex = 0;
  while ((choicesMatch = CHOICES_BLOCK_RE.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(choicesMatch[1].trim()) as Partial<PlanChoice>;
      if (
        parsed &&
        typeof parsed.question === "string" &&
        Array.isArray(parsed.options) &&
        parsed.options.every((o) => typeof o === "string") &&
        parsed.options.length > 0
      ) {
        choices = { question: parsed.question, options: parsed.options };
      }
    } catch {
      // Ignore malformed choices block — chat still works.
    }
  }

  // Strip both kinds of fenced blocks from the chat-visible content.
  const cleanedContent = content
    .replace(PLAN_BLOCK_RE, "")
    .replace(CHOICES_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanedContent, plan, choices };
}
