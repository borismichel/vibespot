/**
 * AI prompt construction — system prompts, state context, message building.
 */

import { getConversionGuide, getDesignGuide, getContentGuide, getHubspotRules, getPageTypeGuide, getHumanifyGuide } from "../ai/prompts.js";
import {
  getSession,
  getActiveTemplate,
  getModuleLibrary,
} from "./session.js";
import type { UploadedFileContext } from "./routes/upload-files.js";

// Multimodal content block types (compatible with Anthropic/OpenAI APIs)
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type MultimodalMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

/**
 * Get the active template's page type and brand assets from the session.
 */
export function getPromptContext(): { pageType?: string; brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean } } {
  const session = getSession();
  if (!session) return {};
  const tpl = getActiveTemplate();
  return {
    pageType: tpl?.pageType,
    brandAssets: session.brandAssets,
  };
}

/**
 * Build the system prompt for vibe coding mode.
 */
export function buildVibeSystemPrompt(
  conversionGuide: string,
  themeName: string,
  editMode: boolean = false,
  pageType?: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean }
): string {
  const core = `You are vibeSpot, an AI that builds HubSpot CMS landing pages from natural language descriptions.

## Your Role
You generate native HubSpot CMS modules directly from user descriptions. Every module you create is immediately compatible with HubSpot's drag-and-drop page editor.

## Output Format — CRITICAL
You MUST include a \`\`\`vibespot-modules code block with ALL module data as JSON. This is the ONLY way modules get created. A text summary, table, or description of modules does NOT work — you must output the actual JSON.

\`\`\`vibespot-modules
{
  "modules": [
    {
      "moduleName": "Hero",
      "fieldsJson": "...",
      "metaJson": "...",
      "moduleHtml": "...",
      "moduleCss": "...",
      "moduleJs": null
    }
  ],
  "sharedCss": "...",
  "sharedJs": "..."
}
\`\`\`

NEVER respond with only a text summary. The vibespot-modules JSON block is mandatory.

## Rules
- fieldsJson, metaJson must be valid JSON strings
- moduleHtml uses HubL template syntax ({{ module.field_name }})
- moduleCss is vanilla CSS (no Tailwind, no Sass)
- moduleJs is optional vanilla JS (wrapped in IIFE)
- NEVER use CDN imports (@import url(), <link> to external CDNs like Google Fonts, cdnjs, unpkg, jsdelivr)
- For fonts, use system font stacks with good fallbacks. Define them as CSS custom properties in sharedCss:
  --font-heading: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', SFMono-Regular, Consolas, monospace;
- All assets must be self-contained — no external HTTP requests in CSS or HTML
- Use "type": "text" (NEVER "textarea" — it's deprecated)
- NEVER use "name": "name" (reserved) — use "item_name" instead
- NEVER put literal \\n newline sequences in field default values — use plain text without line breaks
- Wrap style fields in a "styles" group with "tab": "STYLE"
- All CSS classes must use a unique prefix "${themeName}-" to avoid theme conflicts
- Use BEM naming: ${themeName}-module__element--modifier
- metaJson must include: host_template_types: ["PAGE"], is_available_for_new_content: true
- For repeater groups, use "occurrence": { "min": 0, "max": 100 } and iterate with {% for %}
- Color fields: type "color", default { "color": "#hex", "opacity": 100 }
- Link fields: type "link", default { "url": { "href": "#", "type": "EXTERNAL" }, "open_in_new_tab": false, "no_follow": false }
- Image fields: type "image", default { "src": "https://placehold.co/800x600/1a1a2e/ffffff?text=Replace+in+HubSpot", "alt": "Placeholder image", "width": 800, "height": 600 }

## Images & Media
- Users can upload images that get placed in the theme's assets/ folder automatically
- When the user uploads an image and wants it on the page, reference it with: {{ get_asset_url("${themeName}/assets/filename.ext") }}
- IMPORTANT: get_asset_url() paths must include the theme name prefix "${themeName}/" because HubSpot resolves from the Design Manager root
- For background images with uploaded assets: style="background-image: url('{{ get_asset_url(\\"${themeName}/assets/filename.ext\\") }}')"
- For images without an uploaded asset, use image fields (type "image") with placehold.co defaults
- ALWAYS use image fields (type "image") so users can swap images in the page editor
- Use placehold.co URLs as defaults so the preview looks complete (e.g. https://placehold.co/800x600/1a1a2e/ffffff?text=Hero+Image)
- In module.html, render images with: <img src="{{ module.field_name.src }}" alt="{{ module.field_name.alt }}" width="{{ module.field_name.width }}" height="{{ module.field_name.height }}">
- For background images in CSS, use inline styles: style="background-image: url('{{ module.field_name.src }}')"
- Size placeholders appropriately for their context (hero: 1920x800, cards: 600x400, icons: 200x200, avatars: 150x150)
- If the user's intent is ambiguous (design reference vs page asset), ask them to clarify

## Navigation & Anchor Links
- For anchor links, add an id attribute directly on the module's root element in module.html:
  <section id="pricing" class="...">  (NOT on an external wrapper — HubSpot's dnd system strips those)
- The id should be the moduleName lowercased with spaces replaced by hyphens (e.g. "Pricing Cards" → id="pricing-cards")
- For navigation/menu modules, use anchor links that match these ids: e.g. href="#features"
- Always include smooth scrolling behavior in navigation link clicks
- For nav modules, make menu items editable via a repeater group with "label" (text) and "anchor" (text) fields

## When modifying existing modules
When the user asks to change something, include ONLY the modules that changed. Keep module names consistent.
If the change affects shared CSS or JS, include those too.`;

  const pageTypeSection = pageType ? getPageTypeGuide(pageType) : "";
  const pageTypePrompt = pageTypeSection ? `\n\n## Page Type Context\n${pageTypeSection}` : "";

  let brandPrompt = "";
  if (!editMode) {
    if (brandAssets?.styleguide) {
      brandPrompt += `\n\n## Brand Style Guide\n${brandAssets.styleguide}`;
    }
    if (brandAssets?.brandvoice) {
      brandPrompt += `\n\n## Brand Voice\n${brandAssets.brandvoice}`;
    }
    if (brandAssets?.humanify !== false) {
      const humanifyGuide = getHumanifyGuide();
      if (humanifyGuide) {
        brandPrompt += `\n\n## Anti-AI Copy Rules (Humanify)\n${humanifyGuide}`;
      }
    }
  }

  if (editMode) {
    return core + pageTypePrompt + `

## HubSpot CMS Rules
${getHubspotRules()}`;
  }

  return core + pageTypePrompt + brandPrompt + `

## Design Quality
- Use modern, clean design with proper spacing and typography
- Include responsive CSS (mobile breakpoint at 767px)
- Add scroll animation classes where appropriate
- Use CSS custom properties for the design system
- Make content editable through fields.json (headlines, text, colors, images, links)

## Scroll Animation CSS Fallback (IMPORTANT)
When using scroll-animate classes (opacity: 0 → visible), you MUST include a CSS-only fallback animation in sharedCss that auto-reveals elements after a delay. This ensures content is visible even if the JS file fails to load:
\`\`\`css
@keyframes scroll-animate-fallback {
  to { opacity: 1; transform: none; }
}
.scroll-animate {
  animation: scroll-animate-fallback 0.1s 3s forwards;
}
.scroll-animate.visible {
  animation: none;
}
\`\`\`
This makes elements appear after 3 seconds if JS never adds the .visible class. Once JS runs normally and adds .visible, the animation is cancelled.

## Design Guide
${getDesignGuide()}

## Content & Copywriting Guide
${getContentGuide()}

## HubSpot CMS Rules
${getHubspotRules()}

## Conversion Guide Reference
${conversionGuide}`;
}

