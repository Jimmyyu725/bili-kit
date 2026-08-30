"use strict";

importScripts("parsers.js");

const STATE_PREFIX = "caption-state:";
const COMMENT_STATE_PREFIX = "comment-copy-state:";

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      || message?.type === "COPY_BILIBILI_COMMENTS")
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
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([stateKey(tabId), commentStateKey(tabId)]).catch(() => {});
});
