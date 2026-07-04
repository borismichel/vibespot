/**
 * Shared HTML escaper (VIB-1902). Loaded before every script that
 * interpolates untrusted strings into innerHTML — chat.js, plan.js and
 * email-preview.js previously each carried their own copy (the
 * email-preview one didn't escape quotes, so it was unsafe in attribute
 * context). One definition, attribute-safe, used everywhere.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
