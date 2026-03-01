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
      el.style.outline = "2px solid #7C3AED";
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f0f14;
    color: #999;
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
    border: 3px solid rgba(124, 58, 237, 0.12);
    border-top-color: rgba(124, 58, 237, 0.7);
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
    "Building the future of HubSpot, one module at a time\\u2026",
    "Teaching pixels to speak HubL\\u2026",
    "Converting caffeine into landing pages\\u2026",
    "Crafting CMS modules with questionable amounts of AI\\u2026",
    "Your landing page is being forged in the cloud\\u2026",
    "Making HubSpot designers nervous since 2025\\u2026",
    "Turning vibes into valid HTML\\u2026",
    "Somewhere, a designer just lost their job to a chat prompt\\u2026",
    "Generating responsive CSS that actually works\\u2026",
    "Hold tight \\u2014 great things take a few seconds\\u2026",
    "Aligning divs so you don\\u2019t have to\\u2026",
    "Your modules are marinating in the AI kitchen\\u2026",
    "Sprinkling HubL magic on your components\\u2026",
    "Converting your dreams into fields.json\\u2026",
    "Making drag-and-drop editors jealous\\u2026",
    "This is way faster than doing it manually, trust us\\u2026",
    "BEM-naming things so they stay classy\\u2026",
    "Wrangling meta.json into submission\\u2026"
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
