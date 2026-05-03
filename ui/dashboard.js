/**
 * Dashboard screen — project overview with templates, module library, and brand assets.
 * Sits between setup (project list) and chat (template editing).
 */

const dashboardScreen = document.getElementById("editor");

// Page type labels for display
const PAGE_TYPE_LABELS = {
  landing_page: "LP",
  blog_post: "Blog",
  website_page: "Web",
  module_only: "Mod",
};

const PAGE_TYPE_FULL_LABELS = {
  landing_page: "Landing Page",
  blog_post: "Blog Post",
  website_page: "Website Page",
  module_only: "Module Only",
};

// ---------------------------------------------------------------------------
// Show / hide dashboard
// ---------------------------------------------------------------------------

let currentDashboardTheme = "";
let currentDashboardSessionId = "";
let currentDashboardIsImported = false;

async function showDashboard(themeName) {
  currentDashboardTheme = themeName;

  const ab = document.getElementById("app-body");
  if (ab) ab.dataset.mode = "editor";
  document.getElementById("project-rail")?.setAttribute("data-mode", "editor");
  dashboardScreen.classList.remove("hidden");

  document.getElementById("theme-name").textContent = themeName;
  if (typeof updateRailActive === "function") updateRailActive();

  // Get sessionId for the active theme
  try {
    const themesRes = await fetch("/api/themes");
    const themesData = await themesRes.json();
    currentDashboardSessionId = themesData.activeTheme?.id || "";
    currentDashboardIsImported = !!themesData.activeTheme?.isImported;
  } catch {
    currentDashboardSessionId = "";
    currentDashboardIsImported = false;
  }

  // Update URL
  const target = "#/dashboard/" + encodeURIComponent(themeName);
  if (location.hash !== target) {
    history.pushState(null, "", target);
  }

  // Load dashboard data
  await refreshDashboard();

  // Establish WebSocket so the page tree (populated via WS init message)
  // and chat input work immediately — without this, a browser refresh
  // leaves the page tree empty and the chat send button inert.
  if (typeof connectWebSocket === "function") {
    connectWebSocket();
  }
}

function hideDashboard() {
  currentDashboardTheme = "";
  currentDashboardIsImported = false;
  closeModulePreview();
}

// ---------------------------------------------------------------------------
// Load dashboard data from server
// ---------------------------------------------------------------------------

async function refreshDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    const data = await res.json();
    if (data.error) {
      console.warn("Dashboard load error:", data.error);
      return;
    }
    renderTemplateList(data.templates || []);
    renderProjectAssets(data.templates || []);
    renderModuleLibrary(data.moduleLibrary || []);
    renderBrandAssets(data.brandAssets || {});
    renderBrandKit(data.brandAssets?.brandKit || null);
    const pathEl = document.getElementById("dashboard-theme-path-text");
    if (data.themePath && pathEl) {
      pathEl.textContent = data.themePath;
    }
    if (currentDashboardIsImported) {
      await refreshInverseAnalysis();
    } else {
      hideInverseAnalysis();
    }
  } catch (err) {
    console.error("Failed to load dashboard:", err);
  }
}

// ---------------------------------------------------------------------------
// Import analysis
// ---------------------------------------------------------------------------

function hideInverseAnalysis() {
  const section = document.getElementById("dashboard-inverse-section");
  const summaryEl = document.getElementById("inverse-summary");
  const status = document.getElementById("inverse-status");
  const applyBtn = document.getElementById("btn-inverse-apply-tokens");
  section?.classList.add("hidden");
  if (summaryEl) summaryEl.innerHTML = "";
  if (status) status.textContent = "Analyzing theme...";
  if (applyBtn) applyBtn.classList.add("hidden");
}

async function refreshInverseAnalysis() {
  const section = document.getElementById("dashboard-inverse-section");
  const status = document.getElementById("inverse-status");
  const summaryEl = document.getElementById("inverse-summary");
  const applyBtn = document.getElementById("btn-inverse-apply-tokens");
  if (!section || !summaryEl) return;

  const capturedSessionId = currentDashboardSessionId;

  try {
    const res = await fetch("/api/inverse/analyze");
    if (currentDashboardSessionId !== capturedSessionId) return;
    const data = await res.json();
    if (!res.ok || data.error) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    renderInverseAnalysis(data.report);
  } catch (err) {
    console.warn("Import analysis failed:", err);
    section.classList.add("hidden");
  }
}

