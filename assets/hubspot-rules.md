# HUBSPOT_RULES.md — HubSpot CMS Design Manager Gotchas & Validation Rules

> These rules prevent the most common errors when generating HubSpot CMS templates, modules, and theme files. Every rule here comes from real validation errors, community forum pain, or undocumented behavior that breaks silently.

---

## 1. Module Field Naming Rules

### Reserved Field Names (will collide with dnd_module parameters)
These names are used by drag-and-drop tags as built-in parameters. If you name a module field any of these, it will conflict when used inside `dnd_module` tags. The Design Manager will block new fields with these names, but the error is cryptic.

```
NEVER use these as field names:
  - width
  - offset
  - label
  - path
  - module_id
  - css_class
  - css_id
  - styles
  - style
  - flexbox_positioning
  - definition_id
  - smart_type
  - smart_objects
  - wrap
  - extra_classes

If you inherit a legacy module that already uses one of these names,
use the `fields` parameter to pass values instead:

  ✅ {% dnd_module path="@hubspot/divider", fields={width: "90"} %}
  ❌ {% dnd_module path="@hubspot/divider", width="90" %}
```

### Field Name Format Rules
```
- Use snake_case for field names: "hero_heading" not "heroHeading" or "Hero Heading"
- Field names must be unique within a module (including across groups)
- Field names cannot contain spaces, dashes, or special characters
- Field names are case-sensitive
- The "name" in fields.json is the HubL variable name (module.field_name)
- The "label" in fields.json is the human-readable name shown in the editor
- "name" and "label" should NEVER be identical short strings like "title" or "text"
  → Use descriptive names: "hero_title", "section_heading", "cta_button_text"
```

### Field Label Rules (for Marketplace / quality)
```
- Labels must be descriptive: "Job Title" not just "Title"
- Labels must NOT contain numbers: "Hero Banner" not "Hero Banner 01"
- Labels must NOT contain underscores: "Hero Banner" not "Hero_Banner"
- Labels must NOT contain abbreviations: "Column" not "Col"
- Default field values must NOT contain Lorem Ipsum text
- Module labels must not duplicate default HubSpot module names
```

---

## 2. Module File Structure

### Local Development (.module folder)
```
my-module.module/
  ├── fields.json      ← Field definitions (array of objects)
  ├── meta.json        ← Module configuration (label, icon, categories)
  ├── module.html      ← HubL + HTML template
  ├── module.css       ← Scoped CSS (loaded once per page)
  └── module.js        ← JavaScript (loaded once per page, NOT per instance)
```

### Critical: Module Folder Naming
```
✅ my-module.module/     ← MUST end with .module
❌ my-module-module/     ← WRONG — causes "text fields not supported in theme" errors
❌ my-module/            ← WRONG — not recognized as a module

This is a VERY common mistake. The folder MUST have the .module suffix.
The CLI error message when this is wrong is misleading — it says things like
"text fields are not supported in theme fields.json" because HubSpot thinks
your module's fields.json IS the theme's fields.json.
```

### meta.json Required Structure
```json
{
  "label": "My Custom Module",
  "css_assets": [],
  "external_js": [],
  "global": false,
  "help_text": "",
  "host_template_types": ["PAGE", "BLOG_POST", "BLOG_LISTING"],
  "is_available_for_new_content": true,
  "js_assets": [],
  "other_assets": [],
  "smart_type": "NOT_SMART",
  "categories": [],
  "content_tags": []
}
```

---

## 3. fields.json Rules

### Structure
```
- fields.json is a JSON ARRAY of objects: [ { ... }, { ... } ]
- NOT an object: { fields: [ ... ] } ← WRONG
- Every field needs at minimum: "name", "label", "type"
- "id" is optional in local dev (auto-generated on upload)
- "default" should always be provided — never leave fields without defaults
```

