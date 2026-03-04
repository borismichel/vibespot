/**
 * Upload panel — slide-up log for live hs upload output
 */

let uploadState = "idle";
let uploadAttempt = 0;
let lastUploadErrors = [];
let lastUploadPortalId = "";
let lastUploadDataCenter = "na1";
let lastUploadThemeName = "";
const MAX_UPLOAD_ATTEMPTS = 3;

async function startUpload() {
  if (uploadState === "uploading" || uploadState === "ai_fixing") return;

  const uploadBtn = document.getElementById("btn-upload");
  if (uploadBtn) {
    uploadBtn.innerHTML = '<span class="upload-spinner"></span>';
    uploadBtn.disabled = true;
  }

  function resetUploadBtn() {
    if (uploadBtn) { uploadBtn.textContent = "Deploy"; uploadBtn.disabled = false; }
  }

  // Fetch portal info and check HubSpot CLI readiness
  try {
    const res = await fetch("/api/settings/status");
    const data = await res.json();
    let hs = data.environment?.tools?.hubspot;

    // HubSpot CLI not installed — guide the user through install
    if (!hs || !hs.found) {
      const installed = await showHubSpotSetupDialog("install");
      if (!installed) { resetUploadBtn(); return; }
      // Re-check after install
      const recheck = await fetch("/api/settings/status").then((r) => r.json());
      hs = recheck.environment?.tools?.hubspot;
    }

    // HubSpot CLI installed but not authenticated — guide through auth
    if (hs && hs.found && !hs.authenticated) {
      const authed = await showHubSpotSetupDialog("auth");
      if (!authed) { resetUploadBtn(); return; }
      // Re-check after auth
      const recheck = await fetch("/api/settings/status").then((r) => r.json());
      hs = recheck.environment?.tools?.hubspot;
    }

    // Confirm portal before deploying
    if (hs && hs.authenticated && hs.portalName) {
      const confirmed = await confirmUpload(hs.portalName, hs.portalId);
      if (!confirmed) { resetUploadBtn(); return; }
    }
  } catch {
    // If we can't detect, proceed and let the upload fail with a meaningful error
  }

  doUpload();
}

/**
 * Show a dialog to guide the user through HubSpot CLI install or auth.
 * @param {"install" | "auth"} mode
 * @returns {Promise<boolean>} true if the step completed successfully
 */
function showHubSpotSetupDialog(mode) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    if (mode === "install") {
      overlay.innerHTML = `
        <div class="confirm-dialog" style="width:420px">
          <div class="confirm-dialog__title">Install HubSpot CLI</div>
          <p class="confirm-dialog__detail">The HubSpot CLI is needed to deploy your theme. This will run <code>npm install -g @hubspot/cli</code>.</p>
          <div class="confirm-dialog__actions">
            <button class="btn btn--secondary" data-action="cancel">Cancel</button>
            <button class="btn btn--primary" data-action="install">Install</button>
          </div>
          <div class="hs-setup__status hidden" id="hs-install-status">
            <span class="upload-spinner"></span> Installing...
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

      overlay.querySelector('[data-action="install"]').addEventListener("click", async () => {
        const installBtn = overlay.querySelector('[data-action="install"]');
        installBtn.disabled = true;
        installBtn.textContent = "Installing...";
        const statusEl = document.getElementById("hs-install-status");
        if (statusEl) statusEl.classList.remove("hidden");

        try {
          const res = await fetch("/api/settings/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "hubspot" }),
          });
          const data = await res.json();
          if (data.jobId) {
            // Poll until done
            for (let i = 0; i < 60; i++) {
              await new Promise((r) => setTimeout(r, 2000));
              const jr = await fetch("/api/settings/job/" + data.jobId).then((r) => r.json());
              if (jr.status === "completed") { close(true); return; }
              if (jr.status === "failed") { close(false); return; }
            }
          }
          close(false);
        } catch {
          close(false);
        }
      });

    } else {
      // Auth mode — PAK flow
      overlay.innerHTML = `
        <div class="confirm-dialog" style="width:460px">
          <div class="confirm-dialog__title">Connect your HubSpot account</div>
          <p class="confirm-dialog__detail">Create a Personal Access Key to connect vibeSpot to your HubSpot portal.</p>
          <ol class="hs-setup__steps">
            <li>Open <a href="https://app.hubspot.com/portal-recommend/l?slug=personal-access-key" target="_blank" rel="noopener">HubSpot Settings</a></li>
            <li>Click "Create personal access key" or copy an existing one</li>
            <li>Paste the key below</li>
          </ol>
          <input type="password" class="confirm-dialog__input" id="hs-pak-input" placeholder="pat-na1-..." />
          <div class="confirm-dialog__actions">
            <button class="btn btn--secondary" data-action="cancel">Cancel</button>
            <button class="btn btn--primary" data-action="save">Connect</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

      const pakInput = document.getElementById("hs-pak-input");
      const saveBtn = overlay.querySelector('[data-action="save"]');

      const doSave = async () => {
        const key = pakInput.value.trim();
        if (!key) return;
        saveBtn.disabled = true;
        saveBtn.textContent = "Connecting...";
        try {
          const res = await fetch("/api/settings/hs-auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personalAccessKey: key }),
          });
          const data = await res.json();
          if (data.error) {
            await vibeAlert(data.error, "Error");
            saveBtn.disabled = false;
            saveBtn.textContent = "Connect";
            return;
          }
          close(true);
        } catch (err) {
          await vibeAlert("Failed to connect: " + err.message, "Error");
          saveBtn.disabled = false;
          saveBtn.textContent = "Connect";
        }
      };

      saveBtn.addEventListener("click", doSave);
      pakInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
      setTimeout(() => pakInput.focus(), 50);
    }
  });
}

