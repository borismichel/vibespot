---
id: blog-content-hub
label: Blog / Content Hub
description: Editorial home — feature posts, drive subscriptions
icon: book-open
order: 40
---

# Blog / Content Hub

## Goal
Surface the best content, build readership, and capture email subscriptions.

## Audience
TBD — who reads this content and what do they come for?

## Primary CTA
TBD — typically "Subscribe" or "Read latest". Secondary: "Browse by topic".

## Blog Listing Modules
1. **blog-header** — blog name, tagline, hero area
2. **topic-filter** — pill/chip navigation for categories (uses `blog_topics()` HubL)
3. **post-grid** — card grid with `{% for content in contents %}` loop, pagination
4. **newsletter-signup** — email capture with value-prop copy
5. **popular-posts** — sidebar or section with evergreen / most-read posts (uses `blog_recent_posts()`)

## Blog Post Modules
1. **blog-post-header** — title (`content.name`), featured image, author avatar, date, tags
2. **blog-post-body** — wraps `{{ content.post_body }}` with reading-optimized typography (18-20px body, 720px max-width)
3. **author-bio** — author card with `content.author.avatar`, bio, social links
4. **related-posts** — 3 related post cards (uses `blog_recent_posts()`)
5. **share-bar** — social sharing buttons (uses `{% blog_social_sharing %}` or custom links)

## HubSpot Blog Variables
- Post: `content.name`, `content.post_body`, `content.featured_image`, `content.publish_date`, `content.blog_post_author`, `content.tag_list`
- Listing: `{% for content in contents %}`, `group.public_title`, pagination via `blog_page_link()`
- Meta: `host_template_types: ["BLOG_POST"]` or `["BLOG_LISTING"]` in meta.json

## Brand & Tone
TBD — magazine/editorial, technical/research, conversational/personal

## Open questions
- [ ] What is the publication / blog called and what is its niche?
- [ ] How many posts per week/month does it publish?
- [ ] What are the top 3–5 content categories or topics?
- [ ] Single author, small editorial team, or many contributors?
- [ ] Is the primary conversion newsletter signup, ad views, or product upsell?
- [ ] Do you want a featured post slot (editor pick) on the hub?
- [ ] Any reference publications you admire (The Verge, Stratechery, Substack-style)?
- [ ] Should categories be discoverable in the hero, secondary nav, or footer?
