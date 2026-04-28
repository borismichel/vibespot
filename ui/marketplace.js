/**
 * Marketplace publication panel — runs the Marketplace check against the
 * active theme, lets users browse findings, fix the auto-fixable ones, and
 * edit the marketplace.json listing sidecar.
 */

async function openMarketplacePanel() {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay marketplace-overlay";
  overlay.innerHTML = `
    <div class="confirm-dialog marketplace-dialog">
      <div class="confirm-dialog__title">HubSpot Marketplace check</div>
      <div class="marketplace-body" id="marketplace-body">
        <p class="confirm-dialog__detail">Running check…</p>
      </div>
      <div class="confirm-dialog__actions">
        <button class="btn btn--ghost" data-action="close">Close</button>
        <button class="btn btn--ghost" data-action="edit">Edit listing</button>
        <button class="btn btn--ghost" data-action="fix" disabled>Apply fixes</button>
        <button class="btn btn--primary" data-action="recheck">Re-check</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#marketplace-body");
  const fixBtn = overlay.querySelector('[data-action="fix"]');
  const editBtn = overlay.querySelector('[data-action="edit"]');
  const recheckBtn = overlay.querySelector('[data-action="recheck"]');
  const closeBtn = overlay.querySelector('[data-action="close"]');

  let lastCategories = [];

  async function refresh() {
    body.innerHTML = `<p class="confirm-dialog__detail">Running check…</p>`;
    try {
      const res = await fetch("/api/marketplace/check");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed");
      lastCategories = data.categories || [];
      renderReport(body, data.report);
      const autoFixable = (data.report.findings || []).some((f) => f.autoFixable);
      fixBtn.disabled = !autoFixable;
    } catch (err) {
      body.innerHTML = `<p class="confirm-dialog__detail">${esc(err.message)}</p>`;
    }
  }

  recheckBtn.addEventListener("click", refresh);
  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  fixBtn.addEventListener("click", async () => {
    fixBtn.disabled = true;
    try {
      const res = await fetch("/api/marketplace/fix", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fix failed");
      renderReport(body, data.report, data.fix);
    } catch (err) {
      await vibeAlert(err.message, "Fix failed");
    }
  });

  editBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/marketplace/listing");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load listing");
      lastCategories = data.categories || lastCategories;
      const next = await openListingEditor(data.metadata, lastCategories);
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

  refresh();
}

function renderReport(container, report, fix) {
  if (!report) {
    container.innerHTML = `<p class="confirm-dialog__detail">No report available.</p>`;
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
    html += `<p class="confirm-dialog__detail">Nothing to flag — submit when ready.</p>`;
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
          <label>Features (comma-separated)
            <input name="features" value="${esc((meta.features || []).join(", "))}" />
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

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-marketplace");
  if (btn) btn.addEventListener("click", openMarketplacePanel);
});
