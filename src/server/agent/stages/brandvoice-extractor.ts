/**
 * Brand Voice Extractor
 *
 * Lightweight AI call that analyzes rendered preview HTML to extract writing
 * style, tone, and voice guidelines. Runs on-demand from the brand assets panel.
 */

import type { AgentEngine } from "../engine-adapter.js";
import { callAgent } from "../engine-adapter.js";
import { log } from "../../log.js";

/**
 * Extract a brand voice guide from the rendered preview HTML.
 * The preview has all HubL resolved to actual field default values, so the AI
 * sees real copy instead of `{{ module.field_name }}` placeholders.
 *
 * Returns a markdown string, or null if extraction fails.
 */
export async function extractBrandvoice(
  previewHtml: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
): Promise<string | null> {
  if (!previewHtml || previewHtml.length < 50) return null;

  const systemPrompt = `You are a brand strategist. Analyze the rendered landing page HTML below and extract a concise brand voice guide. The HTML contains the actual text content with all template variables resolved to their default values.

Return a markdown document with these sections (skip any section where the content provides no signal):

## Tone
Overall communication style (e.g., confident but approachable, technical but clear, playful, authoritative).

## Voice Characteristics
3-5 bullet points describing how this brand "sounds" (e.g., "Uses short, punchy sentences", "Addresses reader directly with 'you'").

## Vocabulary
- **Preferred words**: Terms used repeatedly or intentionally
- **Avoided patterns**: Any notable absences or anti-patterns

## Sentence Style
Typical sentence length, structure, use of questions, imperatives, etc.

## Dos and Don'ts
3-4 practical rules for writing in this voice (e.g., "Do: Lead with benefits, not features", "Don't: Use jargon without context").

Keep it actionable — this guide will be fed to AI to maintain consistent copy across pages.`;

  try {
    const result = await callAgent(engine, apiKey, model, {
      systemPrompt,
      messages: [{ role: "user", content: previewHtml }],
      maxTokens: 1000,
    });

    const text = result.type === "text" ? result.text : JSON.stringify(result.data);
    if (!text || text.trim().length < 20) return null;

    log.info("brandvoice-extractor", `Extracted brand voice (${text.length} chars)`);
    return text.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("brandvoice-extractor", `Brand voice extraction failed: ${msg}`);
    return null;
  }
}
