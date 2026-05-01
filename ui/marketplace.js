/**
 * Marketplace publication tab — VIB-188 moves the marketplace check from a
 * modal overlay into the Editor's Marketplace workspace tab. The renderer is
 * invoked by navigation.js when the tab activates.
 */

let _marketplaceState = {
  report: null,
  categories: [],
  loading: false,
  initialised: false,
};

function renderMarketplacePanel(panel) {
  if (!panel) panel = document.getElementById("ws-panel-marketplace");
  if (!panel) return;
  const container = panel.querySelector(".dashboard__container") || panel;

  // Ensure the section scaffolding exists. If the legacy initial markup is
  // still present (a single "Run Validation" CTA), replace it with our shell.
  let shell = container.querySelector(".marketplace-tab");
  if (!shell) {
    container.innerHTML = `
      <section class="dashboard__section marketplace-tab">
        <div class="dashboard__section-header">
          <h2 class="dashboard__section-title">Marketplace</h2>
          <span class="dashboard__section-hint">Validate and publish your theme</span>
        </div>
        <div class="marketplace-tab__toolbar">
          <button class="btn btn--primary btn--sm" id="btn-marketplace" type="button">
            <svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            <span data-role="check-label">Run Validation</span>
          </button>
          <button class="btn btn--ghost btn--sm" data-action="edit" type="button">Edit listing</button>
          <button class="btn btn--ghost btn--sm" data-action="fix" type="button" disabled>Apply fixes</button>
        </div>
        <div class="marketplace-tab__body" data-role="body">
          <p class="dashboard__empty-state">Run a marketplace validation check to see if your theme is ready for publication.</p>
        </div>
      </section>`;
    shell = container.querySelector(".marketplace-tab");
  }

  if (_marketplaceState.initialised) {
    // Refresh the report when the tab re-activates so users see fresh data.
    if (_marketplaceState.report) {
      renderReport(shell.querySelector('[data-role="body"]'), _marketplaceState.report);
    }
    return;
  }
  _marketplaceState.initialised = true;

  const checkBtn = shell.querySelector("#btn-marketplace");
  const editBtn = shell.querySelector('[data-action="edit"]');
  const fixBtn = shell.querySelector('[data-action="fix"]');
  const body = shell.querySelector('[data-role="body"]');

  async function refresh() {
    if (_marketplaceState.loading) return;
    _marketplaceState.loading = true;
    body.innerHTML = `<p class="dashboard__empty-state">Running check…</p>`;
    try {
      const res = await fetch("/api/marketplace/check");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed");
      _marketplaceState.report = data.report;
      _marketplaceState.categories = data.categories || [];
      renderReport(body, data.report);
      const autoFixable = (data.report.findings || []).some((f) => f.autoFixable);
      fixBtn.disabled = !autoFixable;
      const label = checkBtn.querySelector('[data-role="check-label"]');
      if (label) label.textContent = "Re-check";
    } catch (err) {
      body.innerHTML = `<p class="dashboard__empty-state">${esc(err.message)}</p>`;
    } finally {
      _marketplaceState.loading = false;
    }
  }

  checkBtn.addEventListener("click", refresh);

  fixBtn.addEventListener("click", async () => {
    fixBtn.disabled = true;
    try {
      const res = await fetch("/api/marketplace/fix", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fix failed");
      _marketplaceState.report = data.report;
      renderReport(body, data.report, data.fix);
      const stillFixable = (data.report.findings || []).some((f) => f.autoFixable);
      fixBtn.disabled = !stillFixable;
    } catch (err) {
      await vibeAlert(err.message, "Fix failed");
    }
  });

  editBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/marketplace/listing");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load listing");
      _marketplaceState.categories = data.categories || _marketplaceState.categories;
      const next = await openListingEditor(data.metadata, _marketplaceState.categories);
      if (!next) return;
      const save = await fetch("/api/marketplace/listing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const result = await save.json();
      if (!save.ok) throw new Error(result.error || "Save failed");
      await refresh();
    } catch (err) {
      await vibeAlert(err.message, "Listing");
    }
  });
}

function runMarketplaceCheck() {
  // Public entry point used by ws-tab-marketplace activation handlers.
  const panel = document.getElementById("ws-panel-marketplace");
  renderMarketplacePanel(panel);
  const btn = panel?.querySelector("#btn-marketplace");
  if (btn) btn.click();
}

