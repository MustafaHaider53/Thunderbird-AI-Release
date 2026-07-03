/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

var { AiReplyService } = ChromeUtils.importESModule(
  "resource:///modules/AiReplyService.sys.mjs"
);

var gEmailData = null;
var gGeneratedReply = "";
var gLogs = [];
var gRegenTimer = null;

function log(msg, type = "INFO") {
  const entry = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
  gLogs.push(entry);
  console.log("AI Reply:", entry);
  
  const logTextarea = document.getElementById("aiErrorLogText");
  if (logTextarea) {
    logTextarea.value = gLogs.join("\n");
  }
}

function onLoad() {
  log("Initializing AI Reply Dialog");
  window.focus();
  gEmailData = window.arguments?.[0];
  if (!gEmailData) {
    log("No email data provided in window.arguments", "ERROR");
    showError("No email data provided. Please close and try again.");
    return;
  }
  
  log(`Context: Subject="${gEmailData.subject}", Sender="${gEmailData.sender}"`);
  if (!gEmailData.contextMessages || gEmailData.contextMessages.length === 0) {
    const chk = document.getElementById("aiIncludeContextChk");
    if (chk) {
      chk.disabled = true;
      chk.checked = false;
    }
    const lbl = document.getElementById("aiContextLabel");
    if (lbl) {
       lbl.style.opacity = "0.5";
       lbl.setAttribute("title", "No previous emails found in this thread.");
    }
    log("No thread context messages available.");
  } else {
    const lbl = document.getElementById("aiContextLabel");
    if (lbl) {
       lbl.setAttribute("title", `Includes ${gEmailData.contextMessages.length} previous email(s).`);
    }
    log(`Thread context available: ${gEmailData.contextMessages.length} messages.`);
  }

  let savedPrompt = "";
  let rememberPrompt = false;
  try {
    rememberPrompt = Services.prefs.getBoolPref("mail.ai_reply.remember_instruction", false);
    if (rememberPrompt) {
      savedPrompt = Services.prefs.getStringPref("mail.ai_reply.persistent_instruction", "");
    }
  } catch (err) {
    log(`Failed to read persistent instruction prefs: ${err.message}`, "WARNING");
  }

  const promptInput = document.getElementById("aiPromptInput");
  const rememberChk = document.getElementById("aiPersistentPromptChk");
  if (rememberChk) {
    rememberChk.checked = rememberPrompt;
  }
  if (promptInput && savedPrompt) {
    promptInput.value = savedPrompt;
  }

  generateReply(savedPrompt);
  
  setTimeout(() => {
    document.getElementById("aiPromptInput").focus();
  }, 500);
}

async function generateReply(customPrompt = "") {
  showLoading(true);
  hideError();
  
  const includeContext = document.getElementById("aiIncludeContextChk")?.checked ?? false;
  const provider = document.getElementById("aiEngineSelect")?.value || "auto";

  const options = {
    customPrompt: customPrompt,
    tone: document.getElementById("aiToneSelect")?.value || "auto",
    length: document.getElementById("aiLengthSelect")?.value || "auto",
    language: document.getElementById("aiLanguageSelect")?.value || "auto",
    salutation: document.getElementById("aiSalutationSelect")?.value || "auto",
    signature: document.getElementById("aiSignatureSelect")?.value || "auto",
    contextMessages: includeContext ? (gEmailData.contextMessages || []) : [],
    provider: provider,
    progressCallback: (progressData) => {
      const loadingText = document.getElementById("aiReplyLoadingText");
      const progressContainer = document.getElementById("aiReplyProgressContainer");
      const progressBar = document.getElementById("aiReplyProgressBar");
      const progressPercent = document.getElementById("aiReplyProgressPercent");

      if (progressData && progressData.statusText) {
        log(`[Local AI] ${progressData.statusText}`, "INFO");
        if (loadingText) {
          loadingText.textContent = `Local AI: ${progressData.statusText}...`;
        }
        if (progressData.statusText === "done" && progressContainer) {
          progressContainer.classList.add("hidden");
          if (loadingText) {
            loadingText.textContent = "Synthesizing response...";
          }
        }
      } else if (progressData && progressData.type === "progress") {
        const percent = (progressData.loaded / progressData.total * 100).toFixed(1);
        log(`[Local AI] Downloading weights: ${percent}% (${(progressData.loaded / 1024 / 1024).toFixed(1)}MB / ${(progressData.total / 1024 / 1024).toFixed(1)}MB)`, "INFO");
        
        if (progressContainer) {
          progressContainer.classList.remove("hidden");
        }
        if (loadingText) {
          loadingText.textContent = "Downloading Local AI Model...";
        }
        if (progressBar) {
          progressBar.style.width = `${percent}%`;
        }
        if (progressPercent) {
          progressPercent.textContent = `${percent}% (${(progressData.loaded / 1024 / 1024).toFixed(1)}MB / ${(progressData.total / 1024 / 1024).toFixed(1)}MB)`;
        }
      } else if (progressData && progressData.type === "status") {
        log(`[Local AI] Status: ${progressData.statusText}`, "INFO");
        if (loadingText) {
          loadingText.textContent = `Local AI: ${progressData.statusText}...`;
        }
      }
    }
  };
  
  log(`Generation starting, options: ${JSON.stringify({ ...options, progressCallback: undefined })}`);

  try {
    const start = Date.now();
    const [reply, summary] = await Promise.all([
      AiReplyService.generateReply(
        gEmailData.body,
        gEmailData.subject,
        gEmailData.sender,
        options
      ),
      !document.getElementById("aiSummaryText").textContent
        ? AiReplyService.generateSummary(gEmailData.body, { provider, progressCallback: options.progressCallback })
        : Promise.resolve(null),
    ]);

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    log(`Generation successful (${duration}s)`);

    gGeneratedReply = reply;
    document.getElementById("aiReplyText").value = reply;
    document.getElementById("aiUseReplyBtn").disabled = false;

    if (summary) {
      log("Summary received");
      document.getElementById("aiSummaryText").textContent = summary;
      document.getElementById("aiReplySummary").classList.remove("hidden");
    }

    showLoading(false);
    document.getElementById("aiReplyBody").classList.remove("hidden");
  } catch (e) {
    showLoading(false);
    log(`Generation failed: ${e.message}`, "ERROR");
    if (e.stack) log(`Stack trace: ${e.stack}`, "DEBUG");
    
    showError(e.message || "An unexpected error occurred during generation.");
  }
}

