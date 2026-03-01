# CONTENT.md — Landing Page Content Population Rules

> This file teaches Claude Code HOW to fill pages with rich, believable, lively content. The design system (CLAUDE.md) handles look and feel. This file handles **substance** — so pages never feel like empty shells with nice fonts.

---

## The Core Problem You Must Solve

AI-generated landing pages almost always have the same failure mode: **great hero, then a ghost town.** The headline is punchy, the font is bold, but scroll down and you find: empty card outlines, one lonely testimonial, a "How it Works" section with 3 vague steps, and vast stretches of background with nothing in them.

**Real landing pages are DENSE with content.** Not cluttered — dense. Every section earns its space with specific, concrete, believable information. Your job is to generate pages that feel like a real business made them, not like a wireframe with a nice coat of paint.

---

## 1. Page Architecture — The Full Section Blueprint

Every landing page you generate MUST include ALL of the following sections, in roughly this order. Never skip sections. Never leave sections half-populated. If the user only asked for a "landing page," they mean **all of this.**

### MANDATORY SECTIONS (generate all of these):

```
1. NAVIGATION BAR
   - Logo/brand name (left)
   - 4-5 nav links (center or right)
   - CTA button (right, contrasting style)
   - Sticky on scroll with backdrop-blur

2. HERO
   - Badge/pill label (e.g., "⚡ Same-Day Service" or "New: AI-powered")
   - Primary headline (bold, emotional, specific)
   - Subheadline (1-2 sentences, supporting detail)
   - Primary CTA button (with price/action hint)
   - Secondary CTA or link (lower commitment option)
   - Trust signals directly below CTAs (e.g., "★ 4.9 from 200+ reviews" or "No credit card required")
   - Visual element (illustration, product shot placeholder, gradient shape, or decorative graphic)

3. SOCIAL PROOF BAR (immediately after hero)
   - Logo strip of 4-6 clients/partners/press mentions
   - OR a stats bar: "500+ customers · 4.9★ rating · 12 cities · Same-day available"
   - This section can be compact (py-8) — it's a trust bridge between hero and content

4. FEATURES / SERVICES (what you offer)
   - Section label + headline
   - 3-6 feature cards, each with:
     · Icon (Lucide)
     · Title (short, specific)
     · Description (2-3 sentences of REAL detail)
     · Optional: metric, link, or mini-visual
   - Layout: grid, bento, or alternating left/right

5. HOW IT WORKS (process/steps)
   - Section label + headline
   - 3-4 numbered steps, each with:
     · Step number (styled prominently)
     · Title (action verb)
     · Description (what happens, how long, what user does)
     · Visual or icon per step
   - Connected by a visual line, arrows, or numbered flow

6. SOCIAL PROOF / TESTIMONIALS
   - Section label + headline
   - AT LEAST 3 testimonials (never just 1!)
   - Each testimonial MUST include:
     · Full quote (2-4 sentences, specific and believable)
     · Person's name
     · Role or context (e.g., "Tenant, Schwabing" or "Marketing Lead, Acme Corp")
     · Star rating (visual stars)
     · Optional: avatar placeholder (colored circle with initials)
   - Layout: 3-column grid, carousel hint, or stacked cards

7. PRICING or VALUE PROPOSITION
   - If service business: pricing table or "starting from" cards
   - If SaaS: 2-3 tier pricing cards with feature lists
   - If not pricing, then a strong VALUE section:
     · Key metrics in large text (e.g., "47% faster", "€2.1M saved", "3x more leads")
     · Supporting context for each metric
   - Always include a CTA in this section

8. FAQ
   - Section label + headline
   - 4-6 questions with answers
   - Use expandable accordion or visible Q&A pairs
   - Questions should address REAL concerns (pricing, timing, guarantees, scope)
   - Answers should be specific, not generic

9. FINAL CTA (closing section)
   - Strong headline (restate the core promise or urgency)
   - Subtext (remove last objections)
   - Primary + Secondary CTA buttons
   - Optional: guarantee badge, trust signal, or urgency element
   - This section should feel visually distinct (different background shade, or bold color)

10. FOOTER
    - Brand name + one-line tagline
    - 3-4 link columns (Services, Company, Support, Legal)
    - Each column has 3-5 links
    - Contact info (email, phone, or address)
    - Social media icons (Lucide: twitter/x, instagram, linkedin, facebook)
    - Copyright line
    - Optional: small trust badges (payment methods, certifications)
```

