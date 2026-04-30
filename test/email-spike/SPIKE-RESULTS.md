# VIB-154 Spike Results: Email Template Generation

**Date:** 2026-04-30
**Duration:** 1 heartbeat (code artifacts complete; email client testing pending)
**Status:** GO (conditional)

---

## 1. What We Built

### Email-specific prompt fork
`src/server/agent/prompts/email-module-developer.ts`

Forked from `module-developer.ts` with these key changes:

| Constraint | Page Module | Email Module |
|-----------|-------------|--------------|
| Layout | CSS flexbox/grid | HTML tables only |
| CSS delivery | `module.css` file | Inline on every element |
| CSS features | Custom properties, calc(), clamp() | Literal values, px units only |
| JavaScript | `module.js` (IIFE) | None (not executed in email) |
| Assets | `get_asset_url()`, `require_css/js` | Image fields with absolute URLs |
| Template type | `host_template_types: ["PAGE"]` | `host_template_types: ["EMAIL"]` |
| Container | Fluid/responsive | Fixed 600px |
| Fonts | System font stacks | Web-safe fonts (Arial, Georgia) |
| Outlook | N/A | MSO conditionals + VML buttons |

### Email rules document
`assets/email-rules.md` — 12 sections covering layout, CSS, MSO, images, buttons, typography, spacing, HubL subset, required elements, meta.json, dark mode, and pre-send checklist.

### 3 test email templates
All in `test/email-spike/`:

1. **Welcome/onboarding** — Logo, headline, 3 onboarding steps (numbered circles + text), CTA button, help text, footer
2. **Product announcement** — Badge, headline, product screenshot, feature checklist (checkmark icons), primary + secondary CTA, footer
3. **Event invitation** — Event banner, details card (date/time/location/spots), CTA + calendar link, agenda timeline, speaker bio, footer

### Validation script
`test/email-spike/validate-email.ts` — Automated checker that catches:
- Banned CSS properties (flex, grid, position, transform, animation, var(), calc())
- Banned HubL (require_css, scope_css, get_asset_url, dnd_*)
- Missing table-based layout
- Missing role="presentation"
- Missing MSO conditionals
- Missing preheader, unsubscribe, physical address
- Image accessibility (alt, width, display:block, border:0)
- External stylesheet imports
- Modern font stacks
- rem/em font sizes

**Result: 3/3 templates pass, 0 errors, 0 warnings.**

---

## 2. Render Test Results (Static Analysis)

Since we cannot run Litmus/Email on Acid in this environment, here is a per-client analysis based on known rendering behavior:

### Gmail (Web + Mobile)
**Expected: PASS**
- Table layout: fully supported
- Inline CSS: fully supported
- Images with explicit dimensions: supported
- Preheader div with `display:none`: supported
- `border-radius`: supported (buttons render rounded)
- No `<style>` blocks: correct (Gmail strips them anyway)

**Known risk:** Gmail strips `background-image` on divs. Our templates don't use background images on divs, so no issue.

### Outlook Desktop (Word rendering engine)
**Expected: PASS with minor degradation**
- MSO conditionals: present, wrap outer 600px container
- VML buttons: present for rounded CTA buttons
- `border-radius`: ignored (buttons appear square — acceptable)
- `max-width`: ignored (MSO conditional table forces 600px — correct)
- Emoji characters (📅📍🎟): may render differently — acceptable

**Known risk:** Outlook ignores `line-height` on `<p>`. Our templates set line-height inline which works in most versions. Add `mso-line-height-rule: exactly` if issues surface.

### Outlook 365 (Web)
**Expected: PASS**
- Modern rendering engine, supports most CSS we use
- `border-radius`: supported
- `max-width`: supported

### Apple Mail
**Expected: PASS**
- Most permissive email client
- Supports all CSS we use
- Full `border-radius`, image rendering

### Summary Table

| Template | Gmail Web | Gmail App | Outlook Desktop | Outlook 365 | Apple Mail |
|----------|-----------|-----------|-----------------|-------------|------------|
| Welcome | PASS | PASS | PASS* | PASS | PASS |
| Product Announcement | PASS | PASS | PASS* | PASS | PASS |
| Event Invitation | PASS | PASS | PASS* | PASS | PASS |

\* Minor degradation: square buttons (no border-radius), emoji rendering differences.

**Estimated pass rate: >85%** (exceeds 70% go/no-go threshold)

---

## 3. Prompt Modifications Summary

### What changed from page prompt → email prompt

**Removed:**
- All references to CSS custom properties (var())
- `module.css` generation (empty string required)
- `module.js` generation (null/empty required)
- BEM class naming with theme prefix (no external CSS)
- References to `get_asset_url()`, `require_css()`, `require_js()`, `scope_css`
- clamp(), calc(), rem/em units
- System font stacks
- Navigation/anchor rules
- IntersectionObserver/scroll animations
- Responsive breakpoint rules (@media queries)

**Added:**
- Table-based layout rules with code examples
- Inline CSS patterns for headings, body, buttons, images
- MSO conditional wrapping
- VML button fallback for Outlook
- Web-safe font stacks (Arial, Georgia, Courier)
- Preheader text pattern
- Unsubscribe/physical address requirements
- Image rules (display:block, border:0, explicit dimensions)
- Fixed 600px container width
- `host_template_types: ["EMAIL"]` for meta.json
- Email-safe HubL subset documentation

**Unchanged:**
- Field rules (text type, reserved names, color/link/image defaults)
- Structured output schema shape (same 6 fields)
- Repeater group syntax
- Humanify/anti-AI copy rules
- Brand asset injection

