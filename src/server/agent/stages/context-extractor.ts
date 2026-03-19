/**
 * Post-pipeline stage: Theme Context Extractor
 *
 * Lightweight AI call that extracts a product/company brief from the rendered
 * preview HTML. Runs in the background after pipeline completion — never blocks
 * the preview or user interaction.
 */

import type { AgentEngine } from "../engine-adapter.js";
import { callAgent } from "../engine-adapter.js";
import { log } from "../../log.js";

/**
 * Extract a product/company context brief from the rendered preview HTML.
 * The preview has all HubL resolved to actual field default values, so the AI
 * sees real copy instead of `{{ module.field_name }}` placeholders.
 *
 * Returns a markdown string, or null if extraction fails or produces nothing useful.
 */
export async function extractThemeContext(
  previewHtml: string,
  existingContext: string | undefined,
  engine: AgentEngine,
  apiKey: string,
  model: string,
): Promise<string | null> {
  if (!previewHtml || previewHtml.length < 50) return null;

  const existingNote = existingContext
    ? `\n\nExisting product context (update if the new content adds info, keep what's still accurate):\n${existingContext}`
    : "";

  const systemPrompt = `You are a content analyst. Extract a concise product/company brief from the rendered landing page HTML below. The HTML contains the actual text content (headings, paragraphs, button labels, image alt text, etc.) with all template variables resolved to their default values.

Return a markdown document with these sections (skip any section where the content provides no information):

## Product / Company
Name, one-line description, and what it does.

## Value Propositions
Key benefits or features (bulleted list).

## Target Audience
Who this product/service is for.

## Tone & Voice
Communication style (e.g., professional, casual, technical, friendly).

## Key Terminology
Specific terms, product names, or branded language used consistently.

Keep it concise — this brief is used as context for AI-generated content on other pages in the same theme.${existingNote}`;

  try {
    const result = await callAgent(engine, apiKey, model, {
      systemPrompt,
      messages: [{ role: "user", content: previewHtml }],
      maxTokens: 1000,
    });

    const text = result.type === "text" ? result.text : JSON.stringify(result.data);
    if (!text || text.trim().length < 20) return null;

    log.info("context-extractor", `Extracted theme context (${text.length} chars)`);
    return text.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("context-extractor", `Theme context extraction failed: ${msg}`);
    return null;
  }
}
