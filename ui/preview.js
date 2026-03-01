/**
 * Preview management — iframe loading and module scrolling.
 */

const previewFrame = document.getElementById("preview-frame");

/**
 * Refresh the preview iframe by reloading from /preview endpoint.
 */
function refreshPreview() {
  // Use srcdoc approach: fetch preview HTML and set as srcdoc
  // This avoids cache issues and allows the iframe to update smoothly
  fetch("/preview")
    .then((res) => res.text())
    .then((html) => {
      previewFrame.srcdoc = html;
    })
    .catch((err) => {
      console.error("Preview refresh failed:", err);
    });
}

/**
 * Scroll the preview iframe to a specific module by name.
 */
function scrollPreviewToModule(moduleName) {
  try {
    const doc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    const el = doc.querySelector(`[data-module="${moduleName}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });

      // Brief highlight effect
      el.style.outline = "2px solid #e8613a";
      el.style.outlineOffset = "4px";
      el.style.transition = "outline-color 0.5s ease";
      setTimeout(() => {
        el.style.outlineColor = "transparent";
        setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 500);
      }, 1500);
    }
  } catch {
    // Cross-origin issues — fall back to simple reload
  }
}

/**
 * Show the generating preview — spinner + rotating fun messages.
 * Called when AI generation starts to entertain the user while waiting.
 */
function showGeneratingPreview() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0c0a09;
    color: rgba(255,255,255,0.45);
  }
  .gen {
    text-align: center;
    padding: 2rem;
  }
  .gen p {
    font-size: 1.1rem;
    line-height: 1.6;
    max-width: 440px;
    transition: opacity 0.6s ease;
  }
  .gen p.fade { opacity: 0; }
  .spinner {
    width: 44px;
    height: 44px;
    margin: 0 auto 1.5rem;
    border: 3px solid rgba(232, 97, 58, 0.12);
    border-top-color: rgba(232, 97, 58, 0.7);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="gen">
  <div class="spinner"></div>
  <p id="msg"></p>
</div>
<script>
  var lines = [
    "Choosing the perfect fonts\\u2026 no Comic Sans, we promise",
    "Writing headlines that hit different\\u2026",
    "Crafting testimonials that sound real, not robotic\\u2026",
    "Setting up a pricing section\\u2026 transparent, no hidden fees",
    "Adding the finishing touches\\u2026 micro-animations & hover states",
    "Picking colors that actually work together\\u2026",
    "Building your hero section\\u2026 first impressions matter",
    "Creating a navigation that just makes sense\\u2026",
    "Hold tight \\u2014 great pages take a moment\\u2026",
    "Generating responsive layouts that look good everywhere\\u2026",
    "Making your page scroll-stoppingly good\\u2026",
    "Assembling your FAQ section\\u2026 answering questions before they\\u2019re asked",
    "Designing call-to-action buttons people actually want to click\\u2026",
    "Adding trust signals\\u2026 because credibility matters",
    "Polishing the footer\\u2026 every detail counts"
  ];
  var idx = Math.floor(Math.random() * lines.length);
  var el = document.getElementById("msg");
  el.textContent = lines[idx];
  setInterval(function() {
    el.classList.add("fade");
    setTimeout(function() {
      idx = (idx + 1) % lines.length;
      el.textContent = lines[idx];
      el.classList.remove("fade");
    }, 600);
  }, 4000);
<\/script>
</body>
</html>`;
  previewFrame.srcdoc = html;
}

// Preview refresh is triggered by setup.js after a session is created.
// Do NOT auto-refresh here.