function renderReport(container, report, fix) {
  if (!report) {
    container.innerHTML = `<p class="dashboard__empty-state">No report available.</p>`;
    return;
  }

  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  const info = report.findings.filter((f) => f.severity === "info");

  const summaryClass = report.passed ? "marketplace-summary--ok" : "marketplace-summary--fail";
  const summaryText = report.passed
    ? `Theme passes Marketplace checks.`
    : `Theme is not yet ready.`;

  let html = `
    <div class="marketplace-summary ${summaryClass}">
      <strong>${esc(summaryText)}</strong>
      <div class="marketplace-summary__counts">
        <span class="marketplace-pill marketplace-pill--error">${errors.length} errors</span>
        <span class="marketplace-pill marketplace-pill--warn">${warnings.length} warnings</span>
        <span class="marketplace-pill marketplace-pill--info">${info.length} notes</span>
      </div>
    </div>
  `;

  if (fix && (fix.applied?.length || fix.skipped?.length)) {
    html += `<div class="marketplace-fix-result">`;
    if (fix.applied?.length) {
      html += `<strong>Applied:</strong><ul>${fix.applied.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
    }
    if (fix.skipped?.length) {
      html += `<strong>Skipped:</strong><ul>${fix.skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
    }
    html += `</div>`;
  }

  html += renderFindingGroup("Errors", errors);
  html += renderFindingGroup("Warnings", warnings);
  html += renderFindingGroup("Notes", info);

  if (report.findings.length === 0) {
    html += `<p class="dashboard__empty-state">Nothing to flag — submit when ready.</p>`;
  }

  container.innerHTML = html;
}

function renderFindingGroup(title, findings) {
  if (findings.length === 0) return "";
  const items = findings.map((f) => `
    <li class="marketplace-finding marketplace-finding--${f.severity}">
      ${f.file ? `<code class="marketplace-finding__file">${esc(f.file)}</code>` : ""}
      <span class="marketplace-finding__msg">${esc(f.message)}</span>
      ${f.fix ? `<div class="marketplace-finding__fix">${esc(f.fix)}</div>` : ""}
    </li>
  `).join("");
  return `<section class="marketplace-section"><h4>${esc(title)}</h4><ul class="marketplace-findings">${items}</ul></section>`;
}

function openListingEditor(existing, categories) {
  const meta = existing || {};
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const catOptions = (categories || []).map(
      (c) => `<option value="${esc(c)}" ${c === meta.category ? "selected" : ""}>${esc(c)}</option>`
    ).join("");
    overlay.innerHTML = `
      <div class="confirm-dialog marketplace-dialog">
        <div class="confirm-dialog__title">Marketplace listing</div>
        <form id="marketplace-listing-form" class="marketplace-listing-form">
          <label>Category
            <select name="category"><option value="">Select…</option>${catOptions}</select>
          </label>
          <label>Description
            <textarea name="description" rows="3" placeholder="A 1–2 sentence summary for the Marketplace listing.">${esc(meta.description || "")}</textarea>
          </label>
          <label>Features (comma-separated, 2–5 items)
            <input name="features" value="${esc((meta.features || []).join(", "))}" placeholder="Hero, Pricing, Testimonials, Footer" />
          </label>
          <label>Support URL
            <input type="url" name="supportUrl" value="${esc(meta.supportUrl || "")}" placeholder="https://example.com/support" />
          </label>
          <label>Documentation URL (optional)
            <input type="url" name="documentationUrl" value="${esc(meta.documentationUrl || "")}" placeholder="https://example.com/docs" />
          </label>
          <label>Pricing tier
            <select name="pricingTier">
              <option value="free" ${meta.pricingTier === "free" ? "selected" : ""}>Free</option>
              <option value="paid" ${meta.pricingTier === "paid" ? "selected" : ""}>Paid</option>
            </select>
          </label>
        </form>
        <div class="confirm-dialog__actions">
          <button class="btn btn--ghost" data-action="cancel">Cancel</button>
          <button class="btn btn--primary" data-action="save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const form = overlay.querySelector("form");

    const cleanup = () => overlay.remove();
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => { cleanup(); resolve(null); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
    overlay.querySelector('[data-action="save"]').addEventListener("click", () => {
      const fd = new FormData(form);
      const features = String(fd.get("features") || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const result = {
        category: String(fd.get("category") || "") || undefined,
        description: String(fd.get("description") || "") || undefined,
        features: features.length ? features : undefined,
        supportUrl: String(fd.get("supportUrl") || "") || undefined,
        documentationUrl: String(fd.get("documentationUrl") || "") || undefined,
        pricingTier: String(fd.get("pricingTier") || "") || undefined,
      };
      cleanup();
      resolve(result);
    });
  });
}

window.renderMarketplacePanel = renderMarketplacePanel;
window.runMarketplaceCheck = runMarketplaceCheck;
