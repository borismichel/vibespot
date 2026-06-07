/**
 * Judge calibration ground-truth set (VIB-1863).
 *
 * The eval LLM-judge (`judge.ts`) scores pages on four 1–5 dimensions, and the
 * benchmark numbers (VIB-1833) lean on it — but the judge had never been
 * validated against human labels. Per the langfuse skill's `judge-calibration`
 * reference, a judge must be calibrated (exact-match accuracy vs a ground-truth
 * `expectedOutput`) before it is trusted for comparison decisions.
 *
 * This file is that ground truth: a small set of pages paired with a **human
 * PASS/FAIL label**. We deliberately hand-author the pages rather than scrape
 * real benchmark output, for three reasons:
 *
 *  1. Reproducible in CI — no keys, no network, no drifting third-party output.
 *  2. The correct label is unambiguous *by construction* — each page is built to
 *     be clearly shippable or clearly broken, so the human label is defensible
 *     without a separate annotation panel. (The two "borderline" rows are the
 *     honest exception, kept to probe the judge's discrimination near the line.)
 *  3. It exercises the exact failure modes the judge exists to catch: missing
 *     brief sections, non-editable hard-coded content, broken HubL, and generic
 *     buzzword filler.
 *
 * Each fixture reuses a real brief + rubric from `dataset.ts` (the judge is fed
 * the same input it sees in production), so accuracy here is a direct read on
 * whether the judge agrees with a human about "would this ship?".
 *
 * To grow the set: add rows here (ideally real reviewed benchmark pages with a
 * human label), re-run `npm run eval:calibrate`. More rows = a tighter accuracy
 * estimate. This is a bootstrap set, not a held-out test split — see the
 * calibration report's caveats.
 */

import type { ModuleFiles } from "../../src/ai/engine.js";
import { EVAL_DATASET, type EvalItem } from "./dataset.js";

export type HumanLabel = "PASS" | "FAIL";

export interface CalibrationFixture {
  /** Stable id — Langfuse dataset-item key + report row id. */
  id: string;
  /** Which brief/rubric the judge grades this page against. */
  datasetItemId: string;
  /** Human ground-truth verdict: would a competent reviewer ship this page? */
  label: HumanLabel;
  /** Why the human assigned this label (the rationale a reviewer would give). */
  note: string;
  /** The page the judge scores. */
  modules: ModuleFiles[];
}

function itemById(id: string): EvalItem {
  const item = EVAL_DATASET.find((i) => i.id === id);
  if (!item) throw new Error(`calibration-set: no dataset item "${id}"`);
  return item;
}

/** Compact module builder — fills the rarely-inspected fields with sane defaults. */
function mod(
  name: string,
  html: string,
  fields: unknown[] = [],
): ModuleFiles {
  return {
    moduleName: name,
    moduleHtml: html,
    fieldsJson: JSON.stringify(fields, null, 2),
    metaJson: JSON.stringify({ label: name, content_types: ["LANDING_PAGE", "SITE_PAGE"], is_available_for_new_content: true }, null, 2),
    moduleCss: `.${name} { padding: 64px 24px; }`,
  };
}

/** A text field whose value flows through an editable `{{ module.x }}` token. */
function field(name: string, label: string, def: string) {
  return { name, label, type: "text", default: def };
}

// --- Known-GOOD pages: complete, editable, concrete copy --------------------

