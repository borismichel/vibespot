/**
 * Theme scaffold generator — replaces `hs cms theme create`.
 * Creates the standard HubSpot theme directory structure locally.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Create a minimal HubSpot theme directory structure.
 * Produces the same layout as `hs cms theme create` but without
 * boilerplate modules/templates (vibespot generates those via AI).
 */
export function createThemeScaffold(themePath: string, themeName: string): void {
  // Create directories
  mkdirSync(themePath, { recursive: true });
  mkdirSync(join(themePath, "templates"), { recursive: true });
  mkdirSync(join(themePath, "modules"), { recursive: true });
  mkdirSync(join(themePath, "css"), { recursive: true });
  mkdirSync(join(themePath, "js"), { recursive: true });
  mkdirSync(join(themePath, "images"), { recursive: true });
  mkdirSync(join(themePath, "assets"), { recursive: true });

  // theme.json — required by HubSpot
  const themeJson = {
    label: themeName,
    preview_path: "./templates/home.html",
    screenshot_path: "./images/template-previews/home.png",
    enable_domain_stylesheets: false,
    version: "1.0.0",
    author: {
      name: "vibeSpot",
      url: "https://github.com/borismichel/vibespot",
    },
  };
  writeFileSync(join(themePath, "theme.json"), JSON.stringify(themeJson, null, 2) + "\n");

  // fields.json — empty theme-level fields
  writeFileSync(join(themePath, "fields.json"), "[]\n");

  // Landing page template — minimal DnD template for vibespot modules
  const landingTemplate = `<!--
  templateType: page
  isAvailableForNewContent: true
  label: ${themeName} Landing Page
  screenshotPath: ../images/template-previews/home.png
-->
{% extends "./layouts/base.html" %}

{% block body %}
{% dnd_area "main_content"
  label="Main Content",
  class="body-container body-container--${themeName}"
%}
{% end_dnd_area %}
{% endblock body %}
`;
  writeFileSync(join(themePath, "templates", "home.html"), landingTemplate);

  // Base layout
  const baseLayout = `<!--
  templateType: none
  isAvailableForNewContent: false
  label: Base Layout
-->
<!DOCTYPE html>
<html lang="{{ html_lang }}" {{ html_lang_dir }}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  {{ standard_header_includes }}
</head>
<body>
  {% block body %}{% endblock body %}
  {{ standard_footer_includes }}
</body>
</html>
`;
  mkdirSync(join(themePath, "templates", "layouts"), { recursive: true });
  writeFileSync(join(themePath, "templates", "layouts", "base.html"), baseLayout);
}
