# Email Template Rules — HubSpot CMS

Rules for generating HubSpot email templates that render correctly across Gmail, Outlook, and Apple Mail.

## 1. Layout Rules — Table-Based Only

Email clients do NOT support modern CSS layout. Use HTML tables for all structure.

```html
<!-- CORRECT: table-based layout -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td align="center" style="padding: 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">
        <tr>
          <td style="padding: 40px 30px;">
            <!-- content here -->
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<!-- WRONG: flexbox/grid -->
<div style="display: flex; gap: 20px;">...</div>
<div style="display: grid; grid-template-columns: 1fr 1fr;">...</div>
```

### Column layouts

Use nested tables with explicit widths for multi-column layouts:

```html
<!-- Two columns (50/50) -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td width="50%" valign="top" style="padding-right: 10px;">
      <!-- Left column -->
    </td>
    <td width="50%" valign="top" style="padding-left: 10px;">
      <!-- Right column -->
    </td>
  </tr>
</table>
```

### Fixed widths

- Email container: 600px (the universal safe width)
- Minimum touch target: 44px height for buttons
- Image max-width: 560px (600px minus 20px padding each side)

## 2. CSS Rules — Inline Only

Email clients strip `<style>` blocks and ignore external stylesheets. ALL CSS must be inline.

### Supported CSS properties

| Property | Gmail Web | Gmail App | Outlook Desktop | Outlook 365 | Apple Mail |
|----------|-----------|-----------|-----------------|-------------|------------|
| color | Yes | Yes | Yes | Yes | Yes |
| background-color | Yes | Yes | Yes | Yes | Yes |
| font-family | Yes | Yes | Yes | Yes | Yes |
| font-size | Yes | Yes | Yes | Yes | Yes |
| font-weight | Yes | Yes | Yes | Yes | Yes |
| line-height | Yes | Yes | Yes | Yes | Yes |
| text-align | Yes | Yes | Yes | Yes | Yes |
| padding | Yes | Yes | Yes | Yes | Yes |
| margin | Partial | Partial | Yes | Partial | Yes |
| border | Yes | Yes | Yes | Yes | Yes |
| border-radius | Yes | Yes | No | Yes | Yes |
| width/height | Yes | Yes | Yes | Yes | Yes |
| max-width | Yes | Yes | No | Yes | Yes |
| text-decoration | Yes | Yes | Yes | Yes | Yes |

### NEVER use these CSS properties

- `display: flex` / `display: grid` — not supported anywhere
- `position: absolute/relative/fixed` — stripped in Gmail, broken in Outlook
- `overflow` — ignored or causes clipping
- `float` — unreliable, use table cells instead
- `box-shadow` — stripped in Gmail
- `text-shadow` — stripped in Gmail
- `transform` — not supported
- `animation` / `transition` — not supported
- `@media queries` — Gmail strips them; only use for progressive enhancement
- `calc()` — not supported in Outlook
- CSS custom properties (`var()`) — not supported
- `background-image` on `<div>` — use VML for Outlook (see MSO section)

### Font stacks for email

```
font-family: Arial, Helvetica, sans-serif;
font-family: Georgia, 'Times New Roman', Times, serif;
font-family: 'Courier New', Courier, monospace;
font-family: Verdana, Geneva, sans-serif;
font-family: Tahoma, Geneva, sans-serif;
```

Do NOT use system-ui, -apple-system, or any modern font stacks. Stick to web-safe fonts.

## 3. MSO Conditionals — Outlook Desktop

Outlook desktop (Windows) uses the Word rendering engine. Use MSO conditional comments for Outlook-specific fixes.

```html
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600">
  <tr>
    <td>
<![endif]-->

<!-- Your responsive/modern content here -->

<!--[if mso]>
    </td>
  </tr>
</table>
<![endif]-->
```

### Common MSO fixes

```html
<!-- Force width in Outlook -->
<!--[if mso]>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td>
<![endif]-->
<div style="max-width: 600px; margin: 0 auto;">
  <!-- content -->
</div>
<!--[if mso]>
</td></tr></table>
<![endif]-->

<!-- Outlook-specific button (VML) -->
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
  href="https://example.com" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="10%"
  strokecolor="#e8613a" fillcolor="#e8613a">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">
    CTA Text
  </center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<a href="https://example.com" style="background-color: #e8613a; border-radius: 4px; color: #ffffff; display: inline-block; font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; line-height: 44px; text-align: center; text-decoration: none; width: 200px;">
  CTA Text
</a>
<!--<![endif]-->
```

## 4. Image Rules

```html
<!-- Always include: width, height, alt, display:block, border:0 -->
<img src="{{ module.hero_image.src }}"
     alt="{{ module.hero_image.alt }}"
     width="560"
     height="300"
     style="display: block; border: 0; outline: none; text-decoration: none; max-width: 100%; height: auto;"
/>
```

- Always set explicit `width` and `height` attributes (not just CSS)
- Use `display: block` to prevent gaps below images
- Set `border: 0` to prevent blue link borders
- Use `height: auto` in CSS for responsive scaling
- Maximum recommended width: 560px (600px container minus padding)
- Use `alt` text for accessibility and image-off clients
- Outlook ignores `max-width` on images — set `width` attribute to the actual display size

## 5. Button Rules

Bulletproof buttons that work everywhere:

```html
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="border-radius: 4px; background-color: #e8613a;">
      <a href="{{ module.cta_link.url.href }}"
         target="_blank"
         style="display: inline-block; padding: 14px 32px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none; border-radius: 4px; background-color: #e8613a;">
        {{ module.cta_text }}
      </a>
    </td>
  </tr>
</table>
```