const SAAS_GOOD: ModuleFiles[] = [
  mod(
    "hero",
    `<section class="hero"><h1>{{ module.headline }}</h1><p>{{ module.subhead }}</p><a class="btn" href="{{ module.cta_url }}">{{ module.cta_label }}</a></section>`,
    [
      field("headline", "Headline", "Understand what users actually do — no SQL required"),
      field("subhead", "Subhead", "Pulse auto-captures every product event so your team can answer behaviour questions in seconds, not sprints."),
      field("cta_label", "CTA label", "Start free trial"),
      { name: "cta_url", label: "CTA URL", type: "url", default: { href: "/signup" } },
    ],
  ),
  mod(
    "trust-bar",
    `<section class="trust-bar"><p>{{ module.eyebrow }}</p>{% for logo in module.logos %}<img src="{{ logo.src }}" alt="{{ logo.alt }}">{% endfor %}</section>`,
    [field("eyebrow", "Eyebrow", "Trusted by product teams at"), { name: "logos", label: "Logos", type: "image", occurrence: { min: 3, max: 8 } }],
  ),
  mod(
    "feature-grid",
    `<section class="feature-grid">{% for f in module.features %}<div class="feature"><h3>{{ f.title }}</h3><p>{{ f.body }}</p></div>{% endfor %}</section>`,
    [{ name: "features", label: "Features", type: "group", occurrence: { min: 3, max: 3 }, default: [
      { title: "Autocapture", body: "Track every click and pageview automatically — no tracking plan to maintain." },
      { title: "Funnels", body: "See exactly where users drop off across any multi-step flow." },
      { title: "Retention", body: "Measure whether new features actually bring people back week over week." },
    ] }],
  ),
  mod("product-showcase", `<section class="product-showcase"><img src="{{ module.screenshot.src }}" alt="{{ module.screenshot.alt }}"><div><h2>{{ module.title }}</h2><p>{{ module.body }}</p></div></section>`, [field("title", "Title", "Your whole funnel, on one screen")]),
  mod("pricing", `<section class="pricing">{% for tier in module.tiers %}<div class="tier"><h3>{{ tier.name }}</h3><p class="price">{{ tier.price }}</p></div>{% endfor %}</section>`, [{ name: "tiers", label: "Tiers", type: "group", default: [{ name: "Free", price: "$0" }, { name: "Team", price: "$49/mo" }, { name: "Scale", price: "Custom" }] }]),
  mod("testimonial", `<section class="testimonial"><blockquote>{{ module.quote }}</blockquote><cite>{{ module.author }}</cite></section>`, [field("quote", "Quote", "We cut our time-to-insight from days to minutes. Pulse paid for itself in the first week.")]),
  mod("footer", `<footer class="footer"><form>{{ module.newsletter_label }}<input type="email" name="email"></form></footer>`, [field("newsletter_label", "Newsletter label", "Get product analytics tips, monthly")]),
];

const RESTAURANT_GOOD: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>{{ module.name }}</h1><p>{{ module.tagline }}</p><a href="{{ module.cta_url }}">{{ module.cta_label }}</a></section>`, [field("name", "Name", "Olive & Ember"), field("tagline", "Tagline", "Wood-fired Mediterranean, served the way the coast intended."), field("cta_label", "CTA", "Reserve a table")]),
  mod("about", `<section class="about"><h2>{{ module.heading }}</h2><p>{{ module.story }}</p></section>`, [field("story", "Story", "We cook over live fire because it brings out something gas never can — char, smoke, and the kind of flavour you remember.")]),
  mod("menu", `<section class="menu">{% for course in module.courses %}<div><h3>{{ course.name }}</h3>{% for d in course.dishes %}<p>{{ d.name }} — {{ d.price }}</p>{% endfor %}</div>{% endfor %}</section>`, [{ name: "courses", label: "Courses", type: "group", default: [
    { name: "Starters", dishes: [{ name: "Charred octopus", price: "14" }] },
    { name: "Mains", dishes: [{ name: "Wood-fired lamb", price: "28" }] },
    { name: "Desserts", dishes: [{ name: "Burnt honey tart", price: "11" }] },
  ] }]),
  mod("gallery", `<section class="gallery">{% for img in module.images %}<img src="{{ img.src }}" alt="{{ img.alt }}">{% endfor %}</section>`, [{ name: "images", label: "Images", type: "image", occurrence: { min: 3, max: 12 } }]),
  mod("hours-location", `<section class="hours-location"><p>{{ module.hours }}</p><address>{{ module.address }}</address></section>`, [field("address", "Address", "42 Harbour Lane, Brighton BN1 2AB")]),
  mod("footer", `<footer class="footer"><a href="{{ module.reserve_url }}">{{ module.reserve_label }}</a>{% for s in module.socials %}<a href="{{ s.url }}">{{ s.network }}</a>{% endfor %}</footer>`, [field("reserve_label", "Reserve", "Book your table")]),
];

const WEBINAR_GOOD: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>{{ module.title }}</h1><p class="when">{{ module.datetime }}</p><a href="{{ module.cta_url }}">{{ module.cta_label }}</a></section>`, [field("title", "Title", "Building HubSpot Themes with AI"), field("datetime", "Date/time", "Thursday 26 June, 4:00pm BST"), field("cta_label", "CTA", "Register now")]),
  mod("takeaways", `<section class="takeaways">{% for t in module.items %}<li>{{ t.text }}</li>{% endfor %}</section>`, [{ name: "items", label: "Takeaways", type: "group", default: [{ text: "Turn a Lovable export into native HubSpot modules" }, { text: "Wire editable fields so marketers can self-serve" }, { text: "Ship a themed page without touching HubL by hand" }] }]),
  mod("speaker", `<section class="speaker"><img src="{{ module.photo.src }}" alt="{{ module.name }}"><h3>{{ module.name }}</h3><p>{{ module.bio }}</p></section>`, [field("name", "Name", "Boris Michel"), field("bio", "Bio", "Founder of vibeSpot, 10 years shipping HubSpot CMS themes.")]),
  mod("agenda", `<section class="agenda">{% for a in module.items %}<p>{{ a.time }} — {{ a.title }}</p>{% endfor %}</section>`, [{ name: "items", label: "Agenda", type: "group", default: [{ time: "4:00", title: "Intro" }, { time: "4:10", title: "Live conversion" }, { time: "4:35", title: "Editable fields" }, { time: "4:50", title: "Q&A" }] }]),
  mod("registration-form", `<section class="registration-form"><form>{{ module.heading }}<input name="email" type="email"><button>{{ module.submit_label }}</button></form></section>`, [field("submit_label", "Submit", "Save my seat")]),
  mod("faq", `<section class="faq">{% for q in module.items %}<details><summary>{{ q.q }}</summary><p>{{ q.a }}</p></details>{% endfor %}</section>`, [{ name: "items", label: "FAQ", type: "group", default: [{ q: "Is it free?", a: "Yes, completely." }, { q: "Will it be recorded?", a: "Yes, all registrants get the replay." }, { q: "Do I need HubSpot?", a: "A free CMS sandbox is enough to follow along." }] }]),
];

