/**
 * Plan mode UI controller.
 *
 * Owns:
 *   - Plan-mode toggle (chat input button → /api/settings)
 *   - Plan pane in the main window (rendered markdown + inline editor)
 *   - Approve / Discard actions (WebSocket)
 *   - Choice chips (rendered below assistant chat bubbles)
 *
 * Communicates with chat.js via:
 *   - global `planModeActive` flag (read by chat.js to know whether we're planning)
 *   - global `currentPlan` string (latest plan markdown)
 *   - the existing `ws` WebSocket (sends `plan_approve` / `plan_discard`)
 */

(function () {
  // ---- Module state ----
  let planModeActive = false;
  let currentPlan = "";
  let editing = false;
  let templates = null; // PlanTemplateMetadata[] | null — lazy-loaded
  let templatesLoading = false;
  let templatesError = null;

  // ---- Element refs (resolved on first use) ----
  const $ = (id) => document.getElementById(id);

  // ---- Minimal GFM-subset markdown renderer ----
  // Supports: headings, paragraphs, ordered/unordered lists, bold/italic,
  // code spans, fenced code blocks, blockquotes, horizontal rules,
  // simple tables, links. Sufficient for what the plan-mode AI emits.
  function renderMarkdown(md) {
    if (!md) return "";

    const escape = (s) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    // Pull out fenced code blocks first so we don't process their contents.
    const fences = [];
    md = md.replace(/```([a-zA-Z0-9-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const idx = fences.length;
      const langCls = lang ? ` class="language-${escape(lang)}"` : "";
      fences.push(`<pre><code${langCls}>${escape(code)}</code></pre>`);
      return `FENCE${idx}`;
    });

    const lines = md.split(/\r?\n/);
    const out = [];
    let i = 0;

    const inlineFormat = (text) => {
      let s = escape(text);
      // Code spans
      s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
      // Bold (**text** or __text__)
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      // Italic (*text* or _text_)
      s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
      // Links [text](url) — `u` was escaped above (incl. quotes), so it can't
      // break out of the href attribute; the scheme check blocks javascript: etc.
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => {
        const safeUrl = /^(https?:|\/|#|mailto:)/i.test(u.trim()) ? u.trim() : "#";
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      });
      return s;
    };

    while (i < lines.length) {
      const line = lines[i];

      // Horizontal rule
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // Heading
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inlineFormat(quote.join(" "))}</blockquote>`);
        continue;
      }

      // Tables (very simple: header | header / --- | --- / row | row)
      if (
        /^\s*\|.*\|\s*$/.test(line) &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const parseRow = (l) =>
          l
            .replace(/^\s*\||\|\s*$/g, "")
            .split("|")
            .map((c) => c.trim());
        const headers = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${headers
          .map((h) => `<th>${inlineFormat(h)}</th>`)
          .join("")}</tr></thead>`;
        const tbody = `<tbody>${rows
          .map(
            (r) =>
              `<tr>${r.map((c) => `<td>${inlineFormat(c)}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody>`;
        out.push(`<table>${thead}${tbody}</table>`);
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i++;
        }
        out.push(
          `<ul>${items.map((it) => `<li>${inlineFormat(it)}</li>`).join("")}</ul>`,
        );
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i++;
        }
        out.push(
          `<ol>${items.map((it) => `<li>${inlineFormat(it)}</li>`).join("")}</ol>`,
        );
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      // Paragraph (combine consecutive non-empty, non-block lines)
      const para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) out.push(`<p>${inlineFormat(para.join(" "))}</p>`);
    }

    let html = out.join("\n");
    // Restore fenced code blocks.
    html = html.replace(/FENCE(\d+)/g, (_m, idx) => fences[Number(idx)]);
    return html;
  }

  // ---- Template picker ----
  // Fetches template metadata once per page load, caches it in the closure.
  async function ensureTemplates() {
    if (templates !== null || templatesLoading) return;
    templatesLoading = true;
    try {
      const res = await fetch("/api/plan/templates");
      const data = await res.json();
      templates = Array.isArray(data.templates) ? data.templates : [];
    } catch (err) {
      console.error("[plan] failed to load templates", err);
      templates = [];
      templatesError = err && err.message ? err.message : String(err);
    } finally {
      templatesLoading = false;
      // Re-render in case the empty state is currently visible.
      if (!currentPlan.trim()) renderPlanPane(currentPlan);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Inline SVG icons keyed by the template's `icon` field. Anything else
  // falls back to a neutral document glyph so the picker still renders.
  const TEMPLATE_ICONS = {
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/></svg>',
    "shopping-bag": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    "book-open": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
    utensils: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2v7a3 3 0 003 3v10"/><path d="M9 2v7a3 3 0 01-3 3"/><path d="M6 2v6"/><path d="M18 2c-2 0-4 2-4 5s2 5 4 5v10"/></svg>',
    document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  };

  function templateIcon(name) {
    return TEMPLATE_ICONS[name] || TEMPLATE_ICONS.document;
  }

  function renderTemplatePicker() {
    if (templatesLoading || templates === null) {
      return (
        '<div class="plan-templates plan-templates--loading">' +
        '<p class="plan-templates__hint">Loading templates…</p>' +
        "</div>"
      );
    }

    const blank =
      '<button class="plan-template plan-template--blank" data-template-id="" type="button">' +
      '<span class="plan-template__icon">' + TEMPLATE_ICONS.document + "</span>" +
      '<span class="plan-template__body">' +
      '<span class="plan-template__label">Blank plan</span>' +
      '<span class="plan-template__desc">Start with a free-form chat — no pre-filled structure.</span>' +
      "</span>" +
      "</button>";

    const cards = templates
      .map(
        (t) =>
          '<button class="plan-template" data-template-id="' +
          escapeHtml(t.id) +
          '" type="button">' +
          '<span class="plan-template__icon">' + templateIcon(t.icon) + "</span>" +
          '<span class="plan-template__body">' +
          '<span class="plan-template__label">' + escapeHtml(t.label) + "</span>" +
          '<span class="plan-template__desc">' + escapeHtml(t.description || "") + "</span>" +
          "</span>" +
          "</button>",
      )
      .join("");

    const errorBlock = templatesError
      ? '<p class="plan-templates__error">Failed to load templates (' +
        escapeHtml(templatesError) +
        "). Pick Blank to keep going.</p>"
      : "";

    return (
      '<div class="plan-templates">' +
      '<h3 class="plan-templates__title">Start with a template</h3>' +
      '<p class="plan-templates__hint">Pick a page type to seed the plan with a structure and page-specific questions. Or pick Blank to start from scratch.</p>' +
      errorBlock +
      '<div class="plan-templates__grid">' +
      cards +
      blank +
      "</div>" +
      "</div>"
    );
  }

  async function applyTemplate(templateId) {
    if (!templateId) {
      // "Blank" — just turn plan mode on without a seed plan.
      try {
        await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planMode: true }),
        });
      } catch (err) {
        console.error("[plan] failed to enable plan mode", err);
      }
      planModeActive = true;
      window.planModeActive = true;
      reflectToggleState();
      reflectModeBadge();
      // Still empty — render a friendlier hint rather than the picker again.
      renderPlanPaneEmptyHint();
      return;
    }

    try {
      const res = await fetch("/api/plan/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentPlan = data.plan || "";
      window.currentPlan = currentPlan;
      planModeActive = true;
      window.planModeActive = true;
      reflectToggleState();
      reflectModeBadge();
      renderPlanPane(currentPlan);
    } catch (err) {
      console.error("[plan] applyTemplate failed", err);
      alert("Couldn't apply template: " + (err.message || err));
    }
  }

  function renderPlanPaneEmptyHint() {
    const content = $("plan-content");
    if (!content) return;
    content.innerHTML =
      '<div class="plan-pane__empty">' +
      "<p>No plan yet.</p>" +
      '<p class="plan-pane__empty-hint">Plan mode is on — describe what you want to build in the chat. The assistant will ask clarifying questions and draft a plan here.</p>' +
      "</div>";
  }

  // ---- Plan pane rendering ----
  function renderPlanPane(markdown) {
    currentPlan = markdown || "";
    window.currentPlan = currentPlan;

    const content = $("plan-content");
    const editor = $("plan-editor");
    if (!content) return;

    if (editing) {
      // Don't clobber the editor while user is typing.
      return;
    }

    if (!currentPlan.trim()) {
      // Empty plan → show the template picker. Once a plan exists (after a
      // chat exchange or template apply), this is replaced by the rendered
      // markdown. The picker also acts as the "enable plan mode" CTA when
      // plan mode is off — picking any option turns it on.
      ensureTemplates();
      content.innerHTML = renderTemplatePicker();
      bindTemplatePicker(content);
    } else {
      content.innerHTML = renderMarkdown(currentPlan);
    }

    if (editor) editor.value = currentPlan;
  }

  function bindTemplatePicker(root) {
    if (!root) return;
    const buttons = root.querySelectorAll(".plan-template");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.templateId || "";
        // Visual feedback while the request is in flight.
        btn.classList.add("is-loading");
        applyTemplate(id);
      });
    });
  }

  // ---- Plan sidebar toggle ----
  function showPlanView() {
    const planPane = $("plan-pane");
    const toggleBtn = $("plan-sidebar-toggle");
    if (planPane) planPane.classList.remove("hidden");
    if (toggleBtn) toggleBtn.setAttribute("aria-pressed", "true");
  }

  function hidePlanView() {
    const planPane = $("plan-pane");
    const toggleBtn = $("plan-sidebar-toggle");
    if (planPane) planPane.classList.add("hidden");
    if (toggleBtn) toggleBtn.setAttribute("aria-pressed", "false");
  }

  function showPreviewView() {
    // No-op — preview is always visible now (plan is a sidebar).
  }

  function togglePlanSidebar() {
    const planPane = $("plan-pane");
    if (!planPane) return;
    if (planPane.classList.contains("hidden")) {
      showPlanView();
    } else {
      hidePlanView();
    }
  }

  function wirePlanSidebar() {
    const toggleBtn = $("plan-sidebar-toggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", togglePlanSidebar);
    }
    const closeBtn = $("plan-sidebar-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", hidePlanView);
    }

    // Plan sidebar resize handle
    const resizeHandle = $("plan-sidebar-resize");
    const planPane = $("plan-pane");
    if (resizeHandle && planPane) {
      let startX, startW;
      const onMouseMove = (e) => {
        const delta = startX - e.clientX;
        planPane.style.width = Math.max(260, Math.min(window.innerWidth * 0.5, startW + delta)) + "px";
      };
      const onMouseUp = () => {
        resizeHandle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = planPane.offsetWidth;
        resizeHandle.classList.add("dragging");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    }
  }

  // ---- Plan-mode toggle (chat input button) ----
  async function setPlanMode(active) {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planMode: !!active }),
      });
      if (!res.ok) throw new Error("Failed to update setting");
      planModeActive = !!active;
      window.planModeActive = planModeActive;
      reflectToggleState();
      reflectModeBadge();
      if (active) showPlanView();
    } catch (err) {
      console.error("[plan] setPlanMode failed", err);
    }
  }

  function reflectToggleState() {
    const btn = $("plan-mode-toggle");
    if (!btn) return;
    btn.classList.toggle("is-active", planModeActive);
    btn.setAttribute("aria-pressed", planModeActive ? "true" : "false");
    const state = btn.querySelector(".plan-toggle__state");
    if (state) state.textContent = planModeActive ? "On" : "Off";
    // Notify other UI (e.g. chat input placeholder) that plan-mode flipped.
    window.dispatchEvent(new CustomEvent("plan-mode-changed", { detail: { active: planModeActive } }));
  }

  function reflectModeBadge() {
    const ctx = $("chat-header-context");
    if (!ctx) return;
    const existing = ctx.querySelector(".plan-mode-badge");
    if (planModeActive && !existing) {
      const badge = document.createElement("span");
      badge.className = "plan-mode-badge";
      badge.textContent = "Plan mode";
      ctx.appendChild(badge);
    } else if (!planModeActive && existing) {
      existing.remove();
    }
  }

  // ---- Inline editor ----
  function enterEditMode() {
    editing = true;
    const content = $("plan-content");
    const editor = $("plan-editor");
    const editToggle = $("plan-edit-toggle");
    const saveBtn = $("plan-edit-save");
    const cancelBtn = $("plan-edit-cancel");
    const approveBtn = $("plan-approve-btn");
    if (!content || !editor) return;

    editor.value = currentPlan || "";
    content.classList.add("hidden");
    editor.classList.remove("hidden");
    if (editToggle) editToggle.classList.add("hidden");
    if (saveBtn) saveBtn.classList.remove("hidden");
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    if (approveBtn) approveBtn.classList.add("hidden");
    editor.focus();
  }

  function exitEditMode() {
    editing = false;
    const content = $("plan-content");
    const editor = $("plan-editor");
    const editToggle = $("plan-edit-toggle");
    const saveBtn = $("plan-edit-save");
    const cancelBtn = $("plan-edit-cancel");
    const approveBtn = $("plan-approve-btn");

    if (content) content.classList.remove("hidden");
    if (editor) editor.classList.add("hidden");
    if (editToggle) editToggle.classList.remove("hidden");
    if (saveBtn) saveBtn.classList.add("hidden");
    if (cancelBtn) cancelBtn.classList.add("hidden");
    if (approveBtn) approveBtn.classList.remove("hidden");
    renderPlanPane(currentPlan);
  }

  async function saveEdit() {
    const editor = $("plan-editor");
    if (!editor) return;
    const markdown = editor.value;
    if (!markdown.trim()) {
      alert("Plan cannot be empty.");
      return;
    }

    try {
      const res = await fetch("/api/plan/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentPlan = data.plan;
      window.currentPlan = currentPlan;
      exitEditMode();
    } catch (err) {
      console.error("[plan] saveEdit failed", err);
      alert("Failed to save plan: " + (err.message || err));
    }
  }

  // ---- Approve / Discard ----
  function approvePlan() {
    if (typeof ws === "undefined" || !ws || ws.readyState !== 1) {
      alert("Connection lost — please refresh.");
      return;
    }
    if (!currentPlan.trim()) {
      alert("There's no plan to approve yet. Send a chat message first.");
      return;
    }
    // Resolve the parked "plan" checkpoint — plan mode is unified onto the
    // checkpoint primitive (VIB-1880). Server flips planMode off + builds.
    // Only clear local UI state once the send actually went out — a throwing
    // send would otherwise leave the server still parked while the UI thinks
    // the plan was approved.
    try {
      ws.send(JSON.stringify({ type: "checkpoint_resolve", kind: "plan", action: "approve" }));
    } catch (err) {
      console.error("[plan] approve send failed", err);
      alert("Connection lost — please refresh and approve again.");
      return;
    }
    // Collapse plan sidebar so user watches modules generate.
    hidePlanView();
    // Local state will be refreshed by the next init or modules_updated event.
    planModeActive = false;
    window.planModeActive = false;
    reflectToggleState();
    reflectModeBadge();
  }

  function discardPlan() {
    if (!confirm("Discard the current plan and exit plan mode?")) return;
    if (typeof ws !== "undefined" && ws && ws.readyState === 1) {
      // Cancel the parked "plan" checkpoint (VIB-1880); falls back to plan_discard
      // semantics server-side. HTTP fallback below for a dropped socket.
      ws.send(JSON.stringify({ type: "checkpoint_resolve", kind: "plan", action: "cancel" }));
    } else {
      // Fallback to HTTP
      fetch("/api/plan/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }
    planModeActive = false;
    window.planModeActive = false;
    currentPlan = "";
    window.currentPlan = "";
    reflectToggleState();
    reflectModeBadge();
    renderPlanPane("");
  }

  // ---- Choice chips (rendered below assistant chat bubbles) ----
  function renderChoiceChips(question, options) {
    const messagesEl = document.getElementById("chat-messages");
    if (!messagesEl) return;
    // Append chips to the last assistant bubble.
    const bubbles = messagesEl.querySelectorAll(".message--assistant");
    const target = bubbles[bubbles.length - 1] || messagesEl;

    // Avoid stacking multiple chip groups on the same bubble.
    const existing = target.querySelector(".plan-choices");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.className = "plan-choices";

    if (question) {
      const label = document.createElement("div");
      label.className = "plan-choices__question";
      label.textContent = question;
      wrap.appendChild(label);
    }

    const chips = document.createElement("div");
    chips.className = "plan-choices__chips";
    wrap.appendChild(chips);

    const isOther = (val) => /^(other|something else|none of these)$/i.test(val.trim());

    options.forEach((opt) => {
      const chip = document.createElement("button");
      chip.className = "plan-choices__chip";
      if (isOther(opt)) chip.classList.add("plan-choices__chip--other");
      chip.type = "button";
      chip.textContent = opt;
      chip.addEventListener("click", () => {
        const input = document.getElementById("chat-input");
        if (!input) return;

        if (isOther(opt)) {
          // Don't auto-send — let the user type their own answer.
          // Clear and focus the input; leave chips enabled so they can
          // still pick a preset if they change their mind.
          input.value = "";
          input.placeholder = question
            ? `Your answer to: ${question}`
            : "Type your answer...";
          input.focus();
          chip.classList.add("is-selected");
          return;
        }

        wrap.classList.add("is-disabled");
        input.value = opt;
        const sendBtn = document.getElementById("chat-send");
        if (sendBtn) sendBtn.click();
      });
      chips.appendChild(chip);
    });
    target.appendChild(wrap);
  }

  // ---- Wire up event listeners ----
  function setup() {
    wirePlanSidebar();

    const toggle = $("plan-mode-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => setPlanMode(!planModeActive));
    }

    const editToggle = $("plan-edit-toggle");
    if (editToggle) editToggle.addEventListener("click", enterEditMode);

    const saveBtn = $("plan-edit-save");
    if (saveBtn) saveBtn.addEventListener("click", saveEdit);

    const cancelBtn = $("plan-edit-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", exitEditMode);

    const approveBtn = $("plan-approve-btn");
    if (approveBtn) approveBtn.addEventListener("click", approvePlan);

    const discardBtn = $("plan-discard-btn");
    if (discardBtn) discardBtn.addEventListener("click", discardPlan);
  }

  // ---- Public API (used by chat.js init handler and ws message dispatch) ----
  window.planController = {
    setInitialState(initMsg) {
      planModeActive = !!initMsg.planMode;
      currentPlan = initMsg.plan || "";
      window.planModeActive = planModeActive;
      window.currentPlan = currentPlan;
      reflectToggleState();
      reflectModeBadge();
      renderPlanPane(currentPlan);
      if (planModeActive && currentPlan) {
        // Auto-show plan view when there's a plan in progress.
        showPlanView();
      }
    },
    onPlanUpdated(markdown) {
      renderPlanPane(markdown || "");
      // If user is on Preview, gently switch to Plan when fresh content arrives.
      if (planModeActive) showPlanView();
    },
    onPlanDiscarded() {
      planModeActive = false;
      currentPlan = "";
      window.planModeActive = false;
      window.currentPlan = "";
      reflectToggleState();
      reflectModeBadge();
      renderPlanPane("");
    },
    renderChoices(question, options) {
      renderChoiceChips(question, options);
    },
    isActive() {
      return planModeActive;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
