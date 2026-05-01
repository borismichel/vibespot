# BLOG_RULES.md — HubSpot Blog Template Rules & Variables

> Rules for generating HubSpot blog listing and blog post templates. Every variable and pattern here comes from the HubSpot CMS blog documentation and real template validation.

---

## 1. Template Types

HubSpot blogs require TWO templates:

### Blog Post Template
- `templateType: blog_post` in the template annotation
- Renders a single blog post
- `host_template_types: ["BLOG_POST"]` in module meta.json

### Blog Listing Template
- `templateType: blog_listing` in the template annotation
- Renders the blog index / archive page with post cards
- `host_template_types: ["BLOG_LISTING"]` in module meta.json

Modules can support both: `host_template_types: ["BLOG_POST", "BLOG_LISTING"]`

---

## 2. Blog Post Variables (Required)

These HubL variables are available in blog post templates:

```
{{ content.name }}                    — Post title
{{ content.post_body }}               — Full post body HTML (the article content)
{{ content.featured_image }}          — Featured image URL
{{ content.featured_image_alt_text }} — Featured image alt text
{{ content.publish_date }}            — Publish date (use |datetimeformat)
{{ content.updated }}                 — Last updated date
{{ content.meta_description }}        — SEO meta description / excerpt
{{ content.absolute_url }}            — Canonical URL
{{ content.comment_count }}           — Number of comments
```

### Author Variables
```
{{ content.blog_post_author }}        — Author display name
{{ content.author.display_name }}     — Author display name (alternative)
{{ content.author.avatar }}           — Author avatar image URL
{{ content.author.bio }}              — Author bio text
{{ content.author.slug }}             — Author URL slug
{{ content.author.email }}            — Author email
```

### Tag & Topic Variables
```
{{ content.tag_list }}                — List of tags (iterable)
{{ content.topic_list }}              — List of topics/categories (iterable)
```

Tag iteration:
```html
{% for tag in content.tag_list %}
  <a href="{{ blog_tag_url(group.id, tag.slug) }}">{{ tag.name }}</a>
{% endfor %}
```

### Date Formatting
```html
{{ content.publish_date|datetimeformat('%B %d, %Y') }}
<!-- Output: April 30, 2026 -->

{{ content.publish_date|datetimeformat('%b %d') }}
<!-- Output: Apr 30 -->
```

---

## 3. Blog Listing Variables (Required)

These HubL variables are available in blog listing templates:

### Post Loop
```html
{% for content in contents %}
  <h2><a href="{{ content.absolute_url }}">{{ content.name }}</a></h2>
  <p>{{ content.meta_description|truncate(160) }}</p>
  {% if content.featured_image %}
    <img src="{{ content.featured_image }}" alt="{{ content.featured_image_alt_text }}" />
  {% endif %}
  <span>{{ content.publish_date|datetimeformat('%B %d, %Y') }}</span>
  <span>{{ content.blog_post_author }}</span>
{% endfor %}
```

### Blog Metadata
```
{{ group.public_title }}              — Blog name/title
{{ group.description }}               — Blog description
{{ group.absolute_url }}              — Blog listing URL
```

### Pagination
```html
{% if last_page_num > 1 %}
  <nav class="blog-pagination">
    {% if current_page_num > 1 %}
      <a href="{{ blog_page_link(current_page_num - 1) }}">Previous</a>
    {% endif %}

    {% for page_num in range(1, last_page_num + 1) %}
      {% if page_num == current_page_num %}
        <span class="current">{{ page_num }}</span>
      {% else %}
        <a href="{{ blog_page_link(page_num) }}">{{ page_num }}</a>
      {% endif %}
    {% endfor %}

    {% if current_page_num < last_page_num %}
      <a href="{{ blog_page_link(current_page_num + 1) }}">Next</a>
    {% endif %}
  </nav>
{% endif %}
```