// --- Known-BAD pages: each breaks the judge's dimensions in a clear way ------

/** Empty page — the no-modules degenerate case. */
const EMPTY_PAGE: ModuleFiles[] = [];

/** SaaS brief, but hard-coded (no editable fields) and missing half the sections. */
const SAAS_NO_FIELDS_MISSING: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>Welcome to our platform</h1><p>The best solution for your business needs.</p><a href="#">Click here</a></section>`),
  mod("feature-grid", `<section class="feature-grid"><div><h3>Powerful</h3><p>Our solution is powerful and easy to use.</p></div><div><h3>Fast</h3><p>Leverage cutting-edge technology to drive results.</p></div></section>`),
];

/** Restaurant brief, but broken HubL (unclosed for) + generic filler, no menu courses. */
const RESTAURANT_BROKEN_HUBL: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>{{ module.name }}</h1><p>A great place to eat delicious food.</p></section>`, [field("name", "Name", "Our Restaurant")]),
  mod("menu", `<section class="menu">{% for d in module.dishes %}<p>{{ d.name }}</p><section class="menu">`, [{ name: "dishes", label: "Dishes", type: "group", default: [] }]),
  mod("about", `<section class="about"><p>We serve food made with passion and the finest ingredients to deliver an unforgettable experience.</p></section>`),
];

/** Webinar brief, but buzzword soup, wrong section count, no form, no date. */
const WEBINAR_GENERIC: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>Join Our Webinar</h1><p>An exciting opportunity you won't want to miss!</p></section>`),
  mod("content", `<section class="content"><p>In today's fast-paced digital landscape, leveraging synergies is mission-critical. Our world-class experts will unlock actionable insights to supercharge your growth and drive transformational outcomes at scale.</p></section>`),
];

/** Consulting brief, but only a single empty shell — clearly not shippable. */
const CONSULTING_SHELL: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>Consulting Services</h1></section>`),
];

// --- Borderline pages: honest near-the-line cases ---------------------------

/** SaaS: complete + editable, but copy is thin/generic — a "weak pass" page.
 *  Human verdict PASS (it would ship), but the judge could reasonably waver. */
const SAAS_THIN_COPY: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>{{ module.headline }}</h1><p>{{ module.subhead }}</p><a href="{{ module.cta_url }}">{{ module.cta_label }}</a></section>`, [field("headline", "Headline", "Product analytics made simple"), field("subhead", "Subhead", "Understand your users and grow your product."), field("cta_label", "CTA", "Start free trial")]),
  mod("feature-grid", `<section class="feature-grid">{% for f in module.features %}<div><h3>{{ f.title }}</h3><p>{{ f.body }}</p></div>{% endfor %}</section>`, [{ name: "features", label: "Features", type: "group", default: [{ title: "Autocapture", body: "Capture events automatically." }, { title: "Funnels", body: "Build funnels easily." }, { title: "Retention", body: "Track retention over time." }] }]),
  mod("pricing", `<section class="pricing">{% for t in module.tiers %}<div><h3>{{ t.name }}</h3><p>{{ t.price }}</p></div>{% endfor %}</section>`, [{ name: "tiers", label: "Tiers", type: "group", default: [{ name: "Free", price: "$0" }, { name: "Pro", price: "$49" }, { name: "Enterprise", price: "Custom" }] }]),
  mod("testimonial", `<section class="testimonial"><blockquote>{{ module.quote }}</blockquote></section>`, [field("quote", "Quote", "Great product, highly recommend.")]),
  mod("footer", `<footer><form><input type="email" name="email"></form></footer>`),
];