### OPTIONAL SECTIONS (include 1-2 when they fit):
- **Comparison table** — "Us vs. Them" or "Before/After"
- **Case study highlight** — One customer story in detail
- **Team/About strip** — 3-4 team member cards (for service businesses)
- **Blog/Resource teasers** — 3 recent article cards
- **Partners/Integrations** — Logo grid with names
- **Map/Service area** — For local businesses
- **Video embed placeholder** — With play button overlay on a gradient thumbnail

---

## 2. Content Voice & Copywriting Rules

### Headlines: The "Bar Test"
Every headline should pass the **bar test**: if you shouted it across a bar, would someone turn their head? If not, rewrite.

```
❌ "Our Services" → ✅ "What We Actually Do"
❌ "How It Works" → ✅ "Unclogged in 3 Steps"
❌ "Pricing" → ✅ "Cheaper Than Your Uber Eats Habit"
❌ "Testimonials" → ✅ "Don't Take Our Word For It"
❌ "Get Started" → ✅ "Blocked Drain? Text Us a Photo."
❌ "Features" → ✅ "Everything You Get, Nothing You Don't"
❌ "About Us" → ✅ "Started in a Garage. Now We Run the Block."
```

### Section Labels (the small text above headlines)
Always include these. They orient the reader and add visual rhythm.
```
- Use UPPERCASE TRACKING (letter-spacing: 0.1em)
- Keep to 2-3 words
- Use accent color
- Examples: "HOW IT WORKS" · "STUDENT PRICING" · "REAL REVIEWS" · "THE PROCESS" · "WHY US"
```

### Body Copy Rules
- **Never write generic filler.** Every sentence should contain a SPECIFIC detail.
- Invent plausible specifics that match the business type:
  · Neighborhood names, not just "your area"
  · "48 hours" not "quickly"
  · "€49" not "affordable pricing"
  · "Sarah, Tenant in Schwabing" not "Happy Customer"
- Keep paragraphs to 2-3 sentences maximum
- Aim for 6th-grade reading level (short words, short sentences)
- Write like a human who's slightly funny, not like a brochure

### CTA Button Copy
Never use "Submit" or "Learn More." Always tie the CTA to a specific outcome:
```
✅ "Book Now — From €49 →"
✅ "Start Free Trial · No Card Required"
✅ "Get My Custom Quote in 10 Min"
✅ "See Pricing →"
✅ "Join 2,000+ Happy Customers"
✅ "Send Us a Photo via WhatsApp"
✅ "Download the Free Guide"
```

---

## 3. Content Density Rules — Never Leave Empty Space

### The "Scroll Test"
Scroll through your generated page mentally. At EVERY viewport-height (100vh), the user should see:
- At least one piece of **specific data** (number, price, time, rating)
- At least one piece of **social proof** (quote, logo, rating, customer count)
- At least one **visual element** (icon, illustration, decorative shape, gradient block)
- A clear sense of **what section they're in** (label + headline visible)

### Minimum Content Quantities
| Element | Minimum | Why |
|---------|---------|-----|
| Testimonials | 3 | One looks fake, two looks thin, three looks real |
| Feature cards | 4 | Three is a wireframe, four-six is a product |
| FAQ items | 4 | Fewer looks like you're hiding something |
| Process steps | 3 | The natural narrative arc |
| Stats/metrics | 3 | Scattered singles look accidental |
| Footer columns | 3 | Fewer looks like a side project |
| Nav links | 4-5 | Establishes the site has depth |
| CTA repetitions | 3 | Hero, mid-page, and closing (minimum) |

### Filling "Card" Components
Every card-style component must contain ALL of:
- Icon or visual element (top)
- Title (bold, 3-6 words)
- Description (2-3 sentences with specific detail)
- Optional: a link, metric, or tag at the bottom

**Never generate a card that is just a title and one sentence.** That's a wireframe, not a landing page.

---

## 4. Generating Believable Fake Content

When you need to invent content for a business, make it **specific and plausible**, not generic.

### Testimonials Template
```
"[Specific problem they had]. [How the service solved it — with detail]. [Emotional result or recommendation]."

— [First Name] [Last Name], [Role/Context], [Location]
★★★★★

EXAMPLES:

"Our kitchen drain backed up on a Sunday night with 6 guests over for dinner.
They showed up in 40 minutes and had it flowing in under an hour.
Absolute lifesavers — already recommended to three neighbors."

— Maria Kowalski, Homeowner, Sendling
★★★★★

"I run a small café and our grease trap was a disaster. Other plumbers quoted
€800+. These guys did it for €180 and even showed me how to prevent it.
Genuinely the first tradesperson I've ever left a Google review for."

— Tom Berger, Owner of Café Morgenrot, Haidhausen
★★★★★

"Moved into a new flat and discovered the bathroom drain was completely blocked.
Landlord was unreachable. Texted a photo on WhatsApp, got a quote in 8 minutes,
fixed the next morning for €49. Student discount was a nice surprise too."

— Lisa Nguyen, Student, Maxvorstadt
★★★★★
```