### Field Types Available in Modules vs Themes
```
MODULES can use ALL field types including:
  text, richtext, image, link, url, number, boolean, choice, color,
  font, alignment, spacing, backgroundimage, border, gradient, icon,
  cta, form, blog, hubdbtable, hubdbrow, crmobject, menu, date,
  datetime, payment, video, embed, audioplayer

THEMES can only use a LIMITED subset:
  color, font, image, boolean, choice, number, spacing, border,
  backgroundimage, gradient, alignment, group

  ❌ "text" fields are NOT supported in theme fields.json
  ❌ "richtext" fields are NOT supported in theme fields.json
  ❌ "url" / "link" fields are NOT supported in theme fields.json

  If you see "text fields are not supported in theme fields.json"
  you either:
  1. Put a text field in your THEME'S fields.json (not allowed), OR
  2. Your module folder is missing the .module suffix (see above)
```

### Color Field Format (CRITICAL)
```
Color fields MUST use this exact default format:
  { "color": "#rrggbb", "opacity": 100 }

RULES:
  - "color" MUST be a 6-digit hex string starting with "#" (e.g. "#ffffff")
  - "opacity" MUST be an integer from 0 to 100 (NOT a float like 0.7)
  - NEVER use rgba(), rgb(), hsl(), or named colors (e.g. "red", "white")

  ✅ { "color": "#ffffff", "opacity": 70 }
  ✅ { "color": "#1a2e0d", "opacity": 100 }
  ❌ { "color": "rgba(255,255,255,0.7)", "opacity": 100 }   ← INVALID
  ❌ { "color": "white", "opacity": 100 }                    ← INVALID
  ❌ { "color": "#fff", "opacity": 100 }                     ← INVALID (3-digit)
  ❌ { "color": "#ffffff", "opacity": 0.7 }                  ← INVALID (float)

HubSpot error: "The format for the color value is invalid"
This error means you used a non-hex color format in a color field default.
Convert rgba to hex + opacity:
  rgba(255,255,255,0.85) → { "color": "#ffffff", "opacity": 85 }
  rgba(0,0,0,0.5) → { "color": "#000000", "opacity": 50 }
```

### Style Fields (tab: "STYLE")
```
- Style fields MUST be wrapped in a group with "tab": "STYLE"
- The group must be named "styles"
- Style fields render in the Style tab of the page editor
- Only certain field types can be style fields:
  color, font, alignment, spacing, backgroundimage, border, gradient,
  number, boolean, choice

Example:
[
  {
    "type": "group",
    "name": "styles",
    "tab": "STYLE",
    "children": [
      {
        "name": "background_color",
        "label": "Background Color",
        "type": "color",
        "default": { "color": "#ffffff", "opacity": 100 }
      }
    ]
  }
]
```

### Field Groups
```
- Groups are fields with "type": "group" and a "children" array
- Groups CAN be nested (groups inside groups)
- When a module has at least one control in a group, ALL controls
  should be organized into labeled groups (Marketplace requirement)
- Repeater fields need "occurrence" with "min" and optionally "max" / "default"
```

### Visibility / Display Conditions
```json
{
  "name": "headline_text",
  "label": "Headline",
  "type": "text",
  "default": "Welcome",
  "visibility": {
    "controlling_field": "show_headline",
    "controlling_value_regex": "true",
    "operator": "EQUAL"
  }
}

- "controlling_field" references another field's "name" (not label)
- For nested fields, use "controlling_field_path": "group_name.field_name"
- Operators: "EQUAL", "NOT_EQUAL", "EMPTY", "NOT_EMPTY", "MATCHES_REGEX"
- controlling_value_regex for booleans: use "true" or "false" (as strings)
```

---

## 4. HubL Template Rules

### Template Annotations (required at top of .html template files)
```html
<!--
  templateType: page
  label: My Landing Page
  isAvailableForNewContent: true
  screenshotPath: ../images/template-previews/landing-page.png
-->
```

Valid templateType values:
```
page, blog_base, blog_listing, blog_post, email, section,
global_partial, search_results, membership_login,
membership_register, membership_reset, password_prompt, error_page
```