/** Restaurant: mostly good but missing the gallery + hours/location the brief
 *  named — a "weak fail" (incomplete enough that a reviewer sends it back). */
const RESTAURANT_INCOMPLETE: ModuleFiles[] = [
  mod("hero", `<section class="hero"><h1>{{ module.name }}</h1><p>{{ module.tagline }}</p><a href="#">{{ module.cta_label }}</a></section>`, [field("name", "Name", "Olive & Ember"), field("tagline", "Tagline", "Wood-fired Mediterranean cooking."), field("cta_label", "CTA", "Reserve a table")]),
  mod("about", `<section class="about"><p>{{ module.story }}</p></section>`, [field("story", "Story", "We cook over live fire for flavour you can taste.")]),
  mod("menu", `<section class="menu">{% for c in module.courses %}<h3>{{ c.name }}</h3>{% endfor %}</section>`, [{ name: "courses", label: "Courses", type: "group", default: [{ name: "Starters" }, { name: "Mains" }, { name: "Desserts" }] }]),
];

export const CALIBRATION_SET: CalibrationFixture[] = [
  // Clear PASS
  { id: "saas-good", datasetItemId: "saas-analytics", label: "PASS", note: "All 7 brief sections present, every block uses editable {{ module.x }} fields, concrete benefit-led copy. Ships as-is.", modules: SAAS_GOOD },
  { id: "restaurant-good", datasetItemId: "restaurant", label: "PASS", note: "Menu grouped into the three named courses, real address format, reserve CTA in hero + footer, fielded throughout.", modules: RESTAURANT_GOOD },
  { id: "webinar-good", datasetItemId: "webinar-event", label: "PASS", note: "Date/time prominent, 3 takeaways, 4 agenda items, real form section, 3 FAQs — matches the brief structurally and editorially.", modules: WEBINAR_GOOD },

  // Clear FAIL
  { id: "empty-page", datasetItemId: "saas-analytics", label: "FAIL", note: "No modules at all — nothing to ship.", modules: EMPTY_PAGE },
  { id: "saas-no-fields", datasetItemId: "saas-analytics", label: "FAIL", note: "Hard-coded content (no editable fields — unusable in HubSpot), generic filler, and 5 of 7 brief sections missing.", modules: SAAS_NO_FIELDS_MISSING },
  { id: "restaurant-broken-hubl", datasetItemId: "restaurant", label: "FAIL", note: "Unclosed {% for %} loop (broken HubL — won't render), empty menu, generic copy, gallery + hours missing.", modules: RESTAURANT_BROKEN_HUBL },
  { id: "webinar-generic", datasetItemId: "webinar-event", label: "FAIL", note: "Pure buzzword soup, no date, no speaker, no agenda, no registration form — fails the brief on every axis.", modules: WEBINAR_GENERIC },
  { id: "consulting-shell", datasetItemId: "consulting", label: "FAIL", note: "A single empty hero shell — none of the six named sections, no content.", modules: CONSULTING_SHELL },

  // Borderline (the honest near-the-line probes)
  { id: "saas-thin-copy", datasetItemId: "saas-analytics", label: "PASS", note: "Borderline: complete + editable so it would ship, but copy is thin/generic. A human passes it; the judge may waver.", modules: SAAS_THIN_COPY },
  { id: "restaurant-incomplete", datasetItemId: "restaurant", label: "FAIL", note: "Borderline: clean as far as it goes, but missing the gallery and hours/location the brief named — a reviewer sends it back.", modules: RESTAURANT_INCOMPLETE },
];