function renderInverseAnalysis(report) {
  const status = document.getElementById("inverse-status");
  const summaryEl = document.getElementById("inverse-summary");
  const applyBtn = document.getElementById("btn-inverse-apply-tokens");
  if (!report || !summaryEl) return;

  const counts = report.summary || {};
  const tokens = report.designTokens || {};
  const findings = report.findings || [];
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const errors = findings.filter((f) => f.severity === "error").length;
  const hasInferredTokens = (tokens.palette || []).length > 0;
  const hasCssVars = (counts.cssVarCount || 0) > 0;

  if (status) {
    if (errors > 0) status.textContent = `${errors} issue${errors === 1 ? "" : "s"} need attention`;
    else if (warnings > 0) status.textContent = `${warnings} warning${warnings === 1 ? "" : "s"}`;
    else status.textContent = "No blocking risks found";
  }

  if (applyBtn) {
    applyBtn.classList.toggle("hidden", hasCssVars || !hasInferredTokens);
    applyBtn.disabled = false;
    applyBtn.textContent = "Apply Tokens";
  }

  const stats = [
    ["Modules (disk)", counts.moduleCount || 0],
    ["Templates (disk)", counts.templateCount || 0],
    ["Orphans", counts.orphanCount || 0],
    ["Palette", counts.paletteSize || 0],
    ["CSS Vars", counts.cssVarCount || 0],
    ["Macros", counts.customMacroCount || 0],
  ];

  let html = `<div class="inverse-summary__stats">`;
  for (const [label, value] of stats) {
    html += `
      <div class="inverse-stat">
        <span class="inverse-stat__value">${esc(String(value))}</span>
        <span class="inverse-stat__label">${esc(label)}</span>
      </div>
    `;
  }
  html += `</div>`;

  if ((tokens.palette || []).length > 0) {
    html += `<div class="inverse-block"><div class="inverse-block__label">Palette</div><div class="inverse-swatches">`;
    for (const color of tokens.palette.slice(0, 8)) {
      const label = color.varName ? `${color.value} (${color.varName})` : color.value;
      html += `<span class="inverse-swatch" style="background:${inverseCssColor(color.value)}" title="${inverseEscAttr(label)}"></span>`;
    }
    html += `</div></div>`;
  }

  if ((tokens.fontFamilies || []).length > 0) {
    html += `<div class="inverse-block"><div class="inverse-block__label">Typography</div><div class="inverse-tags">`;
    for (const font of tokens.fontFamilies.slice(0, 4)) {
      html += `<span class="inverse-tag">${esc(font)}</span>`;
    }
    html += `</div></div>`;
  }

  html += renderInverseFindings(findings);
  summaryEl.innerHTML = html;
}

function renderInverseFindings(findings) {
  if (!findings || findings.length === 0) {
    return `<div class="inverse-findings inverse-findings--empty">No findings. This imported theme looks straightforward to edit.</div>`;
  }

  const severityOrder = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
  const visible = sorted.slice(0, 5);
  let html = `<div class="inverse-findings">`;
  for (const finding of visible) {
    const severity = ["error", "warning", "info"].includes(finding.severity) ? finding.severity : "info";
    const fixAttr = finding.fix ? ` title="${inverseEscAttr(finding.fix)}"` : "";
    html += `
      <div class="inverse-finding inverse-finding--${severity}">
        <span class="inverse-finding__severity">${esc(severity)}</span>
        <span class="inverse-finding__message"${fixAttr}>${esc(finding.message)}</span>
      </div>
    `;
  }
  if (findings.length > visible.length) {
    html += `<div class="inverse-findings__more">${findings.length - visible.length} more finding${findings.length - visible.length === 1 ? "" : "s"} available in the CLI report.</div>`;
  }
  html += `</div>`;
  return html;
}

function inverseEscAttr(value) {
  return esc(String(value)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inverseCssColor(value) {
  const color = String(value || "").trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^rgba?\([0-9.,%\s]+\)$/.test(color)) return color;
  if (/^hsla?\([0-9.,%\sdegturnrad+-]+\)$/.test(color)) return color;
  return "transparent";
}

document.getElementById("btn-inverse-apply-tokens")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-inverse-apply-tokens");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "Applying...";
  try {
    const res = await fetch("/api/inverse/apply-tokens", { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.error) {
      await vibeAlert(data.error || "Failed to apply tokens.", "Error");
      btn.disabled = false;
      btn.textContent = "Apply Tokens";
      return;
    }
    if (!data.applied) {
      await vibeAlert(data.reason || "No tokens were applied.", "Info");
    }
    await refreshInverseAnalysis();
  } catch (err) {
    await vibeAlert("Failed to apply tokens: " + err.message, "Error");
    btn.disabled = false;
    btn.textContent = "Apply Tokens";
  }
});

// ---------------------------------------------------------------------------
// Template list
// ---------------------------------------------------------------------------

