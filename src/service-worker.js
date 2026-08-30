"use strict";

importScripts(
  "parsers.js",
  "bilibili-comments.js",
  "bilibili-comment-loader.js",
  "comment-job-registry.js"
);

const STATE_PREFIX = "caption-state:";
const COMMENT_STATE_PREFIX = "comment-copy-state:";
const commentJobs = globalThis.CaptionLiteCommentJobs.createRegistry();

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

function getBilibiliIdentity(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.hostname !== "bilibili.com" && !url.hostname.endsWith(".bilibili.com")) return null;
    const videoId = url.pathname.match(/\/video\/(BV[^/?]+|av\d+)/i)?.[1];
    if (!videoId) return null;
    const pageNumber = Math.max(1, Number(url.searchParams.get("p")) || 1);
    return { videoId, pageKey: `${videoId}:${pageNumber}` };
  } catch {
    return null;
  }
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

  if (message?.type === "FETCH_BILIBILI_COMMENTS" && sender.tab?.id != null) {
    (async () => {
      const tabId = sender.tab.id;
      const identity = getBilibiliIdentity(sender.tab.url);
      if (!identity || identity.pageKey !== message.pageKey) {
        sendResponse({ success: false, error: "当前 Bilibili 视频已变化" });
        return;
      }

      const job = commentJobs.begin(tabId);
      try {
        const result = await globalThis.CaptionLiteBilibiliCommentLoader.loadAllComments({
          pageKey: identity.pageKey,
          videoId: identity.videoId,
          signal: job.signal,
          isCurrent: job.isCurrent,
          onProgress(count) {
            if (!job.isCurrent()) return;
            chrome.tabs.sendMessage(tabId, {
              type: "BILIBILI_COMMENTS_PROGRESS",
              payload: { pageKey: identity.pageKey, count }
            }).catch(() => {});
          }
        });

        const currentTab = await chrome.tabs.get(tabId);
        const currentIdentity = getBilibiliIdentity(currentTab.url);
        if (!job.isCurrent() || currentIdentity?.pageKey !== identity.pageKey) {
          sendResponse({ success: false, error: "评论任务已取消" });
          return;
        }
        if (!result || result.error) {
          sendResponse({ success: false, error: result?.error || "评论读取失败" });
          return;
        }
        sendResponse({ success: true, ...result });
      } finally {
        commentJobs.complete(job);
      }
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
  commentJobs.invalidate(tabId);
  await chrome.storage.session.remove([stateKey(tabId), commentStateKey(tabId)]);
  const activeTab = await getActiveTab();
  if (activeTab?.id === tabId) {
    await broadcast({ type: "ACTIVE_TAB_STATE", tabId, state: null, commentCopyState: null });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  commentJobs.invalidate(tabId);
  chrome.storage.session.remove([stateKey(tabId), commentStateKey(tabId)]).catch(() => {});
});

function invalidateCommentJobForNavigation(details) {
  if (details.frameId === 0) commentJobs.invalidate(details.tabId);
}

chrome.webNavigation.onCommitted.addListener(invalidateCommentJobForNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(invalidateCommentJobForNavigation);
