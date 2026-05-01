/**
 * Email client preview — heuristic rendering for Gmail, Outlook Desktop, Apple Mail.
 * Only visible in email content mode.
 */

(function () {
  const overlay = document.getElementById("email-preview-overlay");
  const closeBtn = document.getElementById("email-preview-close");
  const openBtn = document.getElementById("btn-email-preview");
  const tabsContainer = document.getElementById("email-preview-tabs");
  const frame = document.getElementById("email-preview-frame");
  const notesEl = document.getElementById("email-preview-notes");

  if (!overlay || !frame) return;

  let cachedPreviews = null;
  let activeClient = "gmail";

  function showPreview(client) {
    activeClient = client;
    tabsContainer.querySelectorAll(".email-preview-tab").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-client") === client);
    });

    if (!cachedPreviews) return;
    var preview = cachedPreviews.find(function (p) { return p.client === client; });
    if (!preview) return;

    frame.srcdoc = preview.html;

    if (preview.notes && preview.notes.length > 0) {
      notesEl.innerHTML = preview.notes
        .map(function (n) { return '<span class="email-preview-note">' + escapeHtml(n) + '</span>'; })
        .join("");
      notesEl.classList.remove("hidden");
    } else {
      notesEl.classList.add("hidden");
    }
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function openEmailPreview() {
    overlay.classList.remove("hidden");
    notesEl.textContent = "Loading previews...";
    notesEl.classList.remove("hidden");

    fetch("/api/email-preview/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          notesEl.textContent = "Error: " + data.error;
          return;
        }
        cachedPreviews = data.previews;
        showPreview(activeClient);
      })
      .catch(function (err) {
        notesEl.textContent = "Failed to load previews: " + err.message;
      });
  }

  function closeEmailPreview() {
    overlay.classList.add("hidden");
    cachedPreviews = null;
    frame.srcdoc = "";
  }

  if (openBtn) {
    openBtn.addEventListener("click", openEmailPreview);
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", closeEmailPreview);
  }

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeEmailPreview();
  });

  tabsContainer.addEventListener("click", function (e) {
    var btn = e.target.closest(".email-preview-tab");
    if (!btn) return;
    var client = btn.getAttribute("data-client");
    if (client) showPreview(client);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
      closeEmailPreview();
    }
  });

  window.showEmailPreviewButton = function () {
    if (openBtn) openBtn.classList.remove("hidden");
  };

  window.hideEmailPreviewButton = function () {
    if (openBtn) openBtn.classList.add("hidden");
  };
})();
