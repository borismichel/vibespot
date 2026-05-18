# React/TypeScript to HubSpot CMS — Conversion Guide

This guide documents the process of converting a React/Vite/Tailwind single-page application into native HubSpot CMS modules. It is designed as reusable instructional context for performing this conversion at scale — whether the source is Lovable, v0, Bolt, or any React-based page builder.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Mapping](#architecture-mapping)
3. [Module Structure](#module-structure)
4. [Field Types & Gotchas](#field-types--gotchas)
5. [CSS Conversion](#css-conversion)
6. [JavaScript Conversion](#javascript-conversion)
7. [Template Creation](#template-creation)
8. [Style Tab Integration](#style-tab-integration)
9. [Common Pitfalls](#common-pitfalls)
10. [Checklist](#checklist)

---

## Overview

### What Gets Converted

| React Concept | HubSpot Equivalent |
|---------------|-------------------|
| React component | HubSpot module (`.module/` directory) |
| Props / state | `fields.json` (editable fields) |
| JSX template | `module.html` (HubL template) |
| Component CSS | `module.css` (vanilla CSS) |
| Component JS (hooks, effects) | `module.js` or shared JS file |
| Tailwind utilities | Vanilla CSS with BEM naming |
| React Router pages | HubSpot page templates |
| Context / global state | Theme-level `fields.json` |
| npm packages (shadcn, Radix, Embla) | Vanilla JS replacements |

### What Gets Skipped

- **Cookie consent**: HubSpot provides this natively
- **Password gates**: Use HubSpot's membership system
- **Client-side routing**: Not applicable (each page is server-rendered)
- **Build tooling**: No Vite, Webpack, or bundler needed
- **Type definitions**: HubL is untyped

---

## Architecture Mapping

### 1:1 Component → Module Mapping

Each visual section of the React page becomes one HubSpot module. A typical landing page maps like this:

```
React Component              →  HubSpot Module
─────────────────────────────────────────────────
Header.tsx                   →  Header.module/
HeroSection.tsx              →  Hero.module/
FeaturesSection.tsx          →  Features.module/
TestimonialsSection.tsx      →  Testimonials.module/
PricingSection.tsx           →  Pricing.module/
ContactSection.tsx           →  Contact.module/
Footer.tsx                   →  Footer.module/
```

### Shared Files

| File | Purpose |
|------|---------|
| `css/<theme>.css` | Shared design system: CSS variables, utilities, animations, form overrides |
| `js/<theme>-animations.js` | Shared vanilla JS: scroll animations, carousels, accordions, etc. |
| `templates/<page>.html` | Page template that assembles modules in a DnD area |

---

## Module Structure

Each module lives in `modules/<Name>.module/` with these files:

```
MyModule.module/
├── fields.json    # Editable content & style fields
├── meta.json      # Module metadata
├── module.html    # HubL template (converted from JSX)
├── module.css     # Module-specific styles (converted from Tailwind)
└── module.js      # Optional: module-specific JavaScript
```

### meta.json

```json
{
  "label": "My Module",
  "css_assets": [],
  "external_js": [],
  "global": false,
  "host_template_types": ["PAGE"],
  "content_types": ["LANDING_PAGE"],
  "is_available_for_new_content": true
}
```

- `content_types`: Use `["LANDING_PAGE"]` for landing pages, `["PAGE"]` for website pages, or both.
- `global`: Set `true` only for modules that appear on every page (rare).

### fields.json

This is where React props become HubSpot-editable fields. Every piece of text, image, link, or repeating group that an editor should be able to change goes here.

**Converting React props/hardcoded strings to fields:**

```tsx
// React: hardcoded content
<h2>Our Features</h2>
<p>We offer the best solutions for your business.</p>
```

```json
// fields.json
[
  {
    "name": "headline",
    "label": "Headline",
    "type": "text",
    "default": "Our Features"
  },
  {
    "name": "subtitle",
    "label": "Subtitle",
    "type": "text",
    "default": "We offer the best solutions for your business."
  }
]
```

```html
<!-- module.html -->
<h2>{{ module.headline }}</h2>
<p>{{ module.subtitle }}</p>
```

### Converting Repeating Content (map → repeater group)

```tsx
// React: array.map()
{features.map((feature) => (
  <div key={feature.title}>
    <h3>{feature.title}</h3>
    <p>{feature.description}</p>
  </div>
))}
```

```json
// fields.json — repeater group
{
  "name": "features",
  "label": "Features",
  "type": "group",
  "occurrence": {
    "min": 1,
    "max": 10,
    "default": 3
  },
  "default": [
    { "feature_title": "Feature 1", "feature_desc": "Description 1" },
    { "feature_title": "Feature 2", "feature_desc": "Description 2" },
    { "feature_title": "Feature 3", "feature_desc": "Description 3" }
  ],
  "children": [
    {
      "name": "feature_title",
      "label": "Title",
      "type": "text",
      "default": "Feature"
    },
    {
      "name": "feature_desc",
      "label": "Description",
      "type": "text",
      "default": "Description"
    }
  ]
}
```

```html
<!-- module.html — HubL for loop -->
{%- for item in module.features -%}
  <div>
    <h3>{{ item.feature_title }}</h3>
    <p>{{ item.feature_desc }}</p>
  </div>
{%- endfor -%}
```

---

## Field Types & Gotchas

### Supported Field Types

| HubSpot Type | Use For | React Equivalent |
|-------------|---------|-----------------|
| `text` | Single-line or multi-line text | `string` prop |
| `richtext` | Formatted HTML content | `dangerouslySetInnerHTML` |
| `image` | Image with src + alt | `<img>` props |
| `link` | URL with target options | `href` prop |
| `color` | Color picker with opacity | CSS color values |
| `choice` | Dropdown/radio selection | Enum prop |
| `boolean` | Toggle switch | Boolean prop |
| `number` | Numeric input | Number prop |
| `group` | Container for child fields | Object prop |
| `group` + `occurrence` | Repeater (array of items) | Array prop |
| `form` | HubSpot form selector | Form embed |

### Critical Gotchas

| Issue | Error | Fix |
|-------|-------|-----|
| `"type": "textarea"` | `'unknown' is not a valid field type` | Use `"type": "text"` instead — `textarea` is deprecated |
| `"name": "name"` | `missing field name` | `name` is reserved — use `item_name`, `link_label`, etc. |
| `{% module %}` in module.html | `'module' is disabled in this context` | Cannot nest modules — use `{% form %}` for forms |
| `{{ now() }}` | `Could not resolve function 'now'` | Use `{{ local_dt }}` for current date/time |
| Partially uploaded module | Re-upload still fails | Run `hs cms delete <path>` first, then re-upload |
| SVG in text field | SVG renders as escaped text | SVG markup in text fields is auto-escaped by HubL |

### Image Fields

```json
{
  "name": "logo",
  "label": "Logo",
  "type": "image",
  "default": {
    "src": "",
    "alt": "Company Logo"
  }
}
```

```html
{%- if module.logo.src -%}
  <img src="{{ module.logo.src }}" alt="{{ module.logo.alt }}" />
{%- else -%}
  <span>Fallback Text</span>
{%- endif -%}
```

### Form Embedding

```json
{
  "name": "form_field",
  "label": "Form",
  "type": "form",
  "default": {
    "form_id": "your-form-guid-here",
    "portal_id": "your-portal-id"
  }
}
```

```html
{% form
  form_to_use="{{ module.form_field.form_id }}"
  response_response_type="redirect"
  response_redirect_url=""
  no_title=true
%}
```

---

## CSS Conversion

### From Tailwind to Vanilla CSS

1. **Extract the design system** from `tailwind.config.ts` and `index.css`:
   - Color palette → CSS custom properties (`--prefix-*`)
   - Font families → `@import` Google Fonts + CSS properties
   - Spacing scale → Hardcoded `rem` values
   - Breakpoints → `@media` queries

2. **Convert utility classes to BEM-named classes**:

```tsx
// React + Tailwind
<div className="bg-gray-900 rounded-xl p-6 border border-gray-800 hover:shadow-lg transition">
```

```css
/* Vanilla CSS with BEM */
.my-module__card {
  background: hsl(var(--dark-900));
  border-radius: 1rem;
  padding: 1.5rem;
  border: 1px solid hsl(var(--border));
  transition: box-shadow 0.3s;
}
.my-module__card:hover {
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
```

3. **Prefix ALL classes** with a unique namespace (e.g., `ai-`, `wco-`) to avoid conflicts with the HubSpot theme's existing CSS.

### CSS Load Order in HubSpot

The base template loads CSS in this order (each can override the previous):

```
1. main.css          ← Theme reset, base styles
2. style.css         ← Theme custom styles
3. template_css      ← Your shared CSS (e.g., ai-theme.css)
4. theme-overrides   ← Theme settings (colors, fonts, spacing from theme.json)
5. module.css        ← Module-specific styles
```

**Critical**: `theme-overrides.css` loads AFTER your template CSS. It sets:
- `body { color: ...; font-size: ...; }` — overrides text color
- `h1, h2, h3... { color: ...; }` — overrides heading colors
- `.dnd-section { padding: ...; }` — adds section padding
- `.dnd-section > .row-fluid { max-width: ...; }` — constrains width
- `a { color: ...; }` — overrides link colors
- Button, form, table styles

**Solution**: Add scoped overrides in your shared CSS:

```css
/* Override theme-overrides.css within your page scope */
.my-page h1, .my-page h2, .my-page h3,
.my-page h4, .my-page h5, .my-page h6 {
  color: hsl(var(--my-fg)) !important;
  font-family: 'My Font', sans-serif !important;
}
.my-page p {
  color: hsl(var(--my-fg)) !important;
}
.my-page .dnd-section {
  padding: 0 !important;
}
.my-page .dnd-section > .row-fluid {
  max-width: 100% !important;
}
```

### Link & Button Hover Problem

HubSpot's theme applies default `a:hover` styles (blue color, underline, font change) that override your button/link styling.

**Solution**: For every button/link element, combine the base selector with `:hover`, `:focus`, and `:active` to lock down `color`, `text-decoration`, and `font-family`:

```css
/* Lock visual properties across ALL interaction states */
.my-module__cta,
.my-module__cta:hover,
.my-module__cta:focus,
.my-module__cta:active {
  color: #ffffff;
  text-decoration: none;
  font-family: inherit;
  background: var(--cta-bg);
  border: none;
}

/* Then add intentional hover effects separately */
.my-module__cta:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
}
```

**CRITICAL**: Every `<a>` tag styled as a button MUST have explicit `:hover` and `:focus` rules that re-declare `color`, `text-decoration: none`, and `font-family`. Without this, HubSpot's defaults will bleed through.

### Body Background Problem

The page wrapper structure is:
```html
<div class="body-wrapper">
  <main class="body-container-wrapper">
    <div class="my-page">  ← your wrapper
      <!-- modules -->
    </div>
  </main>
</div>
```

`.my-page` is a CHILD of `.body-wrapper`. CSS cannot target a parent from a child selector. Solutions:

```css
/* Modern browsers: :has() selector */
.body-wrapper:has(.my-page) {
  background: #0d1117 !important;
}

/* JS fallback class (added via your animations.js) */
.body-wrapper.my-page-active {
  background: #0d1117 !important;
}
```

```js
// In your shared JS
var page = document.querySelector('.my-page');
if (page) {
  var wrapper = page.closest('.body-wrapper');
  if (wrapper) wrapper.classList.add('my-page-active');
}
```

---

## JavaScript Conversion

### React Hooks → Vanilla JS

| React Pattern | Vanilla JS Replacement |
|--------------|----------------------|
| `useEffect` + IntersectionObserver | `IntersectionObserver` in IIFE |
| `useState` for toggle | `classList.toggle()` |
| `useRef` | `document.getElementById()` / `querySelector()` |
| `setTimeout` / `setInterval` in effect | Direct `setTimeout` / `setInterval` |
| Embla Carousel | Custom carousel with `translateX` |
| Radix Accordion | Custom accordion with `maxHeight` toggle |
| Framer Motion | CSS transitions + IntersectionObserver `.visible` class |

### Scroll Animation Pattern

```tsx
// React hook (useScrollAnimation.ts)
const ref = useRef<HTMLDivElement>(null);
useEffect(() => {
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) setIsVisible(true);
  }, { threshold: 0.1 });
  if (ref.current) observer.observe(ref.current);
  return () => observer.disconnect();
}, []);
```

```js
// Vanilla JS equivalent
function initScrollAnimations() {
  var els = document.querySelectorAll('.scroll-animate');
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  els.forEach(function(el) { observer.observe(el); });
}
```

```css
/* CSS for the animation */
.scroll-animate {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 0.6s ease-out, transform 0.6s ease-out;
}
.scroll-animate.visible {
  opacity: 1;
  transform: translateY(0);
}
```

### JS Loading in Templates

JavaScript must be loaded from the **base template context**, not from child template blocks. HubSpot's `get_asset_url()` resolves paths relative to the file where it's called.

```html
<!-- WRONG: require_js in child template block resolves relative to child -->
{% block body %}
  {{ require_js(get_asset_url("../../js/animations.js")) }}
{% endblock %}

<!-- CORRECT: use a variable, resolved in base template -->
<!-- Child template: -->
{% set template_js = "../../js/animations.js" %}

<!-- Base template (templates/layouts/base.html): -->
{% if template_js %}
  {{ require_js(get_asset_url(template_js)) }}
{% endif %}
```

---

## Template Creation

### Page Template Structure

```html
<!--
  templateType: page
  isAvailableForNewContent: true
  label: My Landing Page
  screenshotPath: ../images/template-previews/my-page.png
-->
{% extends "./layouts/base.html" %}

{% set template_css = "../../css/my-theme.css" %}
{% set template_js = "../../js/my-animations.js" %}

{% block header %}
  {# Custom header module replaces global header #}
{% endblock header %}

{% block body %}
<div class="my-page">
  {% dnd_area "main_content" label="Main Content" %}

    {% dnd_section
      padding={"top":"0","bottom":"0","left":"0","right":"0"},
      full_width=true
    %}
      {% dnd_module path="../modules/My Hero.module" %}
      {% end_dnd_module %}
    {% end_dnd_section %}

    {# Repeat for each section... #}

  {% end_dnd_area %}
</div>
{% endblock body %}

{% block footer %}
  {# Custom footer module replaces global footer #}
{% endblock footer %}
```

### DnD Section Rules

Every `dnd_section` MUST have:

```
padding={"top":"0","bottom":"0","left":"0","right":"0"}, full_width=true
```

Without these:
- HubSpot applies default padding from `theme-overrides.css`
- Content is constrained to `max-width` from theme settings
- Your full-width designs break

Do NOT add `dnd_column` or `dnd_row` wrappers — HubSpot creates these automatically:

```html
<!-- WRONG -->
{% dnd_section %}
  {% dnd_column %}
    {% dnd_row %}
      {% dnd_module path="..." %}{% end_dnd_module %}
    {% end_dnd_row %}
  {% end_dnd_column %}
{% end_dnd_section %}

<!-- CORRECT -->
{% dnd_section padding={"top":"0","bottom":"0","left":"0","right":"0"}, full_width=true %}
  {% dnd_module path="..." %}{% end_dnd_module %}
{% end_dnd_section %}
```

---

## Style Tab Integration

HubSpot modules have a **Content tab** and a **Style tab** in the page editor. To place color pickers and other styling options in the Style tab:

```json
{
  "name": "styles",
  "label": "Styles",
  "type": "group",
  "tab": "STYLE",
  "children": [
    {
      "name": "section_bg",
      "label": "Section Background",
      "type": "color",
      "default": { "color": "#0d1117", "opacity": 100 }
    },
    {
      "name": "heading_color",
      "label": "Heading Color",
      "type": "color",
      "default": { "color": "#eef1f5", "opacity": 100 }
    },
    {
      "name": "text_color",
      "label": "Text Color",
      "type": "color",
      "default": { "color": "#8a95a5", "opacity": 100 }
    }
  ]
}
```

Apply in module.html with inline styles:

```html
<section style="background-color: {{ module.styles.section_bg.color }};">
  <h2 style="color: {{ module.styles.heading_color.color }};">{{ module.headline }}</h2>
  <p style="color: {{ module.styles.text_color.color }};">{{ module.subtitle }}</p>
</section>
```

For backgrounds with transparency (e.g., glassmorphism cards):

```html
<div style="background-color: rgba({{ module.styles.card_bg.color|convert_rgb }}, {{ module.styles.card_bg.opacity / 100 }});">
```

**Key rules:**
- `"tab": "STYLE"` goes on the **group**, not on individual children
- Children inherit the tab placement from the parent group
- Defaults should match your current CSS design so the page looks correct out of the box
- Inline styles override CSS class styles, giving editors direct control

---

## Common Pitfalls

### 1. Page Appears Empty After Upload

**Cause**: JavaScript not loading. Elements with `.scroll-animate` class start at `opacity: 0` and rely on JS to add `.visible`. If JS path is wrong, everything except CSS-animated elements stays invisible.

**Fix**: Use the `template_js` variable pattern (see [JS Loading](#js-loading-in-templates)).

### 2. White Page / Light Text Invisible

**Cause**: `theme-overrides.css` sets light-theme colors on `body`, headings, and paragraphs. Your dark-theme text becomes invisible on the white body background.

**Fix**: Add scoped overrides with `!important` and fix the body-wrapper background (see [CSS Conversion](#css-conversion)).

### 3. Sections Constrained to Narrow Width

**Cause**: Missing `padding` and `full_width` on `dnd_section` tags.

**Fix**: Add `padding={"top":"0","bottom":"0","left":"0","right":"0"}, full_width=true` to every `dnd_section`.

### 4. Module Upload Fails After Fix

**Cause**: Partially uploaded module with invalid `fields.json` is cached on HubSpot.

**Fix**: `hs cms delete my-theme/modules/MyModule.module` then re-upload.

### 5. Repeater Group Content Missing

**Cause**: The `default` array in the group doesn't match the `children` structure, or `occurrence.default` is 0.

**Fix**: Ensure `default` array items have all child field names, and `occurrence.default` is > 0.

### 6. HubSpot Form Renders with Light Theme

**Cause**: HubSpot forms load in iframes with their own styling.

**Fix**: Add aggressive CSS overrides scoped to your page wrapper:
```css
.my-page .hs-form-frame input,
.my-page .hs-form-frame select,
.my-page .hs-form-frame textarea {
  background-color: #0d1117 !important;
  color: #eef1f5 !important;
  border: 1px solid #2a2f3a !important;
}
```

---

## Checklist

### Per Module

- [ ] `meta.json` created with correct `content_types`
- [ ] `fields.json` created — no `textarea` type, no `name` as field name
- [ ] All hardcoded React content extracted to field defaults
- [ ] Repeater groups have `occurrence.default` > 0 and matching `default` array
- [ ] `module.html` converts JSX to HubL (`{{ module.field }}`, `{% for %}`)
- [ ] `module.css` converts Tailwind utilities to BEM vanilla CSS
- [ ] All CSS classes use a unique prefix (e.g., `ai-`, `wco-`)
- [ ] Style fields wrapped in a `styles` group with `"tab": "STYLE"`
- [ ] Inline styles applied from `module.styles.*` fields

### Per Template

- [ ] Extends `base.html`
- [ ] Sets `template_css` and `template_js` variables
- [ ] Empty `{% block header %}` and `{% block footer %}` (if using custom header/footer modules)
- [ ] All `dnd_section` tags have `padding` zeroed and `full_width=true`
- [ ] No `dnd_column`/`dnd_row` wrappers
- [ ] Wrapper div with page-specific class (e.g., `.my-page`)

### Shared CSS

- [ ] CSS custom properties for the design system
- [ ] Scoped overrides to defeat `theme-overrides.css`
- [ ] Body-wrapper background fix (`:has()` + JS fallback)
- [ ] HubSpot form dark theme overrides (if applicable)
- [ ] Mobile performance rules (disable `backdrop-filter`, reduce blur)

### Shared JS

- [ ] Scroll animations (IntersectionObserver)
- [ ] Body-wrapper class fallback
- [ ] Any interactive features (carousel, accordion, typing animation, etc.)
- [ ] `DOMContentLoaded` / readyState check for initialization

### Upload & Test

- [ ] `hs cms upload` succeeds for all modules
- [ ] Template uploads without errors
- [ ] New page created from template shows all sections
- [ ] Scroll animations trigger on scroll
- [ ] Interactive features work (carousel, accordion, etc.)
- [ ] Style tab fields appear and change colors
- [ ] Mobile responsive layout works
- [ ] HubSpot form submits correctly (if applicable)
