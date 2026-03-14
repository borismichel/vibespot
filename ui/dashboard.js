/**
 * Dashboard screen — project overview with templates, module library, and brand assets.
 * Sits between setup (project list) and chat (template editing).
 */

const dashboardScreen = document.getElementById("dashboard-screen");

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

async function showDashboard(themeName) {
  currentDashboardTheme = themeName;

  // Hide other screens
  setupScreen.classList.add("hidden");
  document.getElementById("setup-topbar").classList.add("hidden");
  document.getElementById("project-rail")?.classList.remove("project-rail--expanded");
  appScreen.classList.add("hidden");
  dashboardScreen.classList.remove("hidden");

  document.getElementById("dashboard-theme-name").textContent = themeName;
  document.getElementById("dashboard-theme-heading").textContent = themeName;
  document.getElementById("dashboard-theme-path-text").textContent = "";

  // Get sessionId for the active theme
  try {
    const themesRes = await fetch("/api/themes");
    const themesData = await themesRes.json();
    currentDashboardSessionId = themesData.activeTheme?.id || "";
  } catch { currentDashboardSessionId = ""; }

  // Update URL
  const target = "#/dashboard/" + encodeURIComponent(themeName);
  if (location.hash !== target) {
    history.pushState(null, "", target);
  }

  // Load dashboard data
  await refreshDashboard();
}

function hideDashboard() {
  dashboardScreen.classList.add("hidden");
  currentDashboardTheme = "";
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
    renderModuleLibrary(data.moduleLibrary || []);
    renderBrandAssets(data.brandAssets || {});
    if (data.themePath) {
      document.getElementById("dashboard-theme-path-text").textContent = data.themePath;
    }
  } catch (err) {
    console.error("Failed to load dashboard:", err);
  }
}

// ---------------------------------------------------------------------------
// Template list
// ---------------------------------------------------------------------------

