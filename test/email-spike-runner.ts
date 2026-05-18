/**
 * Email Module Generation Spike Runner (VIB-154)
 * Uses claude --print to generate email modules, validates output.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

interface Check {
  name: string;
  passed: boolean;
  details: string;
  critical: boolean;
}

function validateEmailModule(
  moduleName: string,
  html: string,
  css: string,
  js: string | null,
  fieldsJson: string,
  metaJson: string,
): { checks: Check[]; criticalPassed: number; criticalTotal: number; overallPass: boolean } {
  const checks: Check[] = [];

  const add = (name: string, passed: boolean, details: string, critical: boolean) =>
    checks.push({ name, passed, details, critical });

  // CRITICAL checks
  add("No flexbox", !/display\s*:\s*flex/i.test(html + css), "No display:flex found", true);
  add("No grid", !/display\s*:\s*grid/i.test(html + css), "No display:grid found", true);

  const tableCount = (html.match(/<table[\s>]/gi) || []).length;
  add("Table-based layout", tableCount >= 2, `${tableCount} tables found`, true);

  const rolePresCount = (html.match(/role="presentation"/gi) || []).length;
  add("role=presentation on tables", rolePresCount >= 2, `${rolePresCount} found`, true);

  const inlineCount = (html.match(/style="/gi) || []).length;
  add("Inline styles (>=5)", inlineCount >= 5, `${inlineCount} inline styles`, true);

  add("No CSS variables", !/var\s*\(/i.test(html), "No var() in HTML", true);
  add("moduleCss empty", !css || css.trim() === "", css ? `${css.length} chars` : "empty", true);
  add("No JavaScript", !js || js.trim() === "", js ? "has JS" : "no JS", true);
  add("EMAIL in meta.json", /EMAIL/i.test(metaJson), "host_template_types check", true);
  add("No <style> blocks", !/<style[\s>]/i.test(html), "No <style> tags", true);

  const divCount = (html.match(/<div[\s>]/gi) || []).length;
  const tdCount = (html.match(/<td[\s>]/gi) || []).length;
  add("Minimal divs (< tds)", tdCount > 0 && divCount < tdCount, `${divCount} divs vs ${tdCount} tds`, true);

  add("No banned HubL", !/require_css|require_js|scope_css|get_asset_url/i.test(html), "No banned functions", true);

  // WARNING checks
  add("MSO conditionals", /<!--\[if\s+mso\]>/i.test(html), "Outlook support", false);
  add("Web-safe fonts", /font-family:\s*['"]?(?:Arial|Helvetica|Georgia|Times|Verdana)/i.test(html), "Font check", false);
  add("cellpadding/cellspacing reset", /cellpadding="0"/i.test(html) && /cellspacing="0"/i.test(html), "Table resets", false);
  add("Unsubscribe reference", /unsubscribe/i.test(html), "CAN-SPAM compliance", false);

  let fieldsValid = false;
  try { JSON.parse(fieldsJson); fieldsValid = true; } catch {}
  add("Valid fields.json", fieldsValid, fieldsValid ? "OK" : "Invalid JSON", false);

  const criticalChecks = checks.filter(c => c.critical);
  const criticalPassed = criticalChecks.filter(c => c.passed).length;

  return {
    checks,
    criticalPassed,
    criticalTotal: criticalChecks.length,
    overallPass: criticalPassed / criticalChecks.length >= 0.7,
  };
}

function buildPrompt(spec: typeof EMAIL_SPECS[0]): string {
  return `You are an Email Module Developer for HubSpot CMS.

Generate ONE HubSpot CMS email module as JSON. The output MUST be a single JSON object with these exact keys:
- moduleName (string)
- fieldsJson (string - valid JSON for fields.json)
- metaJson (string - valid JSON, must include "host_template_types": ["EMAIL"])
- moduleHtml (string - HubL template with TABLE-BASED layout, ALL CSS inline)
- moduleCss (string - MUST be empty string)
- moduleJs (string - MUST be empty string or null)

CRITICAL EMAIL RULES:
- ALL layout MUST use <table role="presentation" cellpadding="0" cellspacing="0" border="0">
- ALL CSS MUST be inline style attributes on every element - NO <style> blocks
- NO flexbox (display:flex), NO grid (display:grid), NO CSS variables (var())
- NO JavaScript, NO require_css(), NO require_js(), NO scope_css, NO get_asset_url()
- Container width: 600px
- Use web-safe fonts: Arial, Helvetica, sans-serif
- Font sizes in px only
- Images: display:block, border:0, explicit width/height
- Buttons: use table-based "bulletproof buttons" pattern
- Include MSO conditionals for Outlook: <!--[if mso]>...<![endif]-->
- Use HubL: {{ module.field_name }} for dynamic content
- Footer must include {{ unsubscribe_link }} and {{ site_settings.company_name }}
- Field rules: type "text" (never "textarea"), never use "name": "name" (use "item_name")
- Image fields: type "image", default with placehold.co src
- Color fields: type "color", default { "color": "#hex", "opacity": 100 }
- Link fields: type "link", default with url.href and type

Module specification:
- Name: ${spec.name}
- Description: ${spec.description}
- Content Brief: ${spec.contentBrief}
- Layout Notes: ${spec.layoutNotes}

Output ONLY the JSON object, no markdown fences, no explanation. Start with { and end with }.`;
}

async function main() {
  console.log("=== vibeSpot Email Module Generation Spike (VIB-154) ===\n");
  console.log(`Templates to generate: ${EMAIL_SPECS.length}\n`);

  const outDir = path.join(__dirname, "email-spike-output");
  fs.mkdirSync(outDir, { recursive: true });

  const allResults: { name: string; validation: ReturnType<typeof validateEmailModule> }[] = [];

  for (const spec of EMAIL_SPECS) {
    console.log(`\n--- Generating: ${spec.name} ---`);
    const prompt = buildPrompt(spec);

    const promptFile = path.join(outDir, `${spec.name}-prompt.txt`);
    fs.writeFileSync(promptFile, prompt);

    try {
      const start = Date.now();
      const output = execSync(
        `claude -p --model sonnet --output-format text < "${promptFile}"`,
        { encoding: "utf-8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const durationMs = Date.now() - start;
      console.log(`  Generated in ${(durationMs / 1000).toFixed(1)}s`);

      // Extract JSON from output (may be wrapped in markdown fences)
      let jsonStr = output.trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();

      // Try to find JSON object
      const jsonStart = jsonStr.indexOf("{");
      const jsonEnd = jsonStr.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
      }

      const data = JSON.parse(jsonStr);

      const moduleHtml = String(data.moduleHtml || "");
      const moduleCss = String(data.moduleCss || "");
      const moduleJs = data.moduleJs ? String(data.moduleJs) : null;
      const fieldsJson = typeof data.fieldsJson === "string" ? data.fieldsJson : JSON.stringify(data.fieldsJson, null, 2);
      const metaJson = typeof data.metaJson === "string" ? data.metaJson : JSON.stringify(data.metaJson, null, 2);

      console.log(`  HTML length: ${moduleHtml.length} chars`);
      console.log(`  Fields: ${fieldsJson.length} chars`);

      // Save raw output
      fs.writeFileSync(path.join(outDir, `${spec.name}.json`), JSON.stringify(data, null, 2));

      // Save preview HTML
      const previewHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${spec.name}</title></head>
<body style="margin:0;padding:20px;background:#f4f4f4;">
<div style="max-width:700px;margin:0 auto;background:white;">
${moduleHtml}
</div>
</body></html>`;
      fs.writeFileSync(path.join(outDir, `${spec.name}.html`), previewHtml);

      // Validate
      const validation = validateEmailModule(spec.name, moduleHtml, moduleCss, moduleJs, fieldsJson, metaJson);
      allResults.push({ name: spec.name, validation });

      console.log(`  Critical: ${validation.criticalPassed}/${validation.criticalTotal} passed`);
      console.log(`  Overall: ${validation.overallPass ? "PASS" : "FAIL"}`);

      for (const check of validation.checks) {
        if (!check.passed) {
          console.log(`  ✗ ${check.name}: ${check.details}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg.slice(0, 200)}`);
      allResults.push({
        name: spec.name,
        validation: { checks: [], criticalPassed: 0, criticalTotal: 12, overallPass: false },
      });
    }
  }

  // Summary
  console.log("\n\n=== SPIKE RESULTS SUMMARY ===\n");

  const totalPassed = allResults.filter(r => r.validation.overallPass).length;
  const passRate = (totalPassed / allResults.length) * 100;

  for (const r of allResults) {
    const v = r.validation;
    console.log(`${v.overallPass ? "✓ PASS" : "✗ FAIL"} ${r.name}: ${v.criticalPassed}/${v.criticalTotal} critical`);
  }

  console.log(`\nOverall: ${passRate.toFixed(0)}% (${totalPassed}/${allResults.length})`);
  console.log(`Threshold: >70%`);
  console.log(`\nVERDICT: ${passRate >= 70 ? "GO ✓" : "NO-GO ✗"}`);

  // Write summary JSON
  const summary = {
    timestamp: new Date().toISOString(),
    results: allResults.map(r => ({
      name: r.name,
      criticalPassed: r.validation.criticalPassed,
      criticalTotal: r.validation.criticalTotal,
      overallPass: r.validation.overallPass,
      failedChecks: r.validation.checks.filter(c => !c.passed).map(c => ({ name: c.name, details: c.details, critical: c.critical })),
    })),
    passRate,
    verdict: passRate >= 70 ? "GO" : "NO-GO",
  };
  fs.writeFileSync(path.join(outDir, "spike-summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nResults saved to ${outDir}/`);
}

main().catch(console.error);