function renderTemplateList(templates) {
  const list = document.getElementById("dashboard-template-list");
  const countEl = document.getElementById("dashboard-template-count");
  if (!list) return;
  if (countEl) countEl.textContent = templates.length;

  if (templates.length === 0) {
    list.innerHTML = `<p class="dashboard__empty-state">No templates yet. Choose a page type above to get started.</p>`;
    return;
  }

  list.innerHTML = "";
  for (const tpl of templates) {
    const item = document.createElement("div");
    item.className = "dashboard__template-item";
    item.innerHTML = `
      <span class="dashboard__template-badge dashboard__template-badge--${tpl.pageType}">${esc(PAGE_TYPE_LABELS[tpl.pageType] || "?")}</span>
      <span class="dashboard__template-label">${esc(tpl.label)}</span>
      <span class="dashboard__template-meta">${tpl.moduleCount} module${tpl.moduleCount !== 1 ? "s" : ""}</span>
      <button class="btn btn--sm btn--primary dashboard__template-open" data-id="${esc(tpl.id)}">Open</button>
      <button class="dashboard__template-clone" data-id="${esc(tpl.id)}" title="Clone template">&#x29C9;</button>
      <button class="dashboard__template-delete" data-id="${esc(tpl.id)}" title="Delete template">&times;</button>
    `;
    list.appendChild(item);
  }

  // Event delegation — single listener handles all template actions
  list.onclick = (e) => {
    const openBtn = e.target.closest(".dashboard__template-open");
    if (openBtn) return openTemplate(openBtn.dataset.id);
    const cloneBtn = e.target.closest(".dashboard__template-clone");
    if (cloneBtn) return cloneTemplateAction(cloneBtn.dataset.id);
    const delBtn = e.target.closest(".dashboard__template-delete");
    if (delBtn) return confirmDeleteTemplate(delBtn.dataset.id);
  };
  list.ondblclick = (e) => {
    const labelEl = e.target.closest(".dashboard__template-label");
    if (!labelEl) return;
    const item = labelEl.closest(".dashboard__template-item");
    const templateId = item?.querySelector(".dashboard__template-open")?.dataset.id;
    if (templateId) startTemplateRename(labelEl, templateId);
  };
}

function startTemplateRename(labelEl, templateId) {
  if (labelEl.contentEditable === "true") return;

  const oldLabel = labelEl.textContent.trim();
  labelEl.contentEditable = "true";
  labelEl.classList.add("dashboard__template-label--editing");
  labelEl.focus();

  const range = document.createRange();
  range.selectNodeContents(labelEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function commit() {
    labelEl.contentEditable = "false";
    labelEl.classList.remove("dashboard__template-label--editing");

    const newLabel = labelEl.textContent.trim();
    if (!newLabel || newLabel === oldLabel) {
      labelEl.textContent = oldLabel;
      return;
    }

    fetch("/api/templates/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, newLabel }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          labelEl.textContent = data.newLabel;
        } else {
          labelEl.textContent = oldLabel;
          if (typeof showError === "function") showError(data.error || "Rename failed");
        }
      })
      .catch(() => {
        labelEl.textContent = oldLabel;
        if (typeof showError === "function") showError("Rename failed");
      });
  }

  labelEl.addEventListener("blur", commit, { once: true });
  labelEl.addEventListener("keydown", function handler(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      labelEl.removeEventListener("keydown", handler);
      labelEl.blur();
    }
    if (e.key === "Escape") {
      labelEl.textContent = oldLabel;
      labelEl.removeEventListener("keydown", handler);
      labelEl.blur();
    }
  });
}

// ---------------------------------------------------------------------------
// Project assets (Library tab)
// ---------------------------------------------------------------------------

const ASSET_TYPE_LABELS = {
  landing_page: "Landing Page",
  blog_post: "Blog Post",
  website_page: "Website Page",
  module_only: "Module Only",
  email: "Email",
};

