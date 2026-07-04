/**
 * Section visual controls — parent end (VIB-1892).
 *
 * The hover toolbar, color picker, sliders and popovers all run inside the
 * cross-origin preview frame (ui/preview-agent.js), built from the field
 * definitions the preview origin embeds into the composed doc. The parent
 * only receives the committed change (vs:field-commit) and persists it via
 * /api/field — the single write the preview boundary allows.
 */

(() => {
  onPreviewMessage("vs:field-commit", (p) => {
    if (!p || typeof p.moduleName !== "string" || !p.moduleName) return;
    if (typeof p.fieldPath !== "string" || !p.fieldPath) return;
    if (p.value === undefined) return;

    fetch("/api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleName: p.moduleName,
        fieldPath: p.fieldPath,
        value: p.value,
      }),
    }).then(() => {
      // While a popover drag is in flight the agent asks us to hold the
      // reload so the in-frame controls don't vanish mid-interaction.
      if (p.refresh) refreshPreview();
    }).catch(() => { /* field save failed — preview keeps optimistic state */ });
  });
})();