function doUpload() {
  uploadAttempt = 0;
  const panel = document.getElementById("upload-panel");
  const log = document.getElementById("upload-log");
  log.textContent = "";
  panel.classList.remove("hidden");
  panel.className = "upload-panel";

  setUploadState("writing");

  // Send via WebSocket
  if (typeof ws !== "undefined" && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "start_upload" }));
  } else {
    appendUploadLog("Error: Not connected to server\n");
    setUploadState("failed");
  }
}

function confirmUpload(portalName, portalId) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">Deploy to HubSpot?</div>
        <p class="confirm-dialog__detail">
          Uploading to <strong>${esc(portalName)}</strong>${portalId ? ` (${esc(portalId)})` : ""}
        </p>
        <div class="confirm-dialog__actions">
          <button class="btn btn--secondary" id="confirm-upload-cancel">Cancel</button>
          <button class="btn btn--primary" id="confirm-upload-go">Deploy</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("confirm-upload-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
    document.getElementById("confirm-upload-go").addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });
  });
}

function setUploadState(state, data) {
  uploadState = state;
  const panel = document.getElementById("upload-panel");
  const statusEl = document.getElementById("upload-status-text");
  const actions = document.getElementById("upload-actions");
  const uploadBtn = document.getElementById("btn-upload");

  // Reset panel state classes
  panel.className = "upload-panel";
  actions.innerHTML = "";

  switch (state) {
    case "idle":
      panel.classList.add("hidden");
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = false;
      }
      break;

    case "writing":
      statusEl.textContent = "Writing files to disk...";
      if (uploadBtn) {
        uploadBtn.innerHTML = '<span class="upload-spinner"></span> Preparing...';
        uploadBtn.disabled = true;
      }
      break;

    case "autofix":
      statusEl.textContent = "Applying auto-fixes...";
      break;

    case "uploading":
      panel.classList.add("upload-panel--uploading");
      statusEl.textContent = "Uploading to HubSpot" + (uploadAttempt > 1 ? ` (attempt ${uploadAttempt})` : "") + "...";
      if (uploadBtn) {
        uploadBtn.innerHTML = '<span class="upload-spinner"></span> Uploading...';
        uploadBtn.disabled = true;
      }
      break;

    case "success":
      panel.classList.add("upload-panel--success");
      statusEl.innerHTML = '<span class="upload-status-icon">&#10003;</span> Upload complete!';
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = false;
      }
      const dismissBtn = document.createElement("button");
      dismissBtn.className = "upload-action-btn";
      dismissBtn.textContent = "Dismiss";
      dismissBtn.addEventListener("click", () => setUploadState("idle"));
      actions.appendChild(dismissBtn);

      // Show the Create Page button
      if (lastUploadPortalId) {
        const createBtn = document.createElement("button");
        createBtn.className = "upload-action-btn upload-action-btn--primary";
        createBtn.textContent = "Create Page in HubSpot";
        createBtn.addEventListener("click", () => {
          window.open(buildHubSpotPagesUrl(lastUploadPortalId, lastUploadDataCenter), "_blank");
        });
        actions.insertBefore(createBtn, dismissBtn);
      }
      break;

    case "failed":
      panel.classList.add("upload-panel--error");
      statusEl.innerHTML = '<span class="upload-status-icon">&#10007;</span> Upload failed';
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = false;
      }

      const retryBtn = document.createElement("button");
      retryBtn.className = "upload-action-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => startUpload());
      actions.appendChild(retryBtn);

      const fixBtn = document.createElement("button");
      fixBtn.className = "upload-action-btn upload-action-btn--primary";
      fixBtn.textContent = "Fix with AI";
      fixBtn.addEventListener("click", () => fixUploadWithAI());
      actions.appendChild(fixBtn);

      const dismissFailBtn = document.createElement("button");
      dismissFailBtn.className = "upload-action-btn";
      dismissFailBtn.textContent = "Dismiss";
      dismissFailBtn.addEventListener("click", () => setUploadState("idle"));
      actions.appendChild(dismissFailBtn);
      break;

    case "ai_fixing":
      panel.classList.add("upload-panel--fixing");
      statusEl.innerHTML = '<span class="upload-spinner"></span> AI is fixing errors...';
      if (uploadBtn) {
        uploadBtn.innerHTML = '<span class="upload-spinner"></span> Fixing...';
        uploadBtn.disabled = true;
      }
      break;

    case "fix_done":
      panel.classList.add("upload-panel--fixing");
      statusEl.innerHTML = '<span class="upload-status-icon">&#10003;</span> AI fixes applied';
      if (uploadBtn) {
        uploadBtn.textContent = "Deploy";
        uploadBtn.disabled = false;
      }

      const redeployBtn = document.createElement("button");
      redeployBtn.className = "upload-action-btn upload-action-btn--primary";
      redeployBtn.textContent = "Re-deploy";
      redeployBtn.addEventListener("click", () => startUpload());
      actions.appendChild(redeployBtn);

      const dismissFixBtn = document.createElement("button");
      dismissFixBtn.className = "upload-action-btn";
      dismissFixBtn.textContent = "Dismiss";
      dismissFixBtn.addEventListener("click", () => setUploadState("idle"));
      actions.appendChild(dismissFixBtn);
      break;
  }
}