/**
 * Build a summary of the current module state for inclusion in user messages.
 */
export function buildStateContext(): string {
  const session = getSession()!;
  const parts: string[] = [];
  if (session.modules.length > 0) {
    parts.push("\n\n## Current Module State\n");
    for (const mod of session.modules) {
      parts.push(`\n### ${mod.moduleName}.module\n`);
      parts.push(`**fields.json:**\n\`\`\`json\n${mod.fieldsJson}\n\`\`\`\n`);
      parts.push(`**module.html:**\n\`\`\`html\n${mod.moduleHtml}\n\`\`\`\n`);
      parts.push(`**module.css:**\n\`\`\`css\n${mod.moduleCss}\n\`\`\`\n`);
      if (mod.moduleJs) {
        parts.push(`**module.js:**\n\`\`\`js\n${mod.moduleJs}\n\`\`\`\n`);
      }
    }
    if (session.sharedCss) {
      parts.push(`\n### Shared CSS\n\`\`\`css\n${session.sharedCss}\n\`\`\`\n`);
    }
    if (session.sharedJs) {
      parts.push(`\n### Shared JS\n\`\`\`js\n${session.sharedJs}\n\`\`\`\n`);
    }
  }

  const library = getModuleLibrary();
  const currentModuleNames = new Set(session.modules.map((m) => m.moduleName));
  const otherModules = library.filter((e) => !currentModuleNames.has(e.module.moduleName));
  if (otherModules.length > 0) {
    parts.push("\n\n## Available modules in this theme (reusable)\n");
    for (const entry of otherModules) {
      parts.push(`- ${entry.module.moduleName} (used in: ${entry.usedIn.join(", ")})\n`);
    }
    parts.push("\nThe user can ask to reuse any of these modules by name.\n");
  }

  return parts.join("");
}

