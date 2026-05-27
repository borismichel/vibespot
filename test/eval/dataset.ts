/**
 * Eval dataset — reference inputs for the provider-comparison harness (VIB-1768).
 *
 * Each item is a "create a landing page" brief (the production input a user
 * types into vibe coding mode) paired with the signals we score against:
 *  - `expectedModules`: the module kinds a good page should contain. Drives the
 *    rule-based coverage score (did the provider plan the right sections?).
 *  - `rubric`: a free-text description of "good" handed to the LLM-as-judge.
 *
 * We deliberately score against briefs + rubrics rather than a single golden
 * HTML output: there is no one correct HubSpot module for a brief, so an
 * exact-match expectation would be brittle and reward memorisation over
 * quality. The validator pass-rate measures *correctness* (valid HubSpot/HubL)
 * and the judge measures *fidelity* to the brief — the two axes that matter.
 *
 * These briefs mirror the shipped starter templates and the `test/validate.ts`
 * conversion fixtures (SaaS / portfolio / restaurant / event), so the dataset
 * is representative of real vibeSpot usage. To add a `test/validate.ts`-style
 * React/Lovable fixture, add an item whose `brief` is the "convert this page"
 * instruction and whose `expectedModules` match the source page's sections.
 */

export type EvalContentType = "page" | "email" | "blog";

export interface ExpectedModule {
  /** Canonical kebab name for this section (matched against generated names). */
  name: string;
  /** Synonyms / content keywords — a match on any counts the section covered. */
  keywords: string[];
}

export interface EvalItem {
  /** Stable id — used as the Langfuse dataset-item key and output filename. */
  id: string;
  title: string;
  contentType: EvalContentType;
  /** The user message that drives generation (the real production input). */
  brief: string;
  /** Module kinds a strong page should contain (drives coverage score). */
  expectedModules: ExpectedModule[];
  /** What "good" looks like — handed verbatim to the LLM-as-judge. */
  rubric: string;
}