### Section Templates (the most error-prone area)
```
Section template annotations:
<!--
  templateType: section
  label: Hero Section
  isAvailableForNewContent: true
  screenshotPath: ../images/section-previews/hero.png
  description: "A hero section with headline and CTA"
-->

CRITICAL RULES for section templates:
1. Multiple dnd_modules in a single dnd_section REQUIRE width and offset
2. Width + offset values use a 12-column grid
3. Missing width/offset causes: "Cannot resolve property [missing {{ token }} value]"

✅ CORRECT (two modules in one section):
{% dnd_section %}
  {% dnd_column %}
    {% dnd_row %}
      {% dnd_module "rich_text_1" path="@hubspot/rich_text" width=6, offset=0 %}
      {% end_dnd_module %}
      {% dnd_module "rich_text_2" path="@hubspot/rich_text" width=6, offset=6 %}
      {% end_dnd_module %}
    {% end_dnd_row %}
  {% end_dnd_column %}
{% end_dnd_section %}

❌ WRONG (missing width/offset):
{% dnd_section %}
  {% dnd_module "rich_text_1" path="@hubspot/rich_text" %}{% end_dnd_module %}
  {% dnd_module "rich_text_2" path="@hubspot/rich_text" %}{% end_dnd_module %}
{% end_dnd_section %}
```

### Drag-and-Drop Nesting Order
```
The nesting MUST follow this exact hierarchy:
  dnd_area → dnd_section → dnd_column → dnd_row → dnd_module

- dnd_area: top-level container, only ONE per template
- dnd_section: full-width horizontal band
- dnd_column: vertical division inside a section
- dnd_row: horizontal division inside a column
- dnd_module: the actual content module

Every opening tag MUST have a matching closing tag:
  {% dnd_section %} ... {% end_dnd_section %}
  {% dnd_column %} ... {% end_dnd_column %}
  {% dnd_row %} ... {% end_dnd_row %}
  {% dnd_module "name" path="..." %} {% end_dnd_module %}

Common mistake: forgetting {% end_dnd_column %} or mismatching nesting.
```

### Anchor Links in Modules
```
HubSpot's dnd_section/dnd_module system wraps modules in auto-generated
container divs (hs_cos_wrapper_*). Any id attribute on external wrappers
will be buried or overridden.

To make anchor links work reliably:
- Put the id directly on the module's ROOT element in module.html
- Do NOT rely on external wrappers or template-level ids

  ✅ <section id="pricing" class="my-pricing">...</section>
  ❌ Relying on a wrapper: <div id="pricing"><section>...</section></div>

The id should match the moduleName lowercased with spaces → hyphens:
  "Pricing Cards" → id="pricing-cards"
  "Hero" → id="hero"
```

### Module References in HubL
```
CURRENT (v2): {{ module.field_name }}
LEGACY (v1):  {{ widget.field_name }}  ← still works but deprecated

- URL fields return OBJECTS, not strings:
  ✅ {{ module.my_link.href }}
  ❌ {{ module.my_link }}  ← prints the entire object as text

- Image fields:
  ✅ {{ module.my_image.src }}
  ✅ {{ module.my_image.alt }}
  ❌ {{ module.my_image }}  ← prints object

- Icon fields have inconsistent naming:
  The "style" property on {% icon %} tag reads from "type" in the field data
  ✅ {% icon name="{{ module.icon_field.name }}"
          style="{{ module.icon_field.type }}"
          unicode="{{ module.icon_field.unicode }}" %}
  ❌ {% icon style="{{ module.icon_field.style }}" %}  ← "style" doesn't exist on the field
```

### Module Names (unique identifiers in templates)
```
- Must be in quotes: {% module "my_module" ... %}
- Must use underscores, not spaces or dashes: "my_module" not "my-module"
- Must be unique within the template
- If two modules share the same name, editing one edits both
- This is sometimes intentional (for synced content) but usually a bug
```

---

## 5. CSS Rules