/**
 * Build the messages array with state context appended to the latest user message.
 * When fileContexts are provided, the last message uses multimodal content blocks.
 */
export function buildMessagesWithContext(
  userMessage: string,
  fileContexts?: UploadedFileContext[]
): MultimodalMessage[] {
  const session = getSession()!;

  // Build history from session messages, but exclude the latest user message
  // if it matches the one we're about to send (it was already added to the
  // session by the WebSocket handler before generation starts).
  let history = session.messages.slice(-20);
  if (
    history.length > 0 &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].content === userMessage
  ) {
    history = history.slice(0, -1);
  }

  const messages: MultimodalMessage[] =
    history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

  const stateContext = buildStateContext();

  // Build asset manifest if there are any uploaded assets in the session
  let assetManifest = "";
  if (session.assets?.length) {
    const imageAssets = session.assets.filter((a) => a.type === "image" && a.usage === "asset");
    if (imageAssets.length > 0) {
      assetManifest = `\n\n## Available Theme Assets\nThese images are in the theme's assets/ folder. Reference them with get_asset_url("${session.themeName}/assets/filename"):\n${imageAssets.map((a) => `- ${a.filename} (${a.originalName}) → get_asset_url("${session.themeName}/assets/${a.filename}")`).join("\n")}`;
    }
  }

  let textContent = userMessage;
  if (stateContext) textContent += `\n\n---\n${stateContext}`;
  if (assetManifest) textContent += assetManifest;

  // Add document text from attachments
  const hasFiles = fileContexts && fileContexts.length > 0;
  if (hasFiles) {
    for (const fc of fileContexts) {
      if (fc.type === "document" && fc.extractedText) {
        textContent += `\n\n---\n[Attached document: ${fc.originalName}]\n${fc.extractedText}`;
      }
      if (fc.type === "image" && fc.usage === "asset" && fc.assetPath) {
        textContent += `\n\n[Uploaded image: ${fc.originalName} → available as get_asset_url("${fc.assetPath}")]`;
      }
    }
  }

  // Build multimodal content if there are image attachments
  const imageFiles = hasFiles ? fileContexts.filter((fc) => fc.type === "image" && fc.base64) : [];

  if (imageFiles.length > 0) {
    const contentBlocks: ContentBlock[] = [];
    // Add image blocks first so the AI "sees" them
    for (const img of imageFiles) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType,
          data: img.base64!,
        },
      });
    }
    // Add the text content
    contentBlocks.push({ type: "text", text: textContent });
    messages.push({ role: "user", content: contentBlocks });
  } else {
    messages.push({ role: "user", content: textContent });
  }

  return messages;
}