function renderProjectAssets(templates) {
  const container = document.getElementById("library-assets-list");
  if (!container) return;

  if (!templates || templates.length === 0) {
    container.innerHTML = `<p class="dashboard__empty-state">Assets will appear here as you create pages and emails.</p>`;
    return;
  }

  const pages = templates.filter((t) => t.pageType !== "email");
  const emails = templates.filter((t) => t.pageType === "email");

  let html = "";

  if (pages.length > 0) {
    html += `<div class="library-assets__group">`;
    html += `<h3 class="library-assets__group-title">Pages <span class="library-assets__count">${pages.length}</span></h3>`;
    for (const tpl of pages) {
      html += renderAssetCard(tpl);
    }
    html += `</div>`;
  }

  if (emails.length > 0) {
    html += `<div class="library-assets__group">`;
    html += `<h3 class="library-assets__group-title">Emails <span class="library-assets__count">${emails.length}</span></h3>`;
    for (const tpl of emails) {
      html += renderAssetCard(tpl);
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  container.onclick = (e) => {
    const card = e.target.closest(".library-asset-card");
    if (!card) return;
    const templateId = card.dataset.id;
    if (templateId) openTemplate(templateId);
  };
}

function renderAssetCard(tpl) {
  const typeLabel = ASSET_TYPE_LABELS[tpl.pageType] || tpl.pageType;
  return `
    <div class="library-asset-card" data-id="${esc(tpl.id)}" role="button" tabindex="0">
      <span class="dashboard__template-badge dashboard__template-badge--${esc(tpl.pageType)}">${esc(PAGE_TYPE_LABELS[tpl.pageType] || typeLabel)}</span>
      <span class="library-asset-card__label">${esc(tpl.label)}</span>
      <span class="library-asset-card__meta">${tpl.moduleCount} module${tpl.moduleCount !== 1 ? "s" : ""}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Module library
// ---------------------------------------------------------------------------

let activePreviewModule = "";

function renderModuleLibrary(modules) {
  const container = document.getElementById("dashboard-module-library");
  if (!container) return;

  if (modules.length === 0) {
    container.innerHTML = `<p class="dashboard__empty-state">Modules will appear here as you build pages.</p>`;
    closeModulePreview();
    return;
  }

  container.innerHTML = "";
  for (const mod of modules) {
    const chip = document.createElement("span");
    chip.className = "dashboard__module-chip";
    if (mod.moduleName === activePreviewModule) chip.classList.add("dashboard__module-chip--active");
    chip.textContent = mod.moduleName;
    chip.title = `Used in: ${mod.usedIn.join(", ")}`;
    chip.dataset.module = mod.moduleName;
    chip.dataset.usedIn = mod.usedIn.join(", ");
    chip.addEventListener("click", () => toggleModulePreview(mod.moduleName, mod.usedIn));
    container.appendChild(chip);
  }
}

function toggleModulePreview(moduleName, usedIn) {
  if (activePreviewModule === moduleName) {
    closeModulePreview();
    return;
  }
  showModulePreview(moduleName, usedIn);
}

async function showModulePreview(moduleName, usedIn) {
  const previewEl = document.getElementById("dashboard-module-preview");
  const nameEl = document.getElementById("dashboard-preview-name");
  const usedEl = document.getElementById("dashboard-preview-used");
  const frame = document.getElementById("dashboard-preview-frame");

  activePreviewModule = moduleName;

  // Update active chip styling
  document.querySelectorAll(".dashboard__module-chip").forEach((c) => {
    c.classList.toggle("dashboard__module-chip--active", c.dataset.module === moduleName);
  });

  nameEl.textContent = moduleName;
  usedEl.textContent = usedIn ? `Used in: ${usedIn.join(", ")}` : "";
  previewEl.classList.remove("hidden");

  // Load preview into iframe
  try {
    const res = await fetch(`/module-preview?module=${encodeURIComponent(moduleName)}`);
    const html = await res.text();
    frame.srcdoc = html;
  } catch {
    frame.srcdoc = "<p style='padding:2rem;color:#888;font-family:sans-serif'>Preview unavailable</p>";
  }
}

function closeModulePreview() {
  activePreviewModule = "";
  const previewEl = document.getElementById("dashboard-module-preview");
  if (previewEl) previewEl.classList.add("hidden");
  document.querySelectorAll(".dashboard__module-chip").forEach((c) => {
    c.classList.remove("dashboard__module-chip--active");
  });
}

// Close button for module preview
document.getElementById("dashboard-preview-close")?.addEventListener("click", closeModulePreview);

// Delete button for module preview
document.getElementById("dashboard-preview-delete")?.addEventListener("click", async () => {
  const moduleName = activePreviewModule;
  if (!moduleName) return;

  const ok = await vibeConfirm(
    `Delete module "${moduleName}"?`,
    "This will remove it from all templates and delete it from disk.",
    { confirmLabel: "Delete" }
  );
  if (!ok) return;

  try {
    await fetch("/api/modules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleName, deleteEntirely: true }),
    });
    closeModulePreview();
    await refreshDashboard();
  } catch (err) {
    await vibeAlert("Failed to delete module: " + err.message, "Error");
  }
});

// ---------------------------------------------------------------------------
// Brand assets
// ---------------------------------------------------------------------------

const ASSET_LABELS = { styleguide: "Styleguide", brandvoice: "Brand Voice", themeContext: "Product Context" };
const ASSET_FILES = { styleguide: "styleguide.md", brandvoice: "brandvoice.md", themeContext: "theme-context.md" };
const ASSET_FLAGS = { styleguide: "hasStyleguide", brandvoice: "hasBrandvoice", themeContext: "hasThemeContext" };

function renderBrandAssets(assets) {
  for (const [type, flagKey] of Object.entries(ASSET_FLAGS)) {
    const card = document.querySelector(`.brand-asset-card[data-asset="${type}"]`);
    if (!card) continue;
    const icon = card.querySelector(".brand-asset-card__icon");
    const hasAsset = !!assets[flagKey];

    if (hasAsset) {
      icon.textContent = "\u2713";
      icon.classList.add("brand-asset-card__icon--done");
    } else {
      icon.textContent = "+";
      icon.classList.remove("brand-asset-card__icon--done");
    }

    // Toggle which action set is visible on hover
    const actions = card.querySelector(".brand-asset-card__actions");
    const manage = card.querySelector(".brand-asset-card__manage");
    if (actions) actions.classList.toggle("hidden", hasAsset);
    if (manage) manage.classList.toggle("hidden", !hasAsset);
  }

  // Humanify toggle
  const humanifyCheckbox = document.getElementById("humanify-checkbox");
  if (humanifyCheckbox) {
    humanifyCheckbox.checked = assets.humanify !== false;
  }
}

async function viewBrandAsset(type) {
  try {
    const res = await fetch("/api/brand-assets");
    const data = await res.json();
    const content = data[type];
    if (content) {
      await vibeViewContent(content, ASSET_LABELS[type], ASSET_FILES[type]);
    } else {
      await vibeAlert(`No ${ASSET_LABELS[type].toLowerCase()} found.`, "Info");
    }
  } catch (err) {
    await vibeAlert(`Failed to load: ${err.message}`, "Error");
  }
}

async function deleteBrandAsset(type) {
  const label = ASSET_LABELS[type] || type;
  const ok = await vibeConfirm(`Remove ${label.toLowerCase()}?`, "This will delete the file from disk.", { confirmLabel: "Remove", confirmClass: "btn--danger" });
  if (!ok) return;
  try {
    const res = await fetch("/api/brand-assets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const data = await res.json();
    if (data.ok) showDashboard(currentDashboardTheme);
    else await vibeAlert(data.error || "Failed to remove", "Error");
  } catch (err) {
    await vibeAlert("Failed to remove: " + err.message, "Error");
  }
}

async function extractBrandAsset(type, card) {
  const labelEl = card.querySelector(".brand-asset-card__label");
  const origLabel = labelEl?.textContent;
  if (labelEl) labelEl.textContent = "Extracting...";
  card.classList.add("brand-asset-card--extracting");
  try {
    const res = await fetch("/api/brand-assets/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const data = await res.json();
    if (data.ok && data.content) {
      await refreshDashboard();
      const view = await vibeConfirm(
        `${ASSET_LABELS[type]} extracted.`,
        "Would you like to view it?",
        { confirmLabel: "View", confirmClass: "btn--primary" },
      );
      if (view) await vibeViewContent(data.content, ASSET_LABELS[type], ASSET_FILES[type]);
    } else {
      await vibeAlert(data.error || "Nothing to extract — generate some modules first.", "Info");
    }
  } catch (err) {
    await vibeAlert("Extraction failed: " + err.message, "Error");
  } finally {
    card.classList.remove("brand-asset-card--extracting");
    if (labelEl) labelEl.textContent = origLabel;
  }
}

// Event delegation for brand asset cards
document.getElementById("dashboard-brand-assets")?.addEventListener("click", (e) => {
  const card = e.target.closest(".brand-asset-card");
  if (!card) return;
  const type = card.dataset.asset;
  if (!type) return;

  const action = e.target.closest("[data-action]")?.dataset?.action;
  if (action === "view") { viewBrandAsset(type); return; }
  if (action === "delete") { deleteBrandAsset(type); return; }
  if (action === "extract") { extractBrandAsset(type, card); return; }
});

// File upload via label inside cards
document.getElementById("dashboard-brand-assets")?.addEventListener("change", (e) => {
  if (e.target.type !== "file") return;
  const card = e.target.closest(".brand-asset-card");
  if (!card || !e.target.files[0]) return;
  handleBrandFileSelected(card.dataset.asset, e.target.files[0]);
});

// ---------------------------------------------------------------------------
// Brand kit
// ---------------------------------------------------------------------------

function renderBrandKit(brandKit) {
  const fields = {
    primary: { color: "bk-color-primary", hex: "bk-hex-primary" },
    secondary: { color: "bk-color-secondary", hex: "bk-hex-secondary" },
    accent: { color: "bk-color-accent", hex: "bk-hex-accent" },
  };

  for (const [key, ids] of Object.entries(fields)) {
    const colorInput = document.getElementById(ids.color);
    const hexInput = document.getElementById(ids.hex);
    const val = brandKit?.colors?.[key] || "";
    if (colorInput) colorInput.value = val || colorInput.value;
    if (hexInput) hexInput.value = val;
  }

  const headingInput = document.getElementById("bk-font-heading");
  const bodyInput = document.getElementById("bk-font-body");
  const logoInput = document.getElementById("bk-logo-url");
  if (headingInput) headingInput.value = brandKit?.fonts?.heading || "";
  if (bodyInput) bodyInput.value = brandKit?.fonts?.body || "";
  if (logoInput) logoInput.value = brandKit?.logoUrl || "";

  updateBrandPreview();
}

function updateBrandPreview() {
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  const swatchKeys = ["primary", "secondary", "accent"];
  for (const key of swatchKeys) {
    const swatch = document.getElementById(`brand-preview-swatch-${key}`);
    const hex = document.getElementById(`bk-hex-${key}`)?.value?.trim();
    if (!swatch) continue;
    if (hex && hexRe.test(hex)) {
      swatch.style.background = hex;
      swatch.dataset.empty = "false";
      swatch.title = `${key.charAt(0).toUpperCase() + key.slice(1)} ${hex}`;
    } else {
      swatch.style.background = "";
      swatch.dataset.empty = "true";
      swatch.title = `${key.charAt(0).toUpperCase() + key.slice(1)} (not set)`;
    }
  }

  const headingFont = document.getElementById("bk-font-heading")?.value?.trim();
  const bodyFont = document.getElementById("bk-font-body")?.value?.trim();
  const headingPreview = document.getElementById("brand-preview-heading");
  const bodyPreview = document.getElementById("brand-preview-body");
  if (headingPreview) headingPreview.style.fontFamily = headingFont || "Georgia, serif";
  if (bodyPreview) bodyPreview.style.fontFamily = bodyFont || "Arial, Helvetica, sans-serif";

  const logoUrl = document.getElementById("bk-logo-url")?.value?.trim();
  const logoImg = document.getElementById("brand-preview-logo");
  const logoPlaceholder = document.getElementById("brand-preview-logo-placeholder");
  if (logoImg && logoPlaceholder) {
    if (logoUrl) {
      logoImg.src = logoUrl;
      logoImg.hidden = false;
      logoPlaceholder.hidden = true;
      logoImg.onerror = () => {
        logoImg.hidden = true;
        logoPlaceholder.hidden = false;
        logoPlaceholder.textContent = "Bad URL";
      };
      logoImg.onload = () => {
        logoPlaceholder.textContent = "No logo";
      };
    } else {
      logoImg.hidden = true;
      logoImg.removeAttribute("src");
      logoPlaceholder.hidden = false;
      logoPlaceholder.textContent = "No logo";
    }
  }
}

for (const id of [
  "bk-hex-primary", "bk-hex-secondary", "bk-hex-accent",
  "bk-color-primary", "bk-color-secondary", "bk-color-accent",
  "bk-font-heading", "bk-font-body", "bk-logo-url",
]) {
  document.getElementById(id)?.addEventListener("input", updateBrandPreview);
}

document.addEventListener("DOMContentLoaded", () => updateBrandPreview());

function collectBrandKit() {
  const kit = {};
  const primary = document.getElementById("bk-hex-primary")?.value?.trim();
  const secondary = document.getElementById("bk-hex-secondary")?.value?.trim();
  const accent = document.getElementById("bk-hex-accent")?.value?.trim();
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  const colors = {};
  if (primary && hexRe.test(primary)) colors.primary = primary;
  if (secondary && hexRe.test(secondary)) colors.secondary = secondary;
  if (accent && hexRe.test(accent)) colors.accent = accent;
  if (Object.keys(colors).length > 0) kit.colors = colors;

  const heading = document.getElementById("bk-font-heading")?.value?.trim();
  const body = document.getElementById("bk-font-body")?.value?.trim();
  const fonts = {};
  if (heading) fonts.heading = heading;
  if (body) fonts.body = body;
  if (Object.keys(fonts).length > 0) kit.fonts = fonts;

  const logo = document.getElementById("bk-logo-url")?.value?.trim();
  if (logo) kit.logoUrl = logo;

  return kit;
}

// Sync color picker ↔ hex input
for (const key of ["primary", "secondary", "accent"]) {
  const colorInput = document.getElementById(`bk-color-${key}`);
  const hexInput = document.getElementById(`bk-hex-${key}`);
  if (colorInput && hexInput) {
    colorInput.addEventListener("input", () => { hexInput.value = colorInput.value; });
    hexInput.addEventListener("input", () => {
      if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) colorInput.value = hexInput.value;
    });
  }
}

document.getElementById("bk-save")?.addEventListener("click", async () => {
  const kit = collectBrandKit();
  if (Object.keys(kit).length === 0) {
    await vibeAlert("Please fill in at least one field.", "Info");
    return;
  }
  try {
    const res = await fetch("/api/brand-kit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kit),
    });
    const data = await res.json();
    if (data.ok) {
      await vibeAlert("Brand kit saved.", "Success");
    } else {
      await vibeAlert(data.error || "Failed to save brand kit.", "Error");
    }
  } catch (err) {
    await vibeAlert("Failed to save: " + err.message, "Error");
  }
});

document.getElementById("bk-clear")?.addEventListener("click", async () => {
  const ok = await vibeConfirm("Clear brand kit?", "This will remove all brand kit settings.", { confirmLabel: "Clear", confirmClass: "btn--danger" });
  if (!ok) return;
  try {
    await fetch("/api/brand-kit", { method: "DELETE" });
    renderBrandKit(null);
  } catch (err) {
    await vibeAlert("Failed to clear: " + err.message, "Error");
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createTemplateFromPageType(pageType) {
  const defaultLabels = {
    landing_page: "Landing Page",
    blog_post: "Blog Post",
    website_page: "Website Page",
    module_only: "Module",
  };

  const label = await vibePrompt("Template name", defaultLabels[pageType] || "New Template");
  if (!label) return;

  try {
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageType, label }),
    });
    const data = await res.json();
    if (data.error) {
      await vibeAlert(data.error, "Error");
      return;
    }

    // Open the newly created template in chat
    openTemplate(data.template.id);
  } catch (err) {
    await vibeAlert("Failed to create template: " + err.message, "Error");
  }
}

async function openTemplate(templateId) {
  try {
    // Activate the template on the server
    const res = await fetch("/api/templates/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    const data = await res.json();
    if (data.error) {
      await vibeAlert(data.error, "Error");
      return;
    }

    // Transition to chat screen
    showChat(currentDashboardTheme, templateId);
  } catch (err) {
    await vibeAlert("Failed to open template: " + err.message, "Error");
  }
}

async function confirmDeleteTemplate(templateId) {
  const result = await vibeDeleteTemplateDialog();
  if (!result) return; // cancelled

  const deleteModules = result === "with_modules";

  try {
    await fetch("/api/templates", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, deleteModules }),
    });
    await refreshDashboard();
  } catch (err) {
    await vibeAlert("Failed to delete: " + err.message, "Error");
  }
}

/**
 * Three-option dialog: delete template only, delete template + modules, or cancel.
 * @returns {Promise<"template_only"|"with_modules"|null>}
 */
function vibeDeleteTemplateDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">Delete template?</div>
        <p class="confirm-dialog__warn">This cannot be undone.</p>
        <div class="confirm-dialog__actions" style="flex-direction:column;gap:8px">
          <button class="btn btn--danger" data-action="with_modules" style="width:100%">Delete template and its modules</button>
          <button class="btn btn--secondary" data-action="template_only" style="width:100%">Delete template only (keep modules)</button>
          <button class="btn btn--secondary" data-action="cancel" style="width:100%">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('[data-action="with_modules"]').addEventListener("click", () => close("with_modules"));
    overlay.querySelector('[data-action="template_only"]').addEventListener("click", () => close("template_only"));
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
  });
}

async function cloneTemplateAction(templateId) {
  const label = prompt("Name for the cloned template:");
  if (!label) return;

  try {
    const res = await fetch("/api/templates/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, label }),
    });
    const data = await res.json();
    if (!data.ok) {
      await vibeAlert(data.error || "Clone failed", "Error");
      return;
    }
    await refreshDashboard();
  } catch (err) {
    await vibeAlert("Failed to clone: " + err.message, "Error");
  }
}

async function uploadBrandAsset(type) {
  const uploadEl = document.getElementById(`brand-upload-${type}`);
  const fileInput = uploadEl.querySelector("input[type=file]");

  // Trigger file picker
  fileInput.click();
}

async function handleBrandFileSelected(type, file) {
  const content = await file.text();

  try {
    const res = await fetch("/api/brand-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, content }),
    });
    const data = await res.json();
    if (data.error) {
      await vibeAlert(data.error, "Error");
      return;
    }
    refreshDashboard();
  } catch (err) {
    await vibeAlert("Failed to upload: " + err.message, "Error");
  }
}

// ---------------------------------------------------------------------------
// Chat screen transition
// ---------------------------------------------------------------------------

function showChat(themeName, templateId) {
  const ab = document.getElementById("app-body");
  if (ab) ab.dataset.mode = "editor";
  dashboardScreen.classList.remove("hidden");
  document.getElementById("theme-name").textContent = themeName;

  // Update URL
  const target = `#/app/${encodeURIComponent(themeName)}/${encodeURIComponent(templateId)}`;
  if (location.hash !== target) {
    history.pushState(null, "", target);
  }

  // Connect WebSocket (defined in chat.js)
  if (typeof connectWebSocket === "function") {
    connectWebSocket();
  }

  // Load initial preview
  if (typeof refreshPreview === "function") {
    refreshPreview();
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Page type cards
document.querySelectorAll(".page-type-card").forEach((card) => {
  card.addEventListener("click", () => {
    createTemplateFromPageType(card.dataset.type);
  });
});

// Deploy button (topbar)
document.getElementById("btn-upload")?.addEventListener("click", () => {
  if (typeof startUpload === "function") {
    startUpload();
  }
});

// Extract All button
document.getElementById("btn-extract-all")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-extract-all");
  const origText = btn.textContent;
  btn.textContent = "Extracting...";
  btn.disabled = true;

  // Mark all cards as extracting
  const cards = document.querySelectorAll(".brand-asset-card");
  const savedLabels = new Map();
  cards.forEach((card) => {
    const labelEl = card.querySelector(".brand-asset-card__label");
    if (labelEl) {
      savedLabels.set(card, labelEl.textContent);
      labelEl.textContent = "Extracting...";
    }
    card.classList.add("brand-asset-card--extracting");
  });

  try {
    const res = await fetch("/api/brand-assets/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "all" }),
    });
    const data = await res.json();
    if (data.ok) {
      await refreshDashboard();
      const extracted = data.extracted || {};
      const names = Object.entries(extracted)
        .filter(([, v]) => v)
        .map(([k]) => ASSET_LABELS[k] || k);
      if (names.length > 0) {
        await vibeAlert(`Extracted: ${names.join(", ")}`, "Done");
      } else {
        await vibeAlert("Nothing to extract \u2014 generate some modules first.", "Info");
      }
    } else {
      await vibeAlert(data.error || "Extraction failed", "Error");
    }
  } catch (err) {
    await vibeAlert("Extraction failed: " + err.message, "Error");
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
    cards.forEach((card) => {
      card.classList.remove("brand-asset-card--extracting");
      const labelEl = card.querySelector(".brand-asset-card__label");
      if (labelEl && savedLabels.has(card)) labelEl.textContent = savedLabels.get(card);
    });
  }
});

// Import design reference from another theme
document.getElementById("btn-import-reference")?.addEventListener("click", async () => {
  const input = await vibePrompt(
    "Import design from another theme",
    "",
    "HubSpot theme name or local path (e.g. ~/vibespot-themes/my-theme)"
  );
  if (!input) return;

  // Detect source: if it looks like a path (contains / or ~), treat as local
  const isLocal = input.includes("/") || input.startsWith("~");
  const body = isLocal
    ? { source: "local", localPath: input }
    : { source: "hubspot", themeName: input };

  const btn = document.getElementById("btn-import-reference");
  const origText = btn.textContent;
  btn.textContent = "Importing...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/brand-assets/import-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      await refreshDashboard();
      const view = await vibeConfirm("Design imported and saved as styleguide.", "Would you like to view it?", { confirmLabel: "View Styleguide", confirmClass: "btn--primary" });
      if (view && data.styleguide) {
        await vibeViewContent(data.styleguide, "Styleguide", "styleguide.md");
      }
    } else {
      await vibeAlert(data.error || "Import failed", "Error");
    }
  } catch (err) {
    await vibeAlert("Import failed: " + err.message, "Error");
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
});