### Do NOT Style HubSpot's Generated Classes
```
These classes are auto-generated and WILL change without notice:

  /* IDs — never target these */
  #hs_cos_wrapper_*
  #hs_form_target_dnd*

  /* Classes — never target these */
  .heading-container-wrapper
  .heading-container
  .body-container-wrapper
  .body-container
  .footer-container-wrapper
  .footer-container
  .container-fluid
  .row-fluid
  .row-fluid-wrapper
  .row-depth-*
  .row-number-*
  .span*
  .hs-cos-wrapper
  .hs-cos-wrapper-widget
  .dnd-section
  .dnd-column
  .dnd-row
  .dnd-module
  .dnd_area*

Instead: use custom classes assigned via the class parameter in templates
or through field-driven dynamic classes in modules.
```

### CSS Scoping in Modules
```
- module.css loads ONCE per page, even if the module appears 10 times
- Use {{ name }} in module.html to get a unique instance class
- Scope your CSS:

  module.html:
    <div class="{{ name }} my-custom-module">...</div>

  module.css:
    .my-custom-module { ... }

- For dynamic styles, use require_css block:
  {% require_css %}
  <style>
    {% scope_css %}
      .my-module { color: {{ module.styles.text_color.color }}; }
    {% end_scope_css %}
  </style>
  {% end_require_css %}
```

### Inline Styles
```
- Hardcoded inline styles are discouraged (Marketplace rejection)
- Use field-driven dynamic inline styles instead:

  ❌ <div style="background-color: #ff0000;">
  ✅ <div style="background-color: {{ module.styles.bg_color.color }};">
  ✅ <div style="{{ module.styles.bg_image.css }}">  ← .css property on backgroundimage fields
```

---

## 6. JavaScript Rules

### Module JS Behavior
```
- module.js loads ONCE per page, regardless of how many instances exist
- You CANNOT assume your module appears only once on the page
- Use class-based selectors scoped to the module, not IDs

  ❌ document.getElementById('my-module')
  ✅ document.querySelectorAll('.my-module-class')

- For module-specific targeting, use the {{ name }} variable in module.html
  to generate a unique wrapper class, then target that

- Scripts in module.js load BEFORE any require_js files
- Defer module.js execution:
  var defined_name = (function() { /* your code */ })();
```

### jQuery
```
- Prefer vanilla JS — adding jQuery to a site not using it causes conflicts
- If jQuery is needed, use require_js() to include it:
  {{ require_js("https://code.jquery.com/jquery-3.x.min.js") }}
- This ensures it only loads if not already present
```

---

## 7. Theme Inheritance Rules

### Font and Color Inheritance (Marketplace requirement)
```
Modules with font or color fields MUST inherit from theme settings.
Without this, you get: "Module needs to inherit from standard field names"

Use "inherited_value" with "default_value_path":

{
  "name": "heading_font",
  "label": "Heading Font",
  "type": "font",
  "inherited_value": {
    "default_value_path": "theme.heading_font"
  },
  "default": {
    "font": "Poppins",
    "fallback": "sans-serif",
    "variant": "600",
    "font_set": "GOOGLE",
    "size": 48,
    "size_unit": "px"
  }
}

Standard theme field names to inherit from:
  - theme.primary_color
  - theme.secondary_color
  - theme.heading_font
  - theme.body_font

If your theme uses different names, use alternate_names in theme fields.json:
{
  "name": "brand_color",
  "type": "color",
  "alternate_names": ["primary_color"],
  "default": { "color": "#516747" }
}
```

---

## 8. Link & Button Hover Override

HubSpot's `theme-overrides.css` applies default `a:hover` styles that override your button styling with blue color, underlines, and font changes.

