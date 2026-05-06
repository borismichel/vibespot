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

  // Placeholder landing page template — gets replaced once AI generates real modules.
  // Marked isAvailableForNewContent: false so it won't appear in HubSpot as a usable template.
  const landingTemplate = `<!--
  templateType: page
  isAvailableForNewContent: false
  label: ${themeName} (placeholder)
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
  {% if template_css %}
    {{ require_css(get_asset_url(template_css)) }}
  {% endif %}
  {{ standard_header_includes }}
</head>
<body>
  {% block body %}{% endblock body %}
  {% if template_js %}
    {{ require_js(get_asset_url(template_js)) }}
  {% endif %}
  {{ standard_footer_includes }}
</body>
</html>
`;
  mkdirSync(join(themePath, "templates", "layouts"), { recursive: true });
  writeFileSync(join(themePath, "templates", "layouts", "base.html"), baseLayout);
}

/**
 * Add an email template to an existing theme scaffold.
 * HubSpot email templates need a different templateType and structure.
 */
export function addEmailTemplateToTheme(themePath: string, themeName: string): void {
  const emailTemplate = `<!--
  templateType: email
  isAvailableForNewContent: true
  label: ${themeName} Email Template
  screenshotPath: ../images/template-previews/email.png
-->
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  {{ standard_header_includes }}
  {{ dnd_area_stylesheet }}
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f4;">
    <tr>
      <td align="center" style="padding:20px 0;">
        {% dnd_area "main"
          label="Email Content"
        %}
        {% end_dnd_area %}
      </td>
    </tr>
  </table>
  {{ standard_footer_includes }}
</body>
</html>
`;
  mkdirSync(join(themePath, "templates"), { recursive: true });
  writeFileSync(join(themePath, "templates", "email.html"), emailTemplate);
}