### Filtering by Topic/Tag
```html
{% set topics = blog_topics(group.id, 250) %}
{% for topic in topics %}
  <a href="{{ blog_tag_url(group.id, topic.slug) }}"
     class="{% if topic.slug == tag %}active{% endif %}">
    {{ topic.name }}
  </a>
{% endfor %}
```

---

## 4. Related Posts & Widgets

### Related Posts
```html
{% related_blog_posts limit=3 %}
```

Or manual implementation:
```html
{% set recent = blog_recent_posts(group.id, 3) %}
{% for post in recent %}
  {% if post.absolute_url != content.absolute_url %}
    <a href="{{ post.absolute_url }}">{{ post.name }}</a>
  {% endif %}
{% endfor %}
```

### Blog Social Sharing
```html
{% blog_social_sharing %}
```

### Blog Comments
```html
{% blog_comments %}
```

### Blog Subscribe (CTA)
```html
{% blog_subscribe "blog_subscribe" overrideable=True, label="Blog Subscribe" %}
```

---

## 5. Reading-Optimized Design Rules

### Typography
- Body text: 18-20px for long-form readability
- Line height: 1.6-1.8 for body copy
- Content width: 680-720px max for article body (optimal reading measure)
- Heading scale: use a clear hierarchy (h1 > h2 > h3)

### Spacing
- Generous paragraph spacing: 1.5em between paragraphs
- Section breaks: 3-4rem between major sections
- Whitespace is critical for readability

### Images
- Featured image: full-width within content area, 16:9 or 3:2 aspect ratio
- In-article images: max-width: 100% within the content column
- Always include alt text fields
- Use lazy loading: `loading="lazy"` on images below the fold

### Colors
- High contrast for body text (WCAG AA minimum)
- Subtle accent for links (distinguishable but not distracting)
- Light background for reading (dark text on light bg for articles)

---

## 6. Module Patterns for Blog

### Blog Post Modules (typical set)
1. **blog-post-header** — Title, featured image, author, date, tags
2. **blog-post-body** — The `{{ content.post_body }}` wrapper with reading-optimized styles
3. **author-bio** — Author card with avatar, name, bio, social links
4. **related-posts** — 3 related post cards
5. **blog-comments** — Comment section
6. **share-bar** — Social sharing buttons

### Blog Listing Modules (typical set)
1. **blog-hero** — Blog name, description, featured/pinned post
2. **topic-filter** — Category/tag navigation pills
3. **post-grid** — Card grid of posts with pagination
4. **newsletter-signup** — Email subscription form
5. **popular-posts** — Sidebar or section with most-read posts

### Module meta.json for Blog Post
```json
{
  "host_template_types": ["BLOG_POST"],
  "is_available_for_new_content": true
}
```

### Module meta.json for Blog Listing
```json
{
  "host_template_types": ["BLOG_LISTING"],
  "is_available_for_new_content": true
}
```

---

## 7. Common Mistakes

- Using `{{ content.body }}` instead of `{{ content.post_body }}` — post_body is the correct variable
- Forgetting pagination on listing templates — always include when more than 1 page
- Not using `|datetimeformat` on dates — raw dates are ugly
- Using `now()` — not valid HubL, use `local_dt` instead
- Hardcoding blog URLs — use `{{ content.absolute_url }}` and `{{ blog_page_link() }}`
- Missing `{% for content in contents %}` loop on listing pages — this is required
- Using page-style `{% dnd_area %}` in blog templates — blog templates use fixed module positions
- Not setting correct `host_template_types` — blog modules need `BLOG_POST` or `BLOG_LISTING`

---

## 8. SEO Essentials

Blog post templates should include:
- `<title>{{ content.name }} | {{ group.public_title }}</title>` (or via HubSpot settings)
- `<meta name="description" content="{{ content.meta_description }}" />`
- `<link rel="canonical" href="{{ content.absolute_url }}" />`
- Open Graph tags for social sharing
- Structured data (Article schema) where possible
- Proper heading hierarchy (single h1 for post title)