### Pricing Content Template
```
TIER NAME
€[Price] / [unit]
[One-line summary of who this is for]

✓ [Specific included thing with detail]
✓ [Specific included thing with detail]
✓ [Specific included thing with detail]
✓ [Specific included thing with detail]
✗ [What's NOT included — builds honesty]

[CTA Button]
[Small trust note: "No contracts" or "Cancel anytime"]
```

### FAQ Content Template
```
Q: [Question a real customer would Google or text you]
A: [Direct answer — first sentence is the answer, second sentence adds useful context.
   Never start with "Great question!" or "Yes, we..." — just answer it.]

EXAMPLES:

Q: Do you work on weekends?
A: Yes, 7 days a week including holidays. Weekend callouts have a €15
   surcharge, but we'll tell you upfront before we come out.

Q: What if you can't fix it?
A: You don't pay. Our guarantee is simple — if we can't unclog it,
   the visit is free. We've only had to honor that twice in 3 years.

Q: How fast can you get here?
A: Average arrival time is 45 minutes within the city. We'll give you
   a real-time ETA after booking, not a vague "2-4 hour window."
```

### Stats / Metrics Template
Generate at least 3 concrete metrics somewhere on the page:
```
EXAMPLES (pick the style that fits the business):

"2,847 drains unclogged this year"
"45 min average response time"
"4.9★ across 340+ Google reviews"
"€0 callout fee — ever"
"98.7% first-visit fix rate"
"12 neighborhoods covered"

FOR SAAS:
"47% average increase in conversion"
"<100ms API response time"
"99.99% uptime, 365 days/year"
"Used by 3,200+ teams worldwide"
"Set up in under 5 minutes"
"Integrates with 40+ tools"
```

---

## 5. Visual Content Strategy (What Goes Where Images Would Go)

Since we can't generate real photos, use these techniques to fill visual space:

### For Hero Sections
- **CSS illustration / branded graphic**: A stylized SVG or CSS-art related to the business
- **Gradient shape with icon overlay**: A large gradient blob or card with a hero-sized Lucide icon
- **Decorative text treatment**: The brand name or key word set in huge, faded display type as a background element
- **Emoji or icon at scale**: A single relevant emoji at 120px+ as a playful hero visual (works for casual brands)
- **Abstract pattern**: A CSS grid/dot pattern or geometric shape that implies the product

### For Testimonial Avatars
- Colored circle with initials: `<div class="w-12 h-12 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold">MK</div>`
- Never leave avatar spaces empty

### For Feature/Service Icons
- Always use Lucide icons — be specific to the feature, not generic
- Size them at 24-32px inside a colored container (rounded square or circle)
- Example icon choices:
  ```
  Plumber: Wrench, Droplets, ShowerHead, Timer, Shield, Truck
  SaaS: Zap, BarChart3, Lock, Layers, Rocket, Globe
  Restaurant: UtensilsCrossed, Clock, MapPin, Star, Heart, Leaf
  Fitness: Dumbbell, Heart, Timer, TrendingUp, Users, Award
  ```

### For Process/Steps
- Large step numbers (48-72px, bold, accent color or faded)
- Connected by a vertical line or dotted path between steps
- Each step should have its own icon, not just numbers

### For the Logo/Trust Bar
- Use styled text "logos" as placeholders: company names in a distinctive font with opacity
- Or use pill-shaped badges: `<span class="px-4 py-2 rounded-full border border-white/20 text-white/60 text-sm">TechCrunch</span>`

---

## 6. Content Rhythm & Visual Pacing

### Alternating Section Density
Don't make every section the same weight. Alternate:

```
HERO          — Full, rich, attention-grabbing (100vh)
TRUST BAR     — Compact, just logos/stats (py-8 to py-12)
FEATURES      — Dense, multi-card grid (tall section)
HOW IT WORKS  — Medium, 3-4 steps with breathing room
TESTIMONIALS  — Dense, 3+ cards in a grid or scroll
PRICING       — Medium, 2-3 focused cards
FAQ           — Compact but useful (accordion saves space)
FINAL CTA     — Full width, bold, short (50vh max)
FOOTER        — Dense with links, compact
```

