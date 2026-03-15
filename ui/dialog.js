/**
 * Shared modal dialog utilities — styled replacements for native alert/confirm/prompt.
 * Uses the existing .confirm-overlay / .confirm-dialog CSS pattern.
 */

// HTML-escape helper (standalone so dialog.js has no load-order dependency)
if (typeof esc === "undefined") {
  // eslint-disable-next-line no-var
  var _escMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var esc = function (str) {
    return String(str).replace(/[&<>"']/g, function (c) { return _escMap[c]; });
  };
}

/**
 * Show a styled alert dialog (replaces window.alert).
 * @param {string} message — the message to display
 * @param {string} [title] — optional dialog title
 * @returns {Promise<void>}
 */
function vibeAlert(message, title) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        ${title ? `<div class="confirm-dialog__title">${esc(title)}</div>` : ""}
        <p class="confirm-dialog__detail">${esc(message)}</p>
        <div class="confirm-dialog__actions">
          <button class="btn btn--primary" data-action="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector('[data-action="ok"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  });
}

/**
 * Show a styled confirm dialog (replaces window.confirm).
 * @param {string} title — dialog title / question
 * @param {string} [detail] — optional detail text
 * @param {object} [opts] — options: { confirmLabel, confirmClass }
 * @returns {Promise<boolean>}
 */
function vibeConfirm(title, detail, opts) {
  const label = (opts && opts.confirmLabel) || "Confirm";
  const btnClass = (opts && opts.confirmClass) || "btn--danger";
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">${esc(title)}</div>
        ${detail ? `<p class="confirm-dialog__warn">${esc(detail)}</p>` : ""}
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" data-action="cancel">Cancel</button>
          <button class="btn ${btnClass}" data-action="confirm">${esc(label)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
  });
}

/**
 * Show a styled prompt dialog with an input field (replaces window.prompt).
 * @param {string} title — dialog title
 * @param {string} [defaultValue] — pre-filled input value
 * @param {string} [placeholder] — input placeholder
 * @returns {Promise<string|null>} — input value or null if cancelled
 */
function vibePrompt(title, defaultValue, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">${esc(title)}</div>
        <input
          type="text"
          class="confirm-dialog__input"
          value="${esc(defaultValue || "")}"
          placeholder="${esc(placeholder || "")}"
          data-role="input"
        />
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" data-action="cancel">Cancel</button>
          <button class="btn btn--primary" data-action="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('[data-role="input"]');
    setTimeout(() => { input.focus(); input.select(); }, 50);

    const close = (val) => { overlay.remove(); resolve(val); };

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => close(input.value));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value);
      if (e.key === "Escape") close(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Feedback form → HubSpot Forms API
// ---------------------------------------------------------------------------

const _FEEDBACK_PORTAL = "144870572";
const _FEEDBACK_FORM   = "4f18572f-a3ec-4193-bcfd-a373f54d86d2";
let _feedbackCooldown = false;

/**
 * Show a feedback dialog that submits to a HubSpot form.
 * @returns {Promise<void>}
 */
function vibeFeedback() {
  if (_feedbackCooldown) {
    return vibeAlert("Please wait a moment before submitting another report.", "Cooldown");
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog" style="max-width:440px">
        <div class="confirm-dialog__title">Submit Feedback</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin:12px 0">
          <label style="font-size:13px;color:var(--text-dim)">Type
            <select data-role="type" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-input);color:var(--text);font-size:13px">
              <option value="Bug Report">Bug Report</option>
              <option value="Feature Request">Feature Request</option>
              <option value="Comment">Comment</option>
            </select>
          </label>
          <label style="font-size:13px;color:var(--text-dim)">Email (optional)
            <input type="email" data-role="email" placeholder="you@example.com" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-input);color:var(--text);font-size:13px;box-sizing:border-box" />
          </label>
          <label style="font-size:13px;color:var(--text-dim)">Message
            <textarea data-role="message" rows="5" maxlength="2000" placeholder="Describe the issue or idea..." style="display:block;width:100%;margin-top:4px;padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-input);color:var(--text);font-size:13px;resize:vertical;font-family:inherit;box-sizing:border-box"></textarea>
          </label>
        </div>
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" data-action="cancel">Cancel</button>
          <button class="btn btn--primary" data-action="submit">Submit</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const typeEl = overlay.querySelector('[data-role="type"]');
    const emailEl = overlay.querySelector('[data-role="email"]');
    const msgEl = overlay.querySelector('[data-role="message"]');
    const submitBtn = overlay.querySelector('[data-action="submit"]');

    setTimeout(() => msgEl.focus(), 50);

    const close = () => { overlay.remove(); resolve(); };

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    submitBtn.addEventListener("click", async () => {
      const message = msgEl.value.trim();
      if (!message) { msgEl.style.borderColor = "var(--error)"; msgEl.focus(); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Sending...";

      try {
        const res = await fetch(
          `https://api.hsforms.com/submissions/v3/integration/submit/${_FEEDBACK_PORTAL}/${_FEEDBACK_FORM}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fields: [
                { name: "report_type", value: typeEl.value },
                { name: "email", value: emailEl.value },
                { name: "message", value: message },
              ],
              context: { pageUri: window.location.href, pageName: "vibespot" },
            }),
          }
        );
        if (!res.ok) throw new Error("HTTP " + res.status);
        close();
        _feedbackCooldown = true;
        setTimeout(() => { _feedbackCooldown = false; }, 30000);
        await vibeAlert("Thank you! Your feedback has been submitted.", "Feedback Sent");
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
        await vibeAlert("Failed to submit: " + err.message, "Error");
      }
    });
  });
}

/**
 * Show a large scrollable content viewer dialog with rendered markdown.
 * Uses the `marked` library (loaded via vendor/marked.umd.js).
 * @param {string} content — markdown text to display
 * @param {string} [title] — dialog title
 * @returns {Promise<void>}
 */
function vibeViewContent(content, title, downloadFilename) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const dialog = document.createElement("div");
    dialog.className = "confirm-dialog confirm-dialog--wide";

    if (title) {
      dialog.innerHTML = '<div class="confirm-dialog__title">' + esc(title) + '</div>';
    }

    const body = document.createElement("div");
    body.className = "confirm-dialog__content-view md-body";
    body.innerHTML = typeof marked !== "undefined" ? marked.parse(content) : esc(content);
    // Inject color swatches next to hex codes
    body.innerHTML = body.innerHTML.replace(
      /(#[0-9A-Fa-f]{3,8})(?![0-9A-Fa-f])/g,
      '<span class="color-swatch-wrap">$1<span class="color-swatch" style="background:$1"></span></span>'
    );
    dialog.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "confirm-dialog__actions";
    if (downloadFilename) {
      actions.innerHTML = '<button class="btn btn--secondary" data-action="download">Download</button>';
    }
    actions.innerHTML += '<button class="btn btn--primary" data-action="ok">Close</button>';
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); resolve(); };
    if (downloadFilename) {
      overlay.querySelector('[data-action="download"]').addEventListener("click", () => {
        const blob = new Blob([content], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadFilename;
        a.click();
        URL.revokeObjectURL(url);
      });
    }
    overlay.querySelector('[data-action="ok"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(); }
    });
  });
}
