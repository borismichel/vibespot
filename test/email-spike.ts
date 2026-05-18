/**
 * Email Module Generation Spike (VIB-154)
 * Generates 3 email templates via Anthropic API using the email module developer prompt.
 * Validates output against email rendering rules.
 * Go/no-go: >70% of modules pass all critical email rendering checks.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  buildEmailModuleDeveloperPrompt,
  buildEmailModuleUserMessage,
  EMAIL_MODULE_DEVELOPER_SCHEMA,
} from "../src/server/agent/prompts/email-module-developer.js";

const MODEL = "claude-sonnet-4-20250514";

const EMAIL_SPECS = [
  {
    name: "email-welcome",
    description: "Welcome/onboarding email for new signups",
    contentBrief:
      "Welcome a new user to vibeSpot. Introduce the product (AI-powered HubSpot page builder). Include: hero with logo placeholder, welcome heading, 3 key benefits in a feature grid, a CTA button to 'Start Building', and a footer with company info + unsubscribe link.",
    layoutNotes:
      "Single column. Hero section with background color. 3-column feature grid using table cells. Bulletproof CTA button. Standard email footer.",
  },
  {
    name: "email-product-announcement",
    description: "Product announcement / feature launch email",
    contentBrief:
      "Announce the launch of email template generation in vibeSpot. Include: announcement header, product screenshot placeholder, 3 bullet points on what's new, a testimonial quote from a beta user, CTA to 'Try Email Templates', and footer.",
    layoutNotes:
      "Single column with optional 2-column section for screenshot + text. Use a colored accent bar at the top. Testimonial in a styled blockquote table cell.",
  },
  {
    name: "email-event-invitation",
    description: "Event invitation email (webinar/conference)",
    contentBrief:
      "Invite users to a 'Building HubSpot Themes with AI' webinar. Include: event header with date/time, speaker photo placeholder + bio, 3 agenda items, registration CTA button, calendar add link, and footer with unsubscribe.",
    layoutNotes:
      "Hero section with event title. 2-column layout for speaker (photo left, bio right). Numbered agenda list. Two CTA buttons (Register + Add to Calendar). Standard footer.",
  },
];

interface EmailValidationResult {
  moduleName: string;
  checks: { name: string; passed: boolean; details: string }[];
  criticalPassed: number;
  criticalTotal: number;
  warningCount: number;
  overallPass: boolean;
}

function validateEmailModule(
  moduleName: string,
  html: string,
  css: string,
  js: string | undefined | null,
  fieldsJson: string,
  metaJson: string,
): EmailValidationResult {
  const checks: { name: string; passed: boolean; details: string; critical: boolean }[] = [];

  // CRITICAL: No flexbox
  const hasFlexbox = /display\s*:\s*flex/i.test(html) || /display\s*:\s*flex/i.test(css);
  checks.push({
    name: "No flexbox",
    passed: !hasFlexbox,
    details: hasFlexbox ? "Found display:flex — email clients don't support it" : "OK",
    critical: true,
  });

  // CRITICAL: No grid
  const hasGrid = /display\s*:\s*grid/i.test(html) || /display\s*:\s*grid/i.test(css);
  checks.push({
    name: "No grid",
    passed: !hasGrid,
    details: hasGrid ? "Found display:grid — email clients don't support it" : "OK",
    critical: true,
  });

  // CRITICAL: Uses table-based layout
  const tableCount = (html.match(/<table[\s>]/gi) || []).length;
  checks.push({
    name: "Table-based layout",
    passed: tableCount >= 2,
    details: `Found ${tableCount} <table> elements`,
    critical: true,
  });

  // CRITICAL: Has role="presentation" on layout tables
  const presentationCount = (html.match(/role="presentation"/gi) || []).length;
  checks.push({
    name: "Tables have role=presentation",
    passed: presentationCount >= 2,
    details: `Found ${presentationCount} role="presentation" attributes`,
    critical: true,
  });

  // CRITICAL: Inline styles present
  const inlineStyleCount = (html.match(/style="/gi) || []).length;
  checks.push({
    name: "Inline styles present",
    passed: inlineStyleCount >= 5,
    details: `Found ${inlineStyleCount} inline style attributes`,
    critical: true,
  });

  // CRITICAL: No CSS custom properties in HTML
  const hasCssVars = /var\s*\(/i.test(html);
  checks.push({
    name: "No CSS variables",
    passed: !hasCssVars,
    details: hasCssVars ? "Found var() — not supported in email" : "OK",
    critical: true,
  });

  // CRITICAL: moduleCss is empty (all CSS inline)
  const cssIsEmpty = !css || css.trim() === "";
  checks.push({
    name: "moduleCss is empty",
    passed: cssIsEmpty,
    details: cssIsEmpty ? "OK — all CSS inline" : `moduleCss has ${css.length} chars (should be empty)`,
    critical: true,
  });

  // CRITICAL: No JavaScript
  const hasJs = js && js.trim().length > 0;
  checks.push({
    name: "No JavaScript",
    passed: !hasJs,
    details: hasJs ? "module.js is not empty — email doesn't support JS" : "OK",
    critical: true,
  });

  // CRITICAL: metaJson has EMAIL host_template_type
  const hasEmailType = /EMAIL/i.test(metaJson);
  checks.push({
    name: "meta.json has EMAIL type",
    passed: hasEmailType,
    details: hasEmailType ? "OK" : "Missing host_template_types: ['EMAIL']",
    critical: true,
  });

  // CRITICAL: No <style> blocks
  const hasStyleBlock = /<style[\s>]/i.test(html);
  checks.push({
    name: "No <style> blocks",
    passed: !hasStyleBlock,
    details: hasStyleBlock ? "Found <style> tag — stripped by Gmail" : "OK",
    critical: true,
  });

  // CRITICAL: No div-based layout (should use td for structure)
  const divCount = (html.match(/<div[\s>]/gi) || []).length;
  const tdCount = (html.match(/<td[\s>]/gi) || []).length;
  const divRatio = tdCount > 0 ? divCount / tdCount : divCount;
  checks.push({
    name: "Minimal div usage",
    passed: divRatio < 0.5,
    details: `${divCount} divs vs ${tdCount} tds (ratio: ${divRatio.toFixed(2)})`,
    critical: true,
  });

  // WARNING: Has MSO conditionals for Outlook
  const hasMso = /<!--\[if\s+mso\]>/i.test(html);
  checks.push({
    name: "MSO conditionals for Outlook",
    passed: hasMso,
    details: hasMso ? "OK — Outlook desktop support" : "Missing MSO conditionals (Outlook may break)",
    critical: false,
  });

  // WARNING: Uses web-safe fonts
  const hasWebSafeFont = /font-family:\s*['"]?(?:Arial|Helvetica|Georgia|Times|Verdana)/i.test(html);
  checks.push({
    name: "Web-safe fonts used",
    passed: hasWebSafeFont,
    details: hasWebSafeFont ? "OK" : "No web-safe font detected",
    critical: false,
  });

  // WARNING: Has cellpadding=0 cellspacing=0 on tables
  const hasCellAttrs = /cellpadding="0"/i.test(html) && /cellspacing="0"/i.test(html);
  checks.push({
    name: "Table cell reset attributes",
    passed: hasCellAttrs,
    details: hasCellAttrs ? "OK" : "Missing cellpadding/cellspacing reset",
    critical: false,
  });

  // WARNING: Images have display:block
  const imgTags = html.match(/<img[^>]+>/gi) || [];
  const imgsWithBlock = imgTags.filter((t) => /display\s*:\s*block/i.test(t));
  const imgBlockPass = imgTags.length === 0 || imgsWithBlock.length >= imgTags.length * 0.5;
  checks.push({
    name: "Images have display:block",
    passed: imgBlockPass,
    details: `${imgsWithBlock.length}/${imgTags.length} images have display:block`,
    critical: false,
  });

  // WARNING: No position property
  const hasPosition = /position\s*:\s*(?:absolute|relative|fixed|sticky)/i.test(html);
  checks.push({
    name: "No CSS position",
    passed: !hasPosition,
    details: hasPosition ? "Found position property — breaks in email" : "OK",
    critical: false,
  });

  // WARNING: Has unsubscribe link (for footer modules)
  const hasUnsubscribe = /unsubscribe/i.test(html);
  checks.push({
    name: "Unsubscribe reference",
    passed: hasUnsubscribe,
    details: hasUnsubscribe ? "OK" : "No unsubscribe link detected (may be in a different module)",
    critical: false,
  });

  // WARNING: fieldsJson is valid JSON
  let fieldsValid = false;
  try {
    JSON.parse(fieldsJson);
    fieldsValid = true;
  } catch {}
  checks.push({
    name: "fields.json is valid JSON",
    passed: fieldsValid,
    details: fieldsValid ? "OK" : "Invalid JSON in fields.json",
    critical: false,
  });

  // No require_css, require_js, scope_css, get_asset_url
  const hasBannedHubl =
    /require_css|require_js|scope_css|get_asset_url/i.test(html);
  checks.push({
    name: "No banned HubL functions",
    passed: !hasBannedHubl,
    details: hasBannedHubl ? "Found banned HubL function for email" : "OK",
    critical: true,
  });

  const criticalChecks = checks.filter((c) => c.critical);
  const criticalPassed = criticalChecks.filter((c) => c.passed).length;
  const warningChecks = checks.filter((c) => !c.critical);
  const warningFailed = warningChecks.filter((c) => !c.passed).length;

  return {
    moduleName,
    checks: checks.map(({ critical: _, ...rest }) => rest),
    criticalPassed,
    criticalTotal: criticalChecks.length,
    warningCount: warningFailed,
    overallPass: criticalPassed / criticalChecks.length >= 0.7,
  };
}

async function generateEmailModule(
  client: Anthropic,
  spec: (typeof EMAIL_SPECS)[0],
): Promise<{
  moduleName: string;
  fieldsJson: string;
  metaJson: string;
  moduleHtml: string;
  moduleCss: string;
  moduleJs: string | null;
  durationMs: number;
}> {
  const systemPrompt = buildEmailModuleDeveloperPrompt("spike-email-test");
  const userMessage = buildEmailModuleUserMessage(
    "Generate this email module for our vibeSpot email template spike test.",
    spec,
  );

  const start = Date.now();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [
      {
        name: "module_output",
        description: "Output the generated email module",
        input_schema: EMAIL_MODULE_DEVELOPER_SCHEMA as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "module_output" },
  });

  const durationMs = Date.now() - start;

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  if (!toolBlock) {
    throw new Error(`No structured output for ${spec.name}`);
  }

  const data = toolBlock.input as Record<string, unknown>;

  return {
    moduleName: String(data.moduleName || spec.name),
    fieldsJson:
      typeof data.fieldsJson === "string"
        ? data.fieldsJson
        : JSON.stringify(data.fieldsJson, null, 2),
    metaJson:
      typeof data.metaJson === "string"
        ? data.metaJson
        : JSON.stringify(data.metaJson, null, 2),
    moduleHtml: String(data.moduleHtml || ""),
    moduleCss: String(data.moduleCss || ""),
    moduleJs: data.moduleJs ? String(data.moduleJs) : null,
    durationMs,
  };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  console.log("=== vibeSpot Email Module Generation Spike (VIB-154) ===\n");
  console.log(`Model: ${MODEL}`);
  console.log(`Templates to generate: ${EMAIL_SPECS.length}\n`);

  const results: EmailValidationResult[] = [];
  const generated: Awaited<ReturnType<typeof generateEmailModule>>[] = [];

  for (const spec of EMAIL_SPECS) {
    console.log(`\n--- Generating: ${spec.name} ---`);
    try {
      const module = await generateEmailModule(client, spec);
      generated.push(module);
      console.log(`  Generated in ${(module.durationMs / 1000).toFixed(1)}s`);
      console.log(`  HTML length: ${module.moduleHtml.length} chars`);
      console.log(`  Fields: ${module.fieldsJson.length} chars`);

      const validation = validateEmailModule(
        module.moduleName,
        module.moduleHtml,
        module.moduleCss,
        module.moduleJs,
        module.fieldsJson,
        module.metaJson,
      );
      results.push(validation);

      console.log(
        `  Critical checks: ${validation.criticalPassed}/${validation.criticalTotal} passed`,
      );
      console.log(`  Warnings: ${validation.warningCount}`);
      console.log(`  Overall: ${validation.overallPass ? "PASS" : "FAIL"}`);

      for (const check of validation.checks) {
        const icon = check.passed ? "  ✓" : "  ✗";
        if (!check.passed) {
          console.log(`${icon} ${check.name}: ${check.details}`);
        }
      }
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
      results.push({
        moduleName: spec.name,
        checks: [],
        criticalPassed: 0,
        criticalTotal: 1,
        warningCount: 0,
        overallPass: false,
      });
    }
  }

  // Summary
  console.log("\n\n=== SPIKE RESULTS SUMMARY ===\n");

  const totalPassed = results.filter((r) => r.overallPass).length;
  const passRate = (totalPassed / results.length) * 100;

  for (const r of results) {
    console.log(
      `${r.overallPass ? "✓ PASS" : "✗ FAIL"} ${r.moduleName}: ${r.criticalPassed}/${r.criticalTotal} critical checks`,
    );
  }

  console.log(`\nOverall pass rate: ${passRate.toFixed(0)}% (${totalPassed}/${results.length})`);
  console.log(`Go/No-Go threshold: >70%`);
  console.log(`\nVERDICT: ${passRate >= 70 ? "GO ✓" : "NO-GO ✗"}`);

  if (passRate >= 70) {
    console.log("\nThe email module developer prompt produces table-based, inline-CSS");
    console.log("email modules that pass critical rendering checks.");
    console.log("Recommend proceeding with full Phase 1 email template feature.");
  } else {
    console.log("\nThe prompt needs significant iteration before email templates are viable.");
    console.log("Key issues to address before retesting:");
    for (const r of results) {
      if (!r.overallPass) {
        const failed = r.checks.filter((c) => !c.passed);
        for (const f of failed) {
          console.log(`  - ${r.moduleName}: ${f.name} — ${f.details}`);
        }
      }
    }
  }

  // Write HTML files for manual inspection
  for (let i = 0; i < generated.length; i++) {
    const g = generated[i];
    const htmlWrapper = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${g.moduleName} — Email Spike Test</title>
</head>
<body style="margin: 0; padding: 20px; background-color: #f4f4f4; font-family: Arial, sans-serif;">
  <div style="max-width: 700px; margin: 0 auto; background: white; padding: 0;">
    ${g.moduleHtml}
  </div>
  <hr style="margin: 40px 0;">
  <h3>fields.json</h3>
  <pre style="background: #f0f0f0; padding: 16px; overflow: auto; font-size: 12px;">${escapeHtml(g.fieldsJson)}</pre>
  <h3>meta.json</h3>
  <pre style="background: #f0f0f0; padding: 16px; overflow: auto; font-size: 12px;">${escapeHtml(g.metaJson)}</pre>
</body>
</html>`;
    const fs = await import("fs");
    fs.writeFileSync(`test/email-spike-${g.moduleName}.html`, htmlWrapper);
    console.log(`\nWrote test/email-spike-${g.moduleName}.html for manual inspection`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

main().catch(console.error);