function renderTemplateList(templates) {
  const list = document.getElementById("dashboard-template-list");
  const countEl = document.getElementById("dashboard-template-count");
  countEl.textContent = templates.length;

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
      <button class="dashboard__template-clone" data-id="${esc(tpl.id)}" title="Clone template">&#x2398;</button>
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
// Module library
// ---------------------------------------------------------------------------

let activePreviewModule = "";

function renderModuleLibrary(modules) {
  const container = document.getElementById("dashboard-module-library");

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
  previewEl.classList.add("hidden");
  document.querySelectorAll(".dashboard__module-chip").forEach((c) => {
    c.classList.remove("dashboard__module-chip--active");
  });
}

// Close button for module preview
document.getElementById("dashboard-preview-close").addEventListener("click", closeModulePreview);

// ---------------------------------------------------------------------------
// Brand assets
// ---------------------------------------------------------------------------

function renderBrandAssets(assets) {
  const sgIcon = document.getElementById("brand-icon-styleguide");
  const bvIcon = document.getElementById("brand-icon-brandvoice");

  if (assets.hasStyleguide) {
    sgIcon.textContent = "\u2713";
    sgIcon.classList.add("brand-asset-upload__icon--done");
  } else {
    sgIcon.textContent = "+";
    sgIcon.classList.remove("brand-asset-upload__icon--done");
  }

  if (assets.hasBrandvoice) {
    bvIcon.textContent = "\u2713";
    bvIcon.classList.add("brand-asset-upload__icon--done");
  } else {
    bvIcon.textContent = "+";
    bvIcon.classList.remove("brand-asset-upload__icon--done");
  }

  // View buttons — show only when asset exists
  let sgView = document.getElementById("btn-view-styleguide");
  if (!sgView) {
    sgView = document.createElement("button");
    sgView.id = "btn-view-styleguide";
    sgView.className = "btn btn--sm btn--ghost brand-asset-view";
    sgView.textContent = "View";
    sgView.title = "View styleguide";
    sgView.addEventListener("click", viewStyleguide);
    document.getElementById("brand-upload-styleguide")?.after(sgView);
  }
  sgView.style.display = assets.hasStyleguide ? "" : "none";

  let bvView = document.getElementById("btn-view-brandvoice");
  if (!bvView) {
    bvView = document.createElement("button");
    bvView.id = "btn-view-brandvoice";
    bvView.className = "btn btn--sm btn--ghost brand-asset-view";
    bvView.textContent = "View";
    bvView.title = "View brand voice";
    bvView.addEventListener("click", viewBrandvoice);
    document.getElementById("brand-upload-brandvoice")?.after(bvView);
  }
  bvView.style.display = assets.hasBrandvoice ? "" : "none";

  // Humanify toggle
  const humanifyCheckbox = document.getElementById("humanify-checkbox");
  if (humanifyCheckbox) {
    humanifyCheckbox.checked = assets.humanify !== false;
  }
}

async function viewStyleguide() {
  try {
    const res = await fetch("/api/brand-assets");
    const data = await res.json();
    if (data.styleguide) {
      await vibeViewContent(data.styleguide, "Styleguide");
    } else {
      await vibeAlert("No styleguide found.", "Info");
    }
  } catch (err) {
    await vibeAlert("Failed to load styleguide: " + err.message, "Error");
  }
}

async function viewBrandvoice() {
  try {
    const res = await fetch("/api/brand-assets");
    const data = await res.json();
    if (data.brandvoice) {
      await vibeViewContent(data.brandvoice, "Brand Voice");
    } else {
      await vibeAlert("No brand voice found.", "Info");
    }
  } catch (err) {
    await vibeAlert("Failed to load brand voice: " + err.message, "Error");
  }
}

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
  const ok = await vibeConfirm("Delete this template?", "This cannot be undone.", { confirmLabel: "Delete" });
  if (!ok) return;

  try {
    await fetch("/api/templates", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    await refreshDashboard();
  } catch (err) {
    await vibeAlert("Failed to delete: " + err.message, "Error");
  }
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
  hideDashboard();

  // Show app screen
  appScreen.classList.remove("hidden");
  document.getElementById("theme-name").textContent = themeName;

  // Update browser chrome URL bar
  const urlEl = document.getElementById("browser-url");
  if (urlEl) urlEl.textContent = themeName + ".vibespot.app";

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

// Back button → setup
document.getElementById("dashboard-back").addEventListener("click", () => {
  hideDashboard();
  if (typeof showSetup === "function") showSetup();
});

// Settings button
document.getElementById("dashboard-settings-btn").addEventListener("click", () => {
  if (typeof openSettings === "function") openSettings();
});

// Deploy button
document.getElementById("dashboard-deploy-btn").addEventListener("click", () => {
  if (typeof startUpload === "function") {
    // Need to show app screen temporarily for upload
    appScreen.classList.remove("hidden");
    dashboardScreen.classList.add("hidden");
    startUpload();
  }
});

// Brand asset file inputs
document.getElementById("brand-upload-styleguide").querySelector("input").addEventListener("change", (e) => {
  if (e.target.files[0]) handleBrandFileSelected("styleguide", e.target.files[0]);
});
document.getElementById("brand-upload-brandvoice").querySelector("input").addEventListener("change", (e) => {
  if (e.target.files[0]) handleBrandFileSelected("brandvoice", e.target.files[0]);
});

// Extract design from theme
document.getElementById("btn-extract-design")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-extract-design");
  const origText = btn.textContent;
  btn.textContent = "Extracting...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/brand-assets/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.ok) {
      await refreshDashboard();
      const view = await vibeConfirm("Design system extracted and saved as styleguide.", "Would you like to view it?", { confirmLabel: "View Styleguide", confirmClass: "btn--primary" });
      if (view && data.styleguide) {
        await vibeViewContent(data.styleguide, "Styleguide");
      }
    } else {
      await vibeAlert(data.error || "Extraction failed", "Error");
    }
  } catch (err) {
    await vibeAlert("Extraction failed: " + err.message, "Error");
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
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
        await vibeViewContent(data.styleguide, "Styleguide");
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

// Dashboard theme heading — double-click to rename
document.getElementById("dashboard-theme-heading")?.addEventListener("dblclick", () => {
  const el = document.getElementById("dashboard-theme-heading");
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
          document.getElementById("dashboard-theme-name").textContent = data.newName;
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

// Download ZIP button
document.getElementById("dashboard-download-zip").addEventListener("click", async () => {
  const btn = document.getElementById("dashboard-download-zip");
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.querySelector("span").textContent = "Downloading...";

  try {
    const res = await fetch("/api/download-zip");
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Download failed" }));
      throw new Error(err.error || "Download failed");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (currentDashboardTheme || "theme") + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    if (typeof vibeAlert === "function") vibeAlert(err.message, "Error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
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