// Theme name pill — double-click to rename
document.getElementById("theme-name")?.addEventListener("dblclick", () => {
  const el = document.getElementById("theme-name");
  if (!el || !currentDashboardSessionId) return;
  if (el.contentEditable === "true") return;

  const oldName = el.textContent.trim();
  el.contentEditable = "true";
  el.classList.add("dashboard__theme-heading--editing");
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function commit() {
    el.contentEditable = "false";
    el.classList.remove("dashboard__theme-heading--editing");

    const newName = el.textContent.trim();
    if (!newName || newName === oldName) {
      el.textContent = oldName;
      return;
    }

    fetch("/api/themes/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentDashboardSessionId, newName }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          el.textContent = data.newName;
          currentDashboardTheme = data.newName;
          document.getElementById("theme-name").textContent = data.newName;
          window.location.hash = "#/dashboard/" + encodeURIComponent(data.newName);
          // Update rail
          const railItem = document.querySelector(`.project-rail__item[data-name="${oldName}"]`);
          if (railItem) {
            railItem.dataset.name = data.newName;
            const nameSpan = railItem.querySelector(".project-rail__item-name");
            if (nameSpan) nameSpan.textContent = data.newName;
            const bubble = railItem.querySelector(".project-rail__item-bubble");
            if (bubble) bubble.textContent = data.newName.charAt(0).toUpperCase();
          }
          if (typeof updateRailActive === "function") updateRailActive();
        } else {
          el.textContent = oldName;
          if (typeof showError === "function") showError(data.error || "Rename failed");
        }
      })
      .catch(() => {
        el.textContent = oldName;
        if (typeof showError === "function") showError("Rename failed");
      });
  }

  el.addEventListener("blur", commit, { once: true });
  el.addEventListener("keydown", function handler(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      el.removeEventListener("keydown", handler);
      el.blur();
    }
    if (e.key === "Escape") {
      el.textContent = oldName;
      el.removeEventListener("keydown", handler);
      el.blur();
    }
  });
});

// Humanify toggle
const humanifyCheckbox = document.getElementById("humanify-checkbox");
if (humanifyCheckbox) {
  humanifyCheckbox.addEventListener("change", async (e) => {
    await fetch("/api/brand-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "humanify", content: e.target.checked ? "on" : "off" }),
    });
  });
}

// ---------------------------------------------------------------------------
// Workspace tab navigation
// ---------------------------------------------------------------------------

function switchWorkspaceTab(tabName) {
  document.querySelectorAll(".workspace-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.wsTab === tabName);
  });
  document.querySelectorAll(".workspace-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.wsPanel === tabName);
  });
  if (tabName === "settings" && typeof refreshSettings === "function") {
    refreshSettings();
  }
  if (tabName === "library") {
    refreshDashboard();
  }
}

document.querySelectorAll(".workspace-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchWorkspaceTab(btn.dataset.wsTab);
  });
});