function appendUploadLog(text) {
  const log = document.getElementById("upload-log");
  if (!log) return;
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
}

function fixUploadWithAI() {
  const log = document.getElementById("upload-log");
  const errorContext = log ? log.textContent.slice(-2000) : "";

  // Show a verbose summary of what's happening
  appendUploadLog("\n\n========================================\n");
  appendUploadLog("  AI FIX — Analyzing upload errors\n");
  appendUploadLog("========================================\n\n");

  if (lastUploadErrors.length > 0) {
    appendUploadLog("Errors detected:\n");
    lastUploadErrors.forEach((e, i) => {
      appendUploadLog(`  ${i + 1}. ${e.message}\n`);
      appendUploadLog(`     File: ${e.file}\n`);
      if (e.fixable) {
        appendUploadLog("     Status: Auto-fixable — AI will patch this\n");
      } else {
        appendUploadLog("     Status: Requires AI analysis\n");
      }
    });
    appendUploadLog("\n");
  }

  appendUploadLog("Sending errors to AI for diagnosis and repair...\n\n");

  setUploadState("ai_fixing");

  if (typeof ws !== "undefined" && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "upload_fix_with_ai", errorContext }));
  }
}

function handleUploadWsMessage(msg) {
  switch (msg.type) {
    case "upload_status":
      if (msg.phase === "autofix" && msg.fixes?.length > 0) {
        setUploadState("autofix");
        appendUploadLog("Auto-fixes applied:\n");
        msg.fixes.forEach((f) => appendUploadLog("  \u2713 " + f + "\n"));
        appendUploadLog("\n");
      }
      break;

    case "upload_started":
      uploadAttempt++;
      setUploadState("uploading");
      break;

    case "upload_output":
      appendUploadLog(msg.chunk);
      break;

    case "upload_complete":
      setUploadState("success");
      // Update status bar
      const statusText = document.getElementById("status-text");
      if (statusText) statusText.textContent = "Upload complete!";
      // Show celebration popup
      showDeploySuccessPopup(msg.portalId, msg.dataCenter || "na1", msg.themeName);
      break;

    case "upload_failed":
      lastUploadErrors = msg.errors || [];
      setUploadState("failed", { errors: msg.errors });
      appendUploadLog("\n--- Upload failed ---\n\n");
      if (msg.errors && msg.errors.length > 0) {
        appendUploadLog(`${msg.errors.length} error(s) found:\n`);
        msg.errors.forEach((e, i) => {
          appendUploadLog(`  ${i + 1}. \u2717 ${e.message}\n`);
          appendUploadLog(`     File: ${e.file}\n`);
        });
      } else {
        appendUploadLog("  Check the log above for details.\n");
      }
      appendUploadLog("\nClick \"Fix with AI\" to automatically diagnose and repair these issues.\n");
      break;

    case "upload_fix_started":
      setUploadState("ai_fixing");
      break;

    case "upload_fix_stream":
      // AI fix explanation streamed into the upload panel
      appendUploadLog(msg.content || "");
      break;

    case "upload_fix_complete":
      appendUploadLog("\n\n========================================\n");
      appendUploadLog("  Fix complete\n");
      appendUploadLog("========================================\n");
      lastUploadErrors = [];
      setUploadState("fix_done");
      break;
  }
}

