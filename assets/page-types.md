# HubSpot Page Types — AI Context

Each page type has specific template requirements, HubL variables, and annotation rules.

---

## Landing Page

Template annotation:
```
templateType: page
isAvailableForNewContent: true
```

Rules:
- Self-contained single page — no navigation menu required
- Full creative freedom with modules (hero, features, testimonials, CTA, footer, etc.)
- Use `{% dnd_area %}` for drag-and-drop content areas
- All modules referenced via `{% dnd_module path="../modules/ModuleName.module" %}`
- Focus on conversion: clear CTAs, social proof, benefit-driven copy
- Anchor-link navigation is fine (link to #section-id within the same page)

---

## Blog Post

Template annotation:
```
templateType: blog_post
isAvailableForNewContent: true
```

Required HubL variables — these MUST be used in the template:
- `{{ content.name }}` — post title
- `{{ content.post_body }}` — post body content (the main article)
- `{{ content.featured_image }}` — featured image URL
- `{{ content.featured_image_alt_text }}` — featured image alt text
- `{{ content.publish_date }}` — publication date (use `|datetimeformat('%B %d, %Y')`)
- `{{ content.author.display_name }}` — author name
- `{{ content.author.avatar }}` — author avatar URL
- `{{ content.tag_list }}` — list of tags
- `{{ content.topic_list }}` — list of topics
- `{{ content.comment_count }}` — number of comments
- `{{ content.absolute_url }}` — canonical URL

Optional HubL:
- `{% blog_social_sharing %}` — social share buttons
- `{% blog_comments %}` — comment section
- `{% related_blog_posts %}` — related posts widget

Rules:
- The `{{ content.post_body }}` is where blog content goes — don't replace it with modules
- Modules are for surrounding layout: header, sidebar, author bio, related posts, share buttons
- Always include a blog listing template alongside (templateType: blog_listing)
- The listing template uses `{% for content in contents %}` to loop over posts
- Blog listing required: `{{ group.public_title }}`, `{{ next_page_url }}`

---

## Website Page

Template annotation:
```
templateType: page
isAvailableForNewContent: true
```

Rules:
- MUST include navigation using `{% menu "main_nav" %}` HubL tag
- The menu reads from the portal's menu settings — links are managed in HubSpot, not hardcoded
- Footer should include `{% menu "footer_nav" %}` for footer links
- Design the menu module visually (layout, colors, hover states, mobile hamburger)
- The user wires actual page links in the HubSpot portal after publishing pages
- Include consistent header and footer across all website page templates

Navigation module pattern:
```html
<nav class="nav">
  {% menu "main_nav" %}
</nav>
```

For a custom-styled menu (when {% menu %} styling is insufficient):
```html
<nav class="nav">
  {% set menu = menu("main_nav") %}
  {% for item in menu.children %}
    <a href="{{ item.url }}" class="nav__link{% if item.active %} nav__link--active{% endif %}">
      {{ item.label }}
    </a>
  {% endfor %}
</nav>
```

Menu field type for modules:
```json
{
  "name": "navigation_menu",
  "label": "Navigation Menu",
  "type": "menu",
  "default": "main_nav"
}
```

---

## Module Only

No template annotation needed — no template is generated.

Rules:
- Only module files are generated: fields.json, meta.json, module.html, module.css, module.js
- Used for adding standalone modules to existing HubSpot themes
- The module can be used in any template via `{% dnd_module path="..." %}`
- Set `host_template_types: ["PAGE"]` in meta.json (or `["BLOG_POST"]`, `["PAGE", "BLOG_POST"]` as needed)
- Focus on making the module self-contained and reusable
