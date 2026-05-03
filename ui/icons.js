/**
 * SVG icon system — Material Design-inspired, stroke-based icons.
 * Follows existing codebase convention: 24×24 viewBox, stroke="currentColor",
 * stroke-width from --icon-stroke (1.5), round line caps/joins.
 */

/* eslint-disable max-len */
const VS_ICON_PATHS = {
  // Sparkle / auto-awesome — 4-pointed star burst
  sparkle: '<path d="M12 2L14.09 8.26L20 9.27L15.55 13.97L16.91 20L12 16.9L7.09 20L8.45 13.97L4 9.27L9.91 8.26L12 2Z"/>',

  // Settings / gear
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',

  // Check — simple checkmark
  check: '<polyline points="20 6 9 17 4 12"/>',

  // Check circle — checkmark inside circle
  "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',

  // X circle — error/failure
  "x-circle": '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',

  // Rocket — celebration / deploy success
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',

  // Copy — clone/duplicate
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',

  // Star — filled star
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',

  // Chevron down
  "chevron-down": '<polyline points="6 9 12 15 18 9"/>',

  // Send / arrow-up (for submit button)
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',

  // Arrow up
  "arrow-up": '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',

  // Plus
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',

  // Download
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',

  // Diamond — design/Figma
  diamond: '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z"/>',

  // Refresh / convert
  "refresh-cw": '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',

  // Auto-awesome / sparkle stars (for suggestion chips)
  "auto-awesome": '<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/><path d="M20 5l.8 2.4L23 8.2l-2.2.8L20 11.4l-.8-2.4-2.2-.8 2.2-.8z" opacity=".6"/>',

  // Wave / hand — greeting
  hand: '<path d="M18 11V6a1 1 0 0 0-2 0"/><path d="M16 8V4a1 1 0 0 0-2 0v1"/><path d="M14 8V5a1 1 0 0 0-2 0v5"/><path d="M12 13V8.5a1 1 0 0 0-2 0V14"/><path d="M20 15.5c0 3.59-2.91 6.5-6.5 6.5H12c-3.31 0-6-2.69-6-6V9a1 1 0 0 1 2 0v4"/><path d="M18 11a1 1 0 0 1 2 0v3.5"/>',

  // File / document — landing page
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',

  // Mail / envelope — email
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 4 12 13 2 4"/>',

  // Globe — website
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',

  // Edit / pencil — blog post
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',

  // Palette — template
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12" r="1.5"/><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c.55 0 1-.45 1-1v-1.5c0-.83.67-1.5 1.5-1.5H16a4 4 0 0 0 4-4c0-4.42-3.58-8-8-8z"/>',

  // Inbox / import — download into
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',

  // Arrow left — back button
  "arrow-left": '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'
};
/* eslint-enable max-len */

/**
 * Return an inline SVG string for the named icon.
 * @param {string} name  — key from VS_ICON_PATHS
 * @param {object} [opts]
 * @param {string} [opts.size]      — CSS class: "sm" (16 px) | "md" (20 px, default) | custom px value
 * @param {string} [opts.class]     — extra CSS classes
 * @param {string} [opts.ariaLabel] — accessible label (omit for decorative icons)
 * @returns {string} SVG markup
 */
function vsIcon(name, opts) {
  const o = opts || {};
  const paths = VS_ICON_PATHS[name];
  if (!paths) return "";

  const sizeClass = o.size === "sm" ? " icon--sm" : o.size === "md" ? " icon--md" : "";
  const extra = o.class ? " " + o.class : "";
  const cls = "vs-icon" + sizeClass + extra;

  const ariaAttrs = o.ariaLabel
    ? `role="img" aria-label="${o.ariaLabel}"`
    : 'aria-hidden="true"';

  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${ariaAttrs}>${paths}</svg>`;
}

/**
 * Return a CSS-safe SVG data URI for use in content / background-image.
 * @param {string} name — key from VS_ICON_PATHS
 * @param {string} [color] — stroke color (default: currentColor placeholder, use %23 for #)
 * @returns {string} url("data:image/svg+xml,...")
 */
function vsIconDataUri(name, color) {
  const paths = VS_ICON_PATHS[name];
  if (!paths) return "none";
  const c = color || "currentColor";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`;
  return "url(\"data:image/svg+xml," + encodeURIComponent(svg) + "\")";
}