function onRegenerate() {
  const prompt = document.getElementById("aiPromptInput").value.trim();
  const rememberChk = document.getElementById("aiPersistentPromptChk");
  
  if (rememberChk && rememberChk.checked) {
    try {
      Services.prefs.setBoolPref("mail.ai_reply.remember_instruction", true);
      Services.prefs.setStringPref("mail.ai_reply.persistent_instruction", prompt);
      log(`Saved persistent instruction: "${prompt}"`);
    } catch (err) {
      log(`Failed to save persistent instruction: ${err.message}`, "ERROR");
    }
  }
  
  generateReply(prompt);
}

function onRegenDebounced() {
  clearTimeout(gRegenTimer);
  gRegenTimer = setTimeout(onRegenerate, 600);
}

function onUseReply() {
  const replyText = document.getElementById("aiReplyText").value;
  log(`Using reply text (length: ${replyText.length})`);
  if (window.arguments?.[1]) {
    window.arguments[1].result = replyText;
  } else {
    log("window.arguments[1] is missing, cannot return result", "ERROR");
  }
  window.close();
}

function onCancel() {
  log("User cancelled dialog");
  if (window.arguments?.[1]) {
    window.arguments[1].result = null;
  }
  window.close();
}

function onShowLogs() {
  const panel = document.getElementById("aiLogPanel");
  panel.classList.toggle("hidden");
  document.getElementById("aiShowLogsBtn").textContent = 
    panel.classList.contains("hidden") ? "Show Error Details" : "Hide Error Details";
}

function onCopyLogs() {
  const logText = gLogs.join("\n");
  const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
  clipboard.copyString(logText);
  
  const btn = document.getElementById("aiCopyLogsBtn");
  const originalText = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = originalText; }, 2000);
}

function showLoading(visible) {
  document.getElementById("aiReplyLoading").classList.toggle("hidden", !visible);
  document.getElementById("aiRegenerateBtn").disabled = visible;
}

function showError(msg) {
  const el = document.getElementById("aiReplyError");
  document.getElementById("aiErrorMessage").textContent = msg;
  el.classList.remove("hidden");
}

function hideError() {
  document.getElementById("aiReplyError").classList.add("hidden");
  document.getElementById("aiLogPanel").classList.add("hidden");
  document.getElementById("aiShowLogsBtn").textContent = "Show Error Details";
}

window.addEventListener("load", () => {
  onLoad();
  
  // Base controls
  document.getElementById("aiRegenerateBtn").addEventListener("click", onRegenerate);
  document.getElementById("aiCancelBtn").addEventListener("click", onCancel);
  document.getElementById("aiUseReplyBtn").addEventListener("click", onUseReply);
  
  // Log controls
  document.getElementById("aiShowLogsBtn").addEventListener("click", onShowLogs);
  document.getElementById("aiCopyLogsBtn").addEventListener("click", onCopyLogs);
  
  // Input fields
  document.getElementById("aiPromptInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      onRegenerate();
    }
  });

  // Personalization triggers
  ["aiEngineSelect", "aiToneSelect", "aiLengthSelect", "aiLanguageSelect", "aiSalutationSelect", "aiSignatureSelect"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("mousedown", () => window.focus());
    el.addEventListener("change", onRegenDebounced);
  });
  document.getElementById("aiIncludeContextChk").addEventListener("change", onRegenerate);

  const rememberChk = document.getElementById("aiPersistentPromptChk");
  if (rememberChk) {
    rememberChk.addEventListener("change", (e) => {
      const checked = e.target.checked;
      const promptValue = document.getElementById("aiPromptInput").value.trim();
      
      try {
        Services.prefs.setBoolPref("mail.ai_reply.remember_instruction", checked);
        if (checked) {
          Services.prefs.setStringPref("mail.ai_reply.persistent_instruction", promptValue);
          log(`Enabled persistent instructions: "${promptValue}"`);
        } else {
          Services.prefs.setStringPref("mail.ai_reply.persistent_instruction", "");
          log("Disabled persistent instructions");
        }
      } catch (err) {
        log(`Failed to save persistent instructions: ${err.message}`, "ERROR");
      }
    });
  }
});