- Duplicate `background-color` and `border-radius` on both `<td>` and `<a>`
- Use padding on the `<a>` tag (makes entire button clickable)
- Never use `<button>` elements
- Minimum touch target: 44px height
- Include VML fallback for Outlook when border-radius is important (see MSO section)

## 6. Typography Rules

```html
<!-- Headings -->
<h1 style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 28px; font-weight: bold; line-height: 1.2; color: #1a1a2e;">
  {{ module.heading }}
</h1>

<!-- Body text -->
<p style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
  {{ module.body_text }}
</p>

<!-- Small/preheader text -->
<span style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.4; color: #999999;">
  {{ module.preheader }}
</span>
```

- Always set `margin: 0` on headings/paragraphs (reset defaults)
- Re-declare `font-family` on every text element
- Use px units (not rem/em) — email clients handle relative units inconsistently
- Line-height: use unitless values (1.5) or px (24px), not em/rem
- Outlook ignores `line-height` on `<p>` — use `mso-line-height-rule: exactly` if needed

## 7. Spacing & Dividers

```html
<!-- Vertical spacer -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td style="padding: 20px 0; font-size: 0; line-height: 0;">&nbsp;</td>
  </tr>
</table>

<!-- Horizontal divider -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td style="padding: 20px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="border-top: 1px solid #e0e0e0; font-size: 0; line-height: 0;">&nbsp;</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

- Use `padding` on `<td>` for spacing (not `margin`)
- Include `&nbsp;` in empty cells (Outlook collapses empty TDs)
- Use `font-size: 0; line-height: 0;` on spacer cells

## 8. HubL for Email — Safe Subset

### Supported HubL in email

```html
<!-- Module fields (same as pages) -->
{{ module.field_name }}
{{ module.field_name|escape }}

<!-- Conditionals -->
{% if module.show_section %}
  ...
{% endif %}

<!-- Loops (for repeater fields) -->
{% for item in module.items %}
  {{ item.title }}
{% endfor %}

<!-- Color fields -->
{{ module.bg_color.color }}

<!-- Link fields -->
{{ module.cta_link.url.href }}

<!-- Image fields -->
{{ module.hero_image.src }}
{{ module.hero_image.alt }}

<!-- Email-specific variables -->
{{ site_settings.company_name }}
{{ site_settings.company_street_address_1 }}
{{ site_settings.company_city }}
{{ site_settings.company_state }}
{{ unsubscribe_link }}
{{ unsubscribe_link_all }}
{{ site_settings.company_name }}
```

### NOT supported in email

- `require_css()` / `require_js()` — no external asset loading
- `scope_css` tag — no style blocks to scope
- `get_asset_url()` — use absolute URLs or image fields instead
- `module.js` — no JavaScript execution in email
- `dnd_area` / `dnd_section` / `dnd_module` — use email DnD system instead
- Custom JavaScript or IntersectionObserver
- `now()` / `local_dt` — use `{{ content.publish_date }}` instead

## 9. Email-Specific Required Elements

### Preheader text

Hidden preview text shown in inbox previews:

```html
<!-- Preheader: hidden preview text -->
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">
  {{ module.preheader_text }}
  <!-- Pad with invisible whitespace to prevent inbox from pulling body text -->
  &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
</div>
```

### Unsubscribe link (legally required)

```html
<a href="{{ unsubscribe_link }}" style="color: #999999; font-size: 12px; text-decoration: underline;">
  Unsubscribe
</a>
```

### Physical address (CAN-SPAM)

```html
<p style="margin: 0; font-family: Arial, sans-serif; font-size: 12px; color: #999999; line-height: 1.4;">
  {{ site_settings.company_name }}<br>
  {{ site_settings.company_street_address_1 }}<br>
  {{ site_settings.company_city }}, {{ site_settings.company_state }}
</p>
```

### View in browser

```html
<a href="{{ view_as_page_url }}" style="color: #999999; font-size: 12px; text-decoration: underline;">
  View in browser
</a>
```

## 10. Email meta.json

```json
{
  "host_template_types": ["EMAIL"],
  "is_available_for_new_content": true
}
```

Note: `host_template_types` is `["EMAIL"]`, not `["PAGE"]`.

## 11. Dark Mode Considerations

Some email clients support dark mode. Use meta tags and inline styles to handle it gracefully:

```html
<!-- In the <head> (HubSpot template level, not module level) -->
<meta name="color-scheme" content="light dark">
<meta name="supported-color-modes" content="light dark">
```

For module content, use high-contrast colors that work in both modes:
- Avoid pure white (#ffffff) backgrounds — use #fafafa or #f5f5f5
- Avoid pure black (#000000) text — use #1a1a2e or #333333
- Use transparent backgrounds where possible
- Test both color schemes

## 12. Pre-Send Checklist

- [ ] Container width is 600px
- [ ] All layout uses `<table role="presentation">`
- [ ] All CSS is inline (no `<style>` blocks)
- [ ] No flexbox, grid, float, or position
- [ ] No CSS custom properties (var())
- [ ] No calc(), transform, animation, transition
- [ ] All images have width, height, alt, display:block, border:0
- [ ] Buttons use table+anchor pattern (no `<button>` elements)
- [ ] All font sizes in px (not rem/em)
- [ ] Font stacks use web-safe fonts only
- [ ] MSO conditionals wrap the outer container
- [ ] Includes unsubscribe link
- [ ] Includes physical address
- [ ] Preheader text is present
- [ ] meta.json uses `host_template_types: ["EMAIL"]`
- [ ] No `require_css`, `require_js`, `scope_css`, or `get_asset_url`
- [ ] No module.js file
- [ ] All links have absolute URLs or HubL variables
- [ ] Touch targets are at least 44px