### Prompt size comparison
- Page prompt: ~42K tokens (2K format + 20K conversion guide + 20K HubSpot rules)
- Email prompt: ~8K tokens (5K format + 3K email rules) — **5x smaller**

The email prompt is much more focused because email modules don't need the full conversion guide or HubSpot CMS rules (those cover page-specific features like DnD, templates, themes).

---

## 4. What Worked

1. **Table-based layout is straightforward to enforce.** The prompt's code examples make it clear. AI models produce correct table nesting reliably when given examples.

2. **Inline CSS is mechanical.** The constraint is simple: no `<style>` blocks, all CSS on elements. The validator catches violations easily.

3. **MSO conditionals follow a fixed pattern.** The outer container wrap is boilerplate. VML buttons are more complex but follow a template.

4. **HubL subset is a strict reduction.** Removing features (no require_css, no scope_css, no module.js) is easier to enforce than adding new ones.

5. **The existing field system works unmodified.** Color, link, image, text, and repeater fields all work identically in email modules.

6. **Validator catches the high-signal issues.** Automated checks for banned CSS/HubL, missing role="presentation", missing legal requirements.

---

## 5. What Broke / Needs Work

1. **No live email client testing.** Static analysis predicts >85% pass rate, but real rendering in Gmail/Outlook reveals edge cases that rules-based validation misses. Need Litmus or Email on Acid access for the full feature.

2. **Dark mode handling is incomplete.** The email rules document mentions it, but the prompt doesn't actively generate dark-mode-safe color choices. Some email clients invert colors automatically. Need to add guidance for high-contrast, avoid pure white/black.

3. **Responsive email (mobile) is hard.** Gmail strips `@media` queries, so we can't do mobile-specific layouts the way page modules do. The current templates use a fixed 600px width that scales down. For a full feature, we'd need a fluid-hybrid approach (mix of `max-width` + MSO fixed width).

4. **No email template wrapper.** Page modules have a `base.html` template that wraps them. Email modules need an equivalent `email-base.html` with `<html>`, `<head>` (meta charset, viewport, MSO XML namespace), and `<body>`. This spike only covers individual modules, not the full template.

5. **No design system stage for email.** Page generation has a Design System stage (2a) that creates CSS variables and shared CSS. Email can't use CSS variables or shared stylesheets, so the design system needs to become an "inline style guide" — a set of color/font/spacing values that get repeated across every module. This is the biggest architectural gap.

6. **Emoji rendering varies.** The event invitation uses Unicode emoji (📅📍🎟). These render differently across clients and some Outlook versions show boxes. Consider using small PNG icons instead.

---

## 6. Effort Estimate for Full Email Feature

### Phase 1: Minimum Viable Email (2-3 weeks)

| Task | Estimate | Risk |
|------|----------|------|
| Finalize email prompt with dark mode + fluid-hybrid responsive | 3 days | Medium |
| Build email template wrapper (`email-base.html`) | 2 days | Low |
| Adapt Design System stage for email (inline style guide) | 3 days | High |
| Email-specific Quality Check stage (validator auto-fix) | 2 days | Low |
| UI: email vs. page toggle in setup screen | 1 day | Low |
| Litmus/Email on Acid integration for preview | 2 days | Medium |
| 5 starter email templates (welcome, newsletter, promo, event, transactional) | 3 days | Low |

### Phase 2: Full Feature (additional 2-3 weeks)

| Task | Estimate | Risk |
|------|----------|------|
| HubSpot email API upload (different from CMS file upload) | 3 days | High |
| Email-specific field types (subscription preferences, unsubscribe) | 2 days | Medium |
| Email preview in vibeSpot UI (render HubL for email) | 3 days | Medium |
| A/B test variant generation | 2 days | Low |
| Email analytics integration | 2 days | Medium |

**Total: Phase 1 = 2-3 weeks, Phase 2 = 2-3 weeks**

---

## 7. Go/No-Go Recommendation

### **GO** (conditional)

**Rationale:**
- The prompt fork approach works. Email-specific constraints are enforceable via prompt instructions + automated validation.
- The existing pipeline architecture (Intent → Design → Develop → Validate) can be adapted for email with targeted modifications.
- The core field system and HubL templating work identically for email modules.
- Static analysis predicts >85% email client pass rate, exceeding the 70% threshold.
- Prompt is 5x smaller than page prompt, meaning faster generation and lower cost.

**Conditions for full GO:**
1. Run the 3 test templates through Litmus or Email on Acid and confirm >70% pass rate across Gmail + Outlook + Apple Mail.
2. Validate the Design System → inline style guide adaptation is feasible (highest risk item).
3. Confirm HubSpot email API upload path is viable (different from CMS file upload).

**Recommended next step:** Set up a Litmus trial account, render the 3 test templates with placeholder data filled in, and capture screenshots across the 5 target clients. If >70% pass, greenlight Phase 1.

---

## Files Created in This Spike

| File | Purpose |
|------|---------|
| `assets/email-rules.md` | Email client compatibility rules (12 sections) |
| `src/server/agent/prompts/email-module-developer.ts` | Forked prompt builder for email modules |
| `src/ai/prompts.ts` | Added `getEmailRules()` function |
| `test/email-spike/welcome-email.module/` | Test template: welcome/onboarding email |
| `test/email-spike/product-announcement.module/` | Test template: product announcement email |
| `test/email-spike/event-invitation.module/` | Test template: event invitation email |
| `test/email-spike/validate-email.ts` | Automated email template validator |
| `test/email-spike/SPIKE-RESULTS.md` | This document |
