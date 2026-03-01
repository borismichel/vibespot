/**
 * Upload panel — slide-up log for live hs upload output
 */

let uploadState = "idle";
let uploadAttempt = 0;
let lastUploadErrors = [];
const MAX_UPLOAD_ATTEMPTS = 3;

function startUpload() {
  if (uploadState === "uploading" || uploadState === "ai_fixing") return;

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