**Every `<a>` styled as a button MUST include `:hover`, `:focus`, and `:active` rules** that explicitly re-declare:
- `color` (your intended color, not HubSpot's blue)
- `text-decoration: none`
- `font-family: inherit`

Without these, HubSpot's defaults bleed through on hover/focus states even when base styles look correct.

---

## 9. Common Error Messages → Causes

| Error | Likely Cause |
|-------|-------------|
| `The format for the color value is invalid` | Color field default uses rgba/rgb/named color instead of hex `{ "color": "#rrggbb", "opacity": 100 }` |
| `Cannot resolve property "[missing {{ token }} value]"` | Multiple dnd_modules in a section without width/offset |
| `"text" fields are not supported in theme fields.json` | Module folder missing .module suffix, OR text field in theme fields.json |
| `Module inherits standard fields` | Font/color field missing `inherited_value` with `default_value_path` |
| `The template cannot contain "dnd_area" modules` | Using dnd_area in a blog post template (not supported) or wrong templateType |
| Field shows entire object instead of value | URL field: use `.href`, Image: use `.src`, not just `module.field_name` |
| Icon not displaying | Icon field "style" property reads from `.type` not `.style` (HubSpot inconsistency) |
| Nested module error | Modules cannot be nested inside other modules — use sections/groups instead |
| Module JS not working for multiple instances | module.js loads once — use class selectors, not ID selectors |
| Validation errors on upload but not in UI | Use `hs cms convert-fields` to get detailed errors from JS field format |
| Changes not appearing | Saving is NOT publishing — you must click Publish |

---

## 10. HubL Syntax Quick Reference

### Variables and Expressions
```
{{ variable }}                    ← Output a value
{% statement %}                   ← Logic (if, for, set, etc.)
{# comment #}                     ← Comment (not rendered)

{{ module.field_name }}           ← Access module field
{{ content.meta_description }}    ← Access page settings
{{ request.path }}                ← Access request info
```

### Useful Filters
```
{{ variable|pprint }}             ← Debug: print variable type
{{ variable|tojson }}             ← Debug: output as JSON
{{ module.field|escape }}         ← HTML escape
{{ module.text|truncatewords(20) }}  ← Truncate text
```

### Require CSS/JS (proper asset loading)
```
{# External CSS — loads in <head> #}
{{ require_css(get_asset_url("../css/module.css")) }}

{# Inline CSS — loads in <head> via <style> tag #}
{% require_css %}
<style>
  .my-class { color: red; }
</style>
{% end_require_css %}

{# External JS — loads after CSS #}
{{ require_js(get_asset_url("../js/module.js")) }}
```

### CRM Functions Limits
```
- crm_object() and crm_objects(): max 10 calls per page
- crm_objects(): max 100 objects returned, default 10
- blog_popular_posts(): max 200 posts, max 10 calls per page
- Standard CRM objects (contacts, deals, etc.) require password-protected pages
- Only products and marketing_events can be shown on public pages
- Custom objects CAN be shown on public pages
```

---

## 11. Pre-Upload Checklist

Before deploying any HubSpot CMS code, verify:

- [ ] All module folders end with `.module` suffix
- [ ] fields.json is a JSON array `[...]` not an object `{...}`
- [ ] No field names collide with dnd reserved parameters (width, offset, label, path, styles)
- [ ] Field names use snake_case, no spaces or dashes
- [ ] All fields have `default` values (no empty defaults for required fields)
- [ ] Color field defaults use hex format `{ "color": "#rrggbb", "opacity": 100 }` — no rgba/rgb/named colors
- [ ] No Lorem Ipsum in any default values
- [ ] URL fields accessed via `.href`, image fields via `.src`
- [ ] Multiple dnd_modules in sections have `width` and `offset` defined
- [ ] dnd nesting follows: area → section → column → row → module
- [ ] Every opening dnd tag has its closing `end_` counterpart
- [ ] Module unique names use underscores: `"my_module"` not `"my-module"`
- [ ] CSS does not target HubSpot generated classes (.dnd-section, .hs-cos-wrapper, etc.)
- [ ] module.js handles multiple instances (class selectors, not ID selectors)
- [ ] Font/color fields inherit from theme via `inherited_value` if in a theme
- [ ] No `text` or `richtext` fields in theme fields.json (module-only types)
- [ ] Template annotations present at top of .html files (templateType, label, etc.)
- [ ] No errors in Design Manager OR browser console before publishing

---

*These rules will prevent 90% of the cryptic errors that HubSpot CMS throws at you. The remaining 10% will be undocumented edge cases — when in doubt, build a minimal reproduction in a sandbox account and test before deploying.*
