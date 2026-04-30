/**
 * Section visual controls — hover-activated toolbar for module-level styling.
 * Shows color picker, padding/margin sliders, image swap, and font size controls
 * per module section. Persists changes via /api/field endpoint.
 */

(() => {
  const previewFrame = document.getElementById("preview-frame");
  const fieldCache = new Map();
  let activeToolbar = null;
  let activeModule = null;
  let activePopover = null;
  let hideTimer = null;
  let updateTimer = null;
  let interacting = false;

  previewFrame.addEventListener("load", () => {
    fieldCache.clear();
    activeToolbar = null;
    activeModule = null;
    activePopover = null;
    attachSectionControls();
  });

  function attachSectionControls() {
    let doc;
    try {
      doc = previewFrame.contentDocument || previewFrame.contentWindow?.document;
    } catch { return; }
    if (!doc || !doc.body) return;

    ensureStyles(doc);

    doc.addEventListener("mouseover", (e) => {
      if (typeof selectModeActive !== "undefined" && selectModeActive) return;
      if (interacting) return;

      const moduleEl = e.target.closest("[data-module]");
      if (!moduleEl) return;
      if (moduleEl === activeModule) {
        clearTimeout(hideTimer);
        return;
      }

      clearTimeout(hideTimer);
      showToolbar(doc, moduleEl);
    }, true);

    doc.addEventListener("mouseout", (e) => {
      if (!activeToolbar || interacting) return;
      const related = e.relatedTarget;
      if (related) {
        if (activeToolbar.contains(related)) return;
        if (activeModule && activeModule.contains(related)) return;
        if (activePopover && activePopover.contains(related)) return;
      }
      hideTimer = setTimeout(() => hideToolbar(doc), 250);
    }, true);

    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && activePopover) {
        closePopover(doc);
      }
    }, true);
  }

  async function showToolbar(doc, moduleEl) {
    hideToolbar(doc);

    const moduleName = moduleEl.getAttribute("data-module");
    if (!moduleName) return;

    activeModule = moduleEl;

    let fields = fieldCache.get(moduleName);
    if (!fields) {
      try {
        const res = await fetch("/api/modules");
        const data = await res.json();
        const mod = data.modules.find((m) => m.moduleName === moduleName);
        if (!mod) return;
        fields = JSON.parse(mod.fieldsJson);
        fieldCache.set(moduleName, fields);
      } catch {
        return;
      }
    }

    if (activeModule !== moduleEl) return;

    const controls = categorizeFields(fields);
    if (!controls.length) return;

    const toolbar = doc.createElement("div");
    toolbar.className = "vs-sc-toolbar";

    for (const ctrl of controls) {
      toolbar.appendChild(createControl(doc, ctrl, moduleName));
    }

    const computed = doc.defaultView.getComputedStyle(moduleEl);
    if (computed.position === "static") {
      moduleEl.style.position = "relative";
    }
    moduleEl.appendChild(toolbar);
    activeToolbar = toolbar;

    toolbar.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    toolbar.addEventListener("mouseleave", (e) => {
      if (interacting) return;
      if (activeModule && activeModule.contains(e.relatedTarget)) return;
      if (activePopover && activePopover.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(() => hideToolbar(doc), 250);
    });
  }

  function hideToolbar(doc) {
    if (interacting) return;
    closePopover(doc);
    if (activeToolbar && activeToolbar.parentNode) {
      activeToolbar.parentNode.removeChild(activeToolbar);
    }
    activeToolbar = null;
    activeModule = null;
  }

  function categorizeFields(fields, prefix) {
    const controls = [];

    for (const field of fields) {
      const path = prefix ? `${prefix}.${field.name}` : field.name;

      if (field.type === "group" && field.children) {
        controls.push(...categorizeFields(field.children, path));
        continue;
      }

      const n = field.name.toLowerCase();

      if (field.type === "color") {
        controls.push({ kind: "color", field, path, label: field.label || field.name });
      } else if (field.type === "image") {
        controls.push({ kind: "image", field, path, label: field.label || field.name });
      } else if (field.type === "number" && /padding|margin|spacing/i.test(n)) {
        controls.push({ kind: "spacing", field, path, label: field.label || field.name });
      } else if (field.type === "number" && /font.?size|text.?size/i.test(n)) {
        controls.push({ kind: "fontsize", field, path, label: field.label || field.name });
      }
    }

    return controls;
  }

  function createControl(doc, ctrl, moduleName) {
    const btn = doc.createElement("button");
    btn.className = "vs-sc-btn";
    btn.setAttribute("data-kind", ctrl.kind);
    btn.title = ctrl.label;

    switch (ctrl.kind) {
      case "color": {
        const swatch = doc.createElement("span");
        swatch.className = "vs-sc-swatch";
        swatch.style.background = ctrl.field.default?.color || "#888";
        btn.appendChild(swatch);
        const lbl = doc.createElement("span");
        lbl.className = "vs-sc-label";
        lbl.textContent = shortLabel(ctrl.label);
        btn.appendChild(lbl);
        break;
      }
      case "spacing": {
        btn.innerHTML =
          '<svg class="vs-sc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18M7 8l5-5 5 5M7 16l5 5 5-5"/></svg>' +
          `<span class="vs-sc-label">${ctrl.field.default ?? 0}px</span>`;
        break;
      }
      case "image": {
        btn.innerHTML =
          '<svg class="vs-sc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' +
          `<span class="vs-sc-label">${shortLabel(ctrl.label)}</span>`;
        break;
      }
      case "fontsize": {
        btn.innerHTML =
          '<span class="vs-sc-icon" style="font-weight:600;font-size:11px">Aa</span>' +
          `<span class="vs-sc-label">${ctrl.field.default ?? 16}px</span>`;
        break;
      }
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPopover(doc, btn, ctrl, moduleName);
    });

    return btn;
  }

  function shortLabel(label) {
    if (label.length <= 12) return label;
    return label.slice(0, 10) + "…";
  }

  // ---- Popovers ----

  function openPopover(doc, anchor, ctrl, moduleName) {
    closePopover(doc);
    interacting = true;

    const pop = doc.createElement("div");
    pop.className = "vs-sc-popover";

    switch (ctrl.kind) {
      case "color":
        buildColorPopover(doc, pop, anchor, ctrl, moduleName);
        break;
      case "spacing":
        buildSpacingPopover(doc, pop, anchor, ctrl, moduleName);
        break;
      case "image":
        buildImagePopover(doc, pop, anchor, ctrl, moduleName);
        break;
      case "fontsize":
        buildFontSizePopover(doc, pop, anchor, ctrl, moduleName);
        break;
    }

    const rect = anchor.getBoundingClientRect();
    pop.style.top = rect.bottom + 6 + "px";
    pop.style.left = Math.max(4, rect.left) + "px";
    doc.body.appendChild(pop);
    activePopover = pop;

    pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    pop.addEventListener("mouseleave", (e) => {
      if (activeToolbar && activeToolbar.contains(e.relatedTarget)) return;
      if (activeModule && activeModule.contains(e.relatedTarget)) return;
      closePopover(doc);
    });
  }

  function closePopover(doc) {
    if (activePopover && activePopover.parentNode) {
      activePopover.parentNode.removeChild(activePopover);
    }
    activePopover = null;
    if (interacting) {
      interacting = false;
      flushUpdate();
    }
  }

  function buildColorPopover(doc, pop, anchor, ctrl, moduleName) {
    const picker = doc.createElement("input");
    picker.type = "color";
    picker.className = "vs-sc-color-picker";
    picker.value = ctrl.field.default?.color || "#000000";

    const hex = doc.createElement("input");
    hex.type = "text";
    hex.className = "vs-sc-hex";
    hex.value = picker.value;

    const row = doc.createElement("div");
    row.className = "vs-sc-color-row";
    row.appendChild(picker);
    row.appendChild(hex);
    pop.appendChild(row);

    picker.addEventListener("input", () => {
      hex.value = picker.value;
      const swatch = anchor.querySelector(".vs-sc-swatch");
      if (swatch) swatch.style.background = picker.value;
      queueUpdate(moduleName, ctrl.path, {
        color: picker.value,
        opacity: ctrl.field.default?.opacity ?? 100,
      });
    });

    hex.addEventListener("change", () => {
      if (/^#[0-9a-f]{3,8}$/i.test(hex.value)) {
        picker.value = hex.value.length === 4
          ? "#" + hex.value[1] + hex.value[1] + hex.value[2] + hex.value[2] + hex.value[3] + hex.value[3]
          : hex.value;
        const swatch = anchor.querySelector(".vs-sc-swatch");
        if (swatch) swatch.style.background = hex.value;
        queueUpdate(moduleName, ctrl.path, {
          color: hex.value,
          opacity: ctrl.field.default?.opacity ?? 100,
        });
      }
    });
  }

  function buildSpacingPopover(doc, pop, anchor, ctrl, moduleName) {
    const lbl = doc.createElement("div");
    lbl.className = "vs-sc-pop-label";
    lbl.textContent = ctrl.label;

    const row = doc.createElement("div");
    row.className = "vs-sc-slider-row";

    const slider = doc.createElement("input");
    slider.type = "range";
    slider.className = "vs-sc-slider";
    slider.min = "0";
    slider.max = "120";
    slider.step = "1";
    slider.value = ctrl.field.default ?? 0;

    const val = doc.createElement("span");
    val.className = "vs-sc-slider-val";
    val.textContent = slider.value + "px";

    slider.addEventListener("input", () => {
      val.textContent = slider.value + "px";
      const btnLabel = anchor.querySelector(".vs-sc-label");
      if (btnLabel) btnLabel.textContent = slider.value + "px";
      queueUpdate(moduleName, ctrl.path, Number(slider.value));
    });

    row.appendChild(slider);
    row.appendChild(val);
    pop.appendChild(lbl);
    pop.appendChild(row);
  }

  function buildImagePopover(doc, pop, anchor, ctrl, moduleName) {
    const lbl = doc.createElement("div");
    lbl.className = "vs-sc-pop-label";
    lbl.textContent = ctrl.label;

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "vs-sc-url-input";
    input.placeholder = "Enter image URL…";
    input.value = ctrl.field.default?.src || "";

    const btn = doc.createElement("button");
    btn.className = "vs-sc-apply-btn";
    btn.textContent = "Apply";

    btn.addEventListener("click", () => {
      const src = input.value.trim();
      if (src) {
        queueUpdate(moduleName, ctrl.path, {
          src,
          alt: ctrl.field.default?.alt || "",
        });
        closePopover(doc);
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btn.click();
      }
      if (e.key === "Escape") closePopover(doc);
    });

    pop.appendChild(lbl);
    pop.appendChild(input);
    pop.appendChild(btn);
    input.focus();
  }

  function buildFontSizePopover(doc, pop, anchor, ctrl, moduleName) {
    const row = doc.createElement("div");
    row.className = "vs-sc-slider-row";

    const slider = doc.createElement("input");
    slider.type = "range";
    slider.className = "vs-sc-slider";
    slider.min = "8";
    slider.max = "96";
    slider.step = "1";
    slider.value = ctrl.field.default ?? 16;

    const val = doc.createElement("span");
    val.className = "vs-sc-slider-val";
    val.textContent = slider.value + "px";

    slider.addEventListener("input", () => {
      val.textContent = slider.value + "px";
      const btnLabel = anchor.querySelector(".vs-sc-label");
      if (btnLabel) btnLabel.textContent = slider.value + "px";
      queueUpdate(moduleName, ctrl.path, Number(slider.value));
    });

    row.appendChild(slider);
    row.appendChild(val);
    pop.appendChild(row);
  }

  // ---- Save helpers ----

  let pendingUpdate = null;

  function queueUpdate(moduleName, fieldPath, value) {
    pendingUpdate = { moduleName, fieldPath, value };
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => flushUpdate(), 300);
  }

  function flushUpdate() {
    clearTimeout(updateTimer);
    const upd = pendingUpdate;
    if (!upd) return;
    pendingUpdate = null;
    fieldCache.delete(upd.moduleName);

    fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleName: upd.moduleName,
        fieldPath: upd.fieldPath,
        value: upd.value,
      }),
    }).then(() => {
      if (!interacting) refreshPreview();
    });
  }

  // ---- Styles (injected into iframe) ----

  function ensureStyles(doc) {
    if (doc.getElementById("vs-section-controls-css")) return;
    const s = doc.createElement("style");
    s.id = "vs-section-controls-css";
    s.textContent = `
      .vs-sc-toolbar {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10000;
        display: flex;
        align-items: center;
        gap: 2px;
        background: rgba(15, 13, 12, 0.88);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        padding: 3px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        animation: vs-sc-fadein 0.15s ease;
        pointer-events: auto;
      }
      @keyframes vs-sc-fadein {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .vs-sc-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        background: transparent;
        border: none;
        border-radius: 5px;
        color: rgba(255, 255, 255, 0.8);
        font: 500 11px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s;
      }
      .vs-sc-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .vs-sc-swatch {
        display: inline-block;
        width: 14px;
        height: 14px;
        border-radius: 3px;
        border: 1px solid rgba(255, 255, 255, 0.25);
        flex-shrink: 0;
      }
      .vs-sc-icon {
        flex-shrink: 0;
        opacity: 0.7;
      }
      .vs-sc-label {
        max-width: 72px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Popover */
      .vs-sc-popover {
        position: fixed;
        z-index: 10001;
        background: rgba(15, 13, 12, 0.95);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        animation: vs-sc-fadein 0.12s ease;
        min-width: 180px;
      }
      .vs-sc-pop-label {
        font: 500 11px/1.4 -apple-system, sans-serif;
        color: rgba(255, 255, 255, 0.5);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      /* Color popover */
      .vs-sc-color-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .vs-sc-color-picker {
        width: 36px;
        height: 28px;
        border: none;
        border-radius: 4px;
        padding: 0;
        cursor: pointer;
        background: transparent;
      }
      .vs-sc-color-picker::-webkit-color-swatch-wrapper { padding: 0; }
      .vs-sc-color-picker::-webkit-color-swatch {
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 4px;
      }
      .vs-sc-color-picker::-moz-color-swatch {
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 4px;
      }
      .vs-sc-hex {
        flex: 1;
        font: 12px/1.4 -apple-system, sans-serif;
        padding: 4px 6px;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        background: rgba(0,0,0,0.3);
        color: #fff;
        outline: none;
        width: 80px;
      }
      .vs-sc-hex:focus { border-color: #e8613a; }

      /* Slider controls */
      .vs-sc-slider-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .vs-sc-slider {
        flex: 1;
        height: 4px;
        -webkit-appearance: none;
        appearance: none;
        background: rgba(255,255,255,0.15);
        border-radius: 2px;
        outline: none;
        cursor: pointer;
      }
      .vs-sc-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #e8613a;
        border: 2px solid #fff;
        cursor: pointer;
      }
      .vs-sc-slider::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #e8613a;
        border: 2px solid #fff;
        cursor: pointer;
      }
      .vs-sc-slider-val {
        font: 500 12px/1 -apple-system, sans-serif;
        color: rgba(255,255,255,0.7);
        min-width: 36px;
        text-align: right;
      }

      /* Image / URL input */
      .vs-sc-url-input {
        width: 100%;
        font: 12px/1.4 -apple-system, sans-serif;
        padding: 6px 8px;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 5px;
        background: rgba(0,0,0,0.3);
        color: #fff;
        outline: none;
        margin-bottom: 6px;
        box-sizing: border-box;
      }
      .vs-sc-url-input:focus { border-color: #e8613a; }
      .vs-sc-apply-btn {
        display: block;
        width: 100%;
        font: 500 12px/1 -apple-system, sans-serif;
        padding: 6px 12px;
        border: none;
        border-radius: 5px;
        background: #e8613a;
        color: #fff;
        cursor: pointer;
        transition: background 0.15s;
      }
      .vs-sc-apply-btn:hover { background: #d4522e; }

      @media (prefers-reduced-motion: reduce) {
        .vs-sc-toolbar, .vs-sc-popover { animation: none; }
      }
    `;
    doc.head.appendChild(s);
  }
})();