function buildHubSpotPagesUrl(portalId, dataCenter) {
  const host = dataCenter === "eu1" ? "app-eu1.hubspot.com" : "app.hubspot.com";
  return `https://${host}/page-ui/${portalId}/management/pages/landing`;
}

function showDeploySuccessPopup(portalId, dataCenter, themeName) {
  lastUploadPortalId = portalId || "";
  lastUploadDataCenter = dataCenter || "na1";
  lastUploadThemeName = themeName || "";

  const name = themeName || "your theme";
  const lpLabel = `${name} Landing Page`;
  const pagesUrl = portalId ? buildHubSpotPagesUrl(portalId, dataCenter) : "";

  // Spawn confetti
  spawnConfetti();

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="deploy-success">
      <div class="deploy-success__icon">&#127881;</div>
      <h2 class="deploy-success__title">Theme deployed!</h2>
      <p class="deploy-success__subtitle">"${esc(name)}" is now live on HubSpot.</p>
      <div class="deploy-success__steps">
        <div class="deploy-success__step"><span class="deploy-success__num">1</span> Go to <strong>Content &rarr; Landing Pages</strong></div>
        <div class="deploy-success__step"><span class="deploy-success__num">2</span> Click <strong>"Create" &rarr; "Landing page"</strong></div>
        <div class="deploy-success__step"><span class="deploy-success__num">3</span> Select the <strong>"${esc(lpLabel)}"</strong> template</div>
      </div>
      <div class="deploy-success__actions">
        ${pagesUrl ? `<a href="${pagesUrl}" target="_blank" class="btn btn--primary deploy-success__link">Create Page in HubSpot &rarr;</a>` : ""}
        <button class="btn btn--secondary" id="deploy-success-dismiss">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("deploy-success-dismiss").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function spawnConfetti() {
  const colors = ["#e8613a", "#f2825f", "#4ade80", "#f59e0b", "#818cf8", "#fb7185"];
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:10000;overflow:hidden";
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.6;
    const size = 6 + Math.random() * 6;
    const drift = (Math.random() - 0.5) * 120;
    piece.style.cssText = `
      position:absolute;top:-10px;left:${left}%;
      width:${size}px;height:${size * 0.6}px;
      background:${color};border-radius:2px;
      animation:confettiFall ${1.8 + Math.random() * 1.2}s ease-out ${delay}s forwards;
      --drift:${drift}px;
    `;
    container.appendChild(piece);
  }

  // Inject keyframes once
  if (!document.getElementById("confetti-style")) {
    const style = document.createElement("style");
    style.id = "confetti-style";
    style.textContent = `
      @keyframes confettiFall {
        0% { transform: translateY(0) translateX(0) rotate(0deg); opacity: 1; }
        100% { transform: translateY(100vh) translateX(var(--drift)) rotate(720deg); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => container.remove(), 4000);
}

// Toggle panel collapse
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("upload-panel-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const log = document.getElementById("upload-log");
      if (log) log.classList.toggle("collapsed");
      toggle.classList.toggle("flipped");
    });
  }
});