### Background Alternation
Alternate backgrounds to create visual rhythm and prevent "wall of same":
```
Section 1: Dark background
Section 2: Slightly lighter (e.g., #111 vs #0a0a0a, or white vs #fafafa)
Section 3: Back to dark (or a subtle accent-tinted background)
Section 4: Lighter again
...
```
Every 2-3 sections should have a noticeable background shift. This is what makes a page feel like it has "chapters."

### Inline Trust Signals
Don't cluster all proof in one section. Sprinkle it:
- Hero: "★ 4.9 from 200+ reviews"
- Below features: "Trusted by 3,000+ businesses"
- Inside pricing: "No hidden fees — guaranteed"
- Before final CTA: "Join 500+ customers who switched this month"

---

## 7. Common Business Type Templates

When the user gives you a business type, instantly map it to concrete content:

### LOCAL SERVICE (Plumber, Electrician, Cleaner, Locksmith)
```
Hero angle: Pain point + speed promise
Must-have content: Service area map, response time, pricing transparency
Testimonials: Mention neighborhoods, specific situations, urgency
CTAs: Phone number, WhatsApp, booking form
Stats: Response time, jobs completed, satisfaction rate
FAQ focus: Pricing, availability, guarantees, service area
```

### SAAS / TECH PRODUCT
```
Hero angle: Outcome-first ("Save 10hrs/week") not feature-first
Must-have content: Feature grid with descriptions, integration logos, product screenshot placeholder
Testimonials: Include company names and job titles
CTAs: Free trial, demo booking, "See it in action"
Stats: Performance metrics, customer count, uptime
FAQ focus: Pricing tiers, data security, migration, integrations
Optional: Comparison table vs competitors
```

### RESTAURANT / FOOD
```
Hero angle: Sensory and emotional ("Farm-to-table since 2019")
Must-have content: Menu highlights (3-4 items with descriptions and prices), opening hours, location
Testimonials: Mention specific dishes
CTAs: Reserve a table, order online, view full menu
Stats: Years open, dishes served, local sourcing %
FAQ focus: Reservations, dietary options, private events, parking
```

### E-COMMERCE / DTC PRODUCT
```
Hero angle: Product benefit + social proof ("Join 50K+ happy sleepers")
Must-have content: Product features with details, comparison, guarantee
Testimonials: Before/after stories, specific results
CTAs: Shop now, add to cart, "Try risk-free for 30 days"
Stats: Units sold, return rate (low = good), customer satisfaction
FAQ focus: Shipping, returns, materials, sizing
Optional: "As seen in" press logos
```

### AGENCY / CONSULTANCY
```
Hero angle: Expertise + outcome ("We've scaled 40+ brands past €1M")
Must-have content: Service descriptions, case study highlights, process
Testimonials: Client name + company, with specific results
CTAs: Book a call, see case studies, get a proposal
Stats: Clients served, revenue generated, years in business
FAQ focus: Pricing model, timeline, what's included, communication
Optional: Team section with photos/bios
```

---

## 8. Final Pre-Output Checklist

Before delivering any landing page, verify:

- [ ] **Every section has real content** — no empty cards, no placeholder-only areas
- [ ] **At least 3 testimonials** with full quotes, names, roles, and ratings
- [ ] **At least 4 feature/service cards** with icons, titles, AND descriptions
- [ ] **FAQ has 4+ questions** with specific, helpful answers
- [ ] **Stats/metrics appear** at least twice on the page (hero area + mid-page)
- [ ] **CTAs appear 3+ times** (hero, mid-page, closing section)
- [ ] **Footer has 3+ columns** of real-looking links
- [ ] **Nav bar has 4-5 links** + a CTA button
- [ ] **Background alternates** between at least 2 shades across sections
- [ ] **No section is just a headline** — every section has body content below its heading
- [ ] **Pricing/value is concrete** — real numbers, not vague "affordable" language
- [ ] **Testimonials mention specifics** — situations, timeframes, prices, neighborhoods
- [ ] **Every card has 2-3 sentences** of description, not just a title
- [ ] **Trust signals are sprinkled** throughout, not just in one place
- [ ] **The page would make sense** if a real person in that industry saw it — nothing absurd

---

*The goal: when someone scrolls your generated landing page, they should think "this is a real business" — not "this is a template." Content density, specificity, and believability are what create that feeling.*