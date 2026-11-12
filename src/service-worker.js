"use strict";

importScripts("parsers.js");

const STATE_PREFIX = "caption-state:";
const COMMENT_STATE_PREFIX = "comment-copy-state:";

const TRANSCRIBE_MODEL = "gpt-transcribe";
const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const API_KEY_STORAGE = "openaiApiKey";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function stateKey(tabId) {
  return `${STATE_PREFIX}${tabId}`;
}

function commentStateKey(tabId) {
  return `${COMMENT_STATE_PREFIX}${tabId}`;
}

async function getState(tabId) {
  const result = await chrome.storage.session.get(stateKey(tabId));
  return result[stateKey(tabId)] || null;
}

async function getCommentCopyState(tabId) {
  const result = await chrome.storage.session.get(commentStateKey(tabId));
  return result[commentStateKey(tabId)] || null;
}

async function broadcast(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The side panel may be closed.
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function getApiKey() {
  const stored = await chrome.storage.local.get(API_KEY_STORAGE);
  return String(stored[API_KEY_STORAGE] || "").trim();
}

// Sends one audio slice (base64 fragmented MP4) to OpenAI. The API key never
// leaves the service worker.
async function transcribeChunk(message) {
  try {
    const apiKey = await getApiKey();
    if (!apiKey) return { success: false, code: "NO_KEY", error: "尚未设置 OpenAI API Key" };
    const binary = atob(String(message.audio || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/mp4" }), "audio.m4a");
    form.append("model", TRANSCRIBE_MODEL);
    if (message.prompt) form.append("prompt", String(message.prompt).slice(0, 1000));
    const response = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const data = await response.json().catch(() => null);
    if (response.ok) return { success: true, text: String(data?.text || "") };
    const outOfQuota = data?.error?.code === "insufficient_quota";
    return {
      success: false,
      code: response.status === 401 ? "BAD_KEY" : `HTTP_${response.status}`,
      retryable: !outOfQuota && (response.status === 408 || response.status === 429 || response.status >= 500),
      error: response.status === 401
        ? "OpenAI API Key 无效"
        : outOfQuota
          ? "OpenAI 账户额度不足"
          : data?.error?.message || `OpenAI HTTP ${response.status}`
    };
  } catch (error) {
    return { success: false, code: "NETWORK", retryable: true, error: `无法连接 OpenAI：${error.message}` };
  }
}

function isBilibiliSender(sender) {
  try {
    const { protocol, hostname } = new URL(sender.url || "");
    return protocol === "https:" && (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com"));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AI_TRANSCRIBE_CHUNK" && sender.tab?.id != null && isBilibiliSender(sender)) {
    transcribeChunk(message).then(sendResponse);
    return true;
  }

  if (message?.type === "AI_HAS_KEY") {
    getApiKey()
      .then((apiKey) => sendResponse({ hasKey: Boolean(apiKey) }))
      .catch(() => sendResponse({ hasKey: false }));
    return true;
  }

  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "CAPTIONS_UPDATED" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    chrome.storage.session.set({ [stateKey(tabId)]: message.state })
      .then(() => broadcast({ type: "CAPTIONS_BROADCAST", tabId, state: message.state }))
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "PLAYBACK_TIME" && sender.tab?.id != null) {
    broadcast({
      type: "PLAYBACK_BROADCAST",
      tabId: sender.tab.id,
      currentMs: message.currentMs,
      paused: message.paused
    });
    return;
  }

  if (message?.type === "COMMENTS_COPY_STATE" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    chrome.storage.session.set({ [commentStateKey(tabId)]: message.state })
      .then(() => broadcast({ type: "COMMENTS_COPY_STATE", tabId, state: message.state }))
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_ACTIVE_STATE") {
    (async () => {
      const tab = sender.tab || await getActiveTab();
      sendResponse({
        tabId: tab?.id ?? null,
        state: tab?.id != null ? await getState(tab.id) : null,
        commentCopyState: tab?.id != null ? await getCommentCopyState(tab.id) : null
      });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "FETCH_BILIBILI_SUBTITLE") {
    (async () => {
      if (!globalThis.CaptionLiteParsers.isAllowedBilibiliSubtitleUrl(message.url)) {
        throw new Error("字幕地址不受信任");
      }
      const response = await fetch(message.url, {
        credentials: "omit",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`字幕文件 HTTP ${response.status}`);
      sendResponse({ success: true, data: await response.json() });
    })().catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if ((message?.type === "SEEK"
      || message?.type === "REFRESH_CAPTIONS"
      || message?.type === "COPY_BILIBILI_COMMENTS"
      || message?.type === "START_AI_TRANSCRIBE"
      || message?.type === "CANCEL_AI_TRANSCRIBE")
      && Number.isInteger(message.tabId)) {
    chrome.tabs.sendMessage(message.tabId, message)
      .then((response) => sendResponse(response || { success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await broadcast({
    type: "ACTIVE_TAB_STATE",
    tabId,
    state: await getState(tabId),
    commentCopyState: await getCommentCopyState(tabId)
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await chrome.storage.session.remove([stateKey(tabId), commentStateKey(tabId)]);
  const activeTab = await getActiveTab();
  if (activeTab?.id === tabId) {
    await broadcast({ type: "ACTIVE_TAB_STATE", tabId, state: null, commentCopyState: null });
  }
  await chrome.tabs.sendMessage(tabId, { type: "BILIBILI_NAVIGATION" }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([stateKey(tabId), commentStateKey(tabId)]).catch(() => {});
});

function notifyBilibiliNavigation(details) {
  if (details.frameId !== 0) return;
  chrome.tabs.sendMessage(details.tabId, { type: "BILIBILI_NAVIGATION" }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(notifyBilibiliNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(notifyBilibiliNavigation);