export const EVAL_DATASET: EvalItem[] = [
  {
    id: "saas-analytics",
    title: "SaaS analytics product landing page",
    contentType: "page",
    brief:
      "Create a landing page for 'Pulse', a SaaS product analytics platform that helps product teams understand user behaviour without writing SQL. Include a hero with a headline, subhead and a 'Start free trial' CTA, a logo/trust bar of customer logos, a 3-up feature grid (autocapture, funnels, retention), a section with a product screenshot and supporting copy, a pricing teaser with 3 tiers, a testimonial, and a footer with newsletter signup.",
    expectedModules: [
      { name: "hero", keywords: ["hero", "headline", "trial"] },
      { name: "trust-bar", keywords: ["trust", "logo", "customers", "logos"] },
      { name: "feature-grid", keywords: ["feature", "grid", "funnel", "retention"] },
      { name: "product-showcase", keywords: ["screenshot", "showcase", "product", "preview"] },
      { name: "pricing", keywords: ["pricing", "tier", "plan", "price"] },
      { name: "testimonial", keywords: ["testimonial", "quote", "review"] },
      { name: "footer", keywords: ["footer", "newsletter", "signup"] },
    ],
    rubric:
      "A high-converting B2B SaaS page: punchy value proposition in the hero, a credible trust bar, scannable feature grid that maps to the three named features, a clear pricing teaser, and one specific testimonial. Copy should be concrete and benefit-led, not buzzword soup.",
  },
  {
    id: "design-agency",
    title: "Creative design agency / portfolio site",
    contentType: "page",
    brief:
      "Build a landing page for 'Atelier Nord', a Berlin design studio specialising in brand identity and packaging. Include a bold hero with the studio name and a one-line positioning statement, an 'about' section describing the studio's approach, a portfolio grid showcasing 6 projects with images and client names, a services list (branding, packaging, art direction), a short founder bio, and a contact section with an email CTA.",
    expectedModules: [
      { name: "hero", keywords: ["hero", "studio", "positioning"] },
      { name: "about", keywords: ["about", "approach", "studio"] },
      { name: "portfolio-grid", keywords: ["portfolio", "projects", "gallery", "work", "grid"] },
      { name: "services", keywords: ["services", "branding", "packaging"] },
      { name: "founder-bio", keywords: ["founder", "bio", "team", "about"] },
      { name: "contact", keywords: ["contact", "email", "get in touch"] },
    ],
    rubric:
      "An editorial, visually confident agency site. The portfolio grid is the centrepiece and should support 6 project items with image + client. Tone is understated and design-literate. Layout should feel spacious and intentional, not template-y.",
  },
  {
    id: "restaurant",
    title: "Restaurant landing page",
    contentType: "page",
    brief:
      "Create a one-page site for 'Olive & Ember', a wood-fired Mediterranean restaurant. Include a hero with the restaurant name, tagline and a 'Reserve a table' CTA, a short story/about section, a menu highlights section grouped into starters/mains/desserts, a gallery of dishes, opening hours and location with an address, and a footer with social links and a reservation CTA.",
    expectedModules: [
      { name: "hero", keywords: ["hero", "reserve", "tagline"] },
      { name: "about", keywords: ["about", "story"] },
      { name: "menu", keywords: ["menu", "starters", "mains", "desserts", "dishes"] },
      { name: "gallery", keywords: ["gallery", "photos", "dishes", "images"] },
      { name: "hours-location", keywords: ["hours", "location", "address", "opening"] },
      { name: "footer", keywords: ["footer", "social", "reservation"] },
    ],
    rubric:
      "An appetising, warm restaurant page. The menu section must be grouped into the three named courses. Hours + location must show a real address format. CTA to reserve appears in both hero and footer. Imagery-forward and inviting.",
  },
  {
    id: "webinar-event",
    title: "Webinar / event registration page",
    contentType: "page",
    brief:
      "Build a registration landing page for a free webinar 'Building HubSpot Themes with AI'. Include a hero with the event title, date/time and a 'Register now' CTA, a section describing what attendees will learn (3 takeaways), a speaker section with photo and bio, an agenda with 4 timestamped items, a registration form section, and an FAQ with 3 questions.",
    expectedModules: [
      { name: "hero", keywords: ["hero", "register", "date", "webinar"] },
      { name: "takeaways", keywords: ["learn", "takeaways", "benefits", "what you"] },
      { name: "speaker", keywords: ["speaker", "bio", "host", "presenter"] },
      { name: "agenda", keywords: ["agenda", "schedule", "timeline"] },
      { name: "registration-form", keywords: ["register", "form", "signup", "registration"] },
      { name: "faq", keywords: ["faq", "questions", "answers"] },
    ],
    rubric:
      "A focused event page that drives registrations. Date/time is prominent in the hero. The agenda lists 4 timestamped items and the takeaways list 3 concrete outcomes. The registration section reads as a form. FAQ answers common objections.",
  },
  {
    id: "mobile-app",
    title: "Mobile app marketing page",
    contentType: "page",
    brief:
      "Create a marketing page for 'Trailhead', a hiking companion mobile app with offline maps and trail conditions. Include a hero with an app mockup, headline and App Store / Google Play badges, a features section (offline maps, live trail conditions, GPX export) with icons, a 'how it works' 3-step section, user reviews/ratings, a screenshots carousel section, and a final download CTA.",
    expectedModules: [
      { name: "hero", keywords: ["hero", "app", "download", "mockup", "badges"] },
      { name: "features", keywords: ["features", "offline", "maps", "trail"] },
      { name: "how-it-works", keywords: ["how it works", "steps", "step"] },
      { name: "reviews", keywords: ["reviews", "ratings", "testimonial"] },
      { name: "screenshots", keywords: ["screenshots", "carousel", "gallery", "preview"] },
      { name: "download-cta", keywords: ["download", "cta", "app store", "google play"] },
    ],
    rubric:
      "A consumer app page. The hero shows store badges and an app mockup. Features map to the three named capabilities. 'How it works' has exactly three steps. Includes social proof via ratings. Closes with a strong download CTA.",
  },
  {
    id: "consulting",
    title: "B2B consulting / professional services page",
    contentType: "page",
    brief:
      "Build a landing page for 'Meridian Advisory', a boutique data & analytics consultancy. Include a hero with a clear value proposition and a 'Book a consultation' CTA, a credibility bar with stats (years in business, clients served, projects delivered), a services section (data strategy, analytics engineering, executive dashboards), a case-study highlight with a measurable result, a team/leadership section, and a contact section with a consultation CTA.",
    expectedModules: [
      { name: "hero", keywords: ["hero", "consultation", "value"] },
      { name: "stats-bar", keywords: ["stats", "metrics", "years", "clients", "numbers"] },
      { name: "services", keywords: ["services", "strategy", "analytics", "dashboards"] },
      { name: "case-study", keywords: ["case study", "result", "outcome", "success"] },
      { name: "team", keywords: ["team", "leadership", "people"] },
      { name: "contact", keywords: ["contact", "consultation", "book"] },
    ],
    rubric:
      "A credible, results-oriented professional-services page. The stats bar shows three concrete numbers. The case study cites a measurable outcome. Services map to the three named offerings. Tone is authoritative but not jargon-heavy.",
  },
];
