(() => {
  "use strict";

  if (window.__captionLiteBilibiliMain) return;
  window.__captionLiteBilibiliMain = true;

  const PAGE_SOURCE = "caption-lite-page";
  const EXTENSION_SOURCE = "caption-lite-extension";
  const {
    appendChildReplies,
    extractWbiKeys,
    formatCommentThreads,
    normalizeRootReply,
    signWbiParams
  } = globalThis.CaptionLiteBilibiliComments;
  let requestId = 0;
  let commentRequestId = 0;
  let commentPageKey = "";
  let commentAbortController = null;
  let lastPageKey = "";

  function getIdentity() {
    const url = new URL(location.href);
    const videoId = url.pathname.match(/\/video\/(BV[^/?]+|av\d+)/i)?.[1];
    if (!videoId) return null;
    const pageNumber = Math.max(1, Number(url.searchParams.get("p")) || 1);
    return { videoId, pageNumber, pageKey: `${videoId}:${pageNumber}` };
  }

  function post(payload) {
    window.postMessage({ source: PAGE_SOURCE, type: "BILIBILI_CAPTIONS", payload }, "*");
  }

  function postComments(type, payload) {
    window.postMessage({ source: PAGE_SOURCE, type, payload }, "*");
  }

  async function fetchJson(url, { signal } = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (typeof data?.code === "number" && data.code !== 0) {
      throw new Error(data.message || `Bilibili API ${data.code}`);
    }
    return data;
  }

  async function fetchWbiKeys(signal) {
    const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`WBI 密钥 HTTP ${response.status}`);
    const { data } = await response.json();
    return extractWbiKeys(data?.wbi_img);
  }

  function absoluteUrl(url) {
    if (url.startsWith("//")) return `https:${url}`;
    return new URL(url, location.href).toString();
  }

  function commentCount(threads) {
    return threads.reduce((total, thread) => total + 1 + thread.replies.length, 0);
  }

  function isCurrentCommentRequest(currentRequest, pageKey) {
    return currentRequest === commentRequestId && getIdentity()?.pageKey === pageKey;
  }

  function invalidateCommentRequest(nextPageKey = "") {
    commentRequestId += 1;
    commentPageKey = nextPageKey;
    commentAbortController?.abort();
    commentAbortController = null;
  }

  function cancelledCommentResult(pageKey) {
    return { pageKey, error: "评论任务已取消", cancelled: true };
  }

  async function loadChildReplies({ aid, currentRequest, identity, signal, thread }) {
    const pageSize = 20;
    for (let pageNumber = 1; ; pageNumber += 1) {
      const url = new URL("https://api.bilibili.com/x/v2/reply/reply");
      url.search = new URLSearchParams({
        oid: String(aid),
        type: "1",
        root: thread.id,
        pn: String(pageNumber),
        ps: String(pageSize)
      }).toString();
      const response = await fetchJson(url, { signal });
      if (!isCurrentCommentRequest(currentRequest, identity.pageKey)) return false;
      appendChildReplies(thread, response.data?.replies || []);
      const total = Math.max(0, Number(response.data?.page?.count) || 0);
      if (pageNumber * pageSize >= total) return true;
    }
  }

  async function loadAllComments() {
    const identity = getIdentity();
    if (!identity) return;
    invalidateCommentRequest(identity.pageKey);
    const abortController = new AbortController();
    commentAbortController = abortController;
    const { signal } = abortController;
    const currentRequest = ++commentRequestId;
    postComments("BILIBILI_COMMENTS_PROGRESS", {
      pageKey: identity.pageKey,
      count: 0
    });

    try {
      const idKey = identity.videoId.toLowerCase().startsWith("av") ? "aid" : "bvid";
      const idValue = idKey === "aid" ? identity.videoId.slice(2) : identity.videoId;
      const view = await fetchJson(
        `https://api.bilibili.com/x/web-interface/view?${idKey}=${encodeURIComponent(idValue)}`,
        { signal }
      );
      if (!isCurrentCommentRequest(currentRequest, identity.pageKey)) {
        return cancelledCommentResult(identity.pageKey);
      }
      const aid = view.data?.aid;
      if (!aid) throw new Error("无法确定视频 aid");

      const { imgKey, subKey } = await fetchWbiKeys(signal);
      if (!isCurrentCommentRequest(currentRequest, identity.pageKey)) {
        return cancelledCommentResult(identity.pageKey);
      }
      const threads = [];
      const rootIds = new Set();
      let offset = "";
      let firstPage = true;

      for (;;) {
        const params = signWbiParams({
          oid: aid,
          type: 1,
          mode: 3,
          plat: 1,
          seek_rpid: "",
          pagination_str: JSON.stringify({ offset }),
          web_location: 1315875
        }, imgKey, subKey);
        const response = await fetchJson(
          `https://api.bilibili.com/x/v2/reply/wbi/main?${params.toString()}`,
          { signal }
        );
        if (!isCurrentCommentRequest(currentRequest, identity.pageKey)) {
          return cancelledCommentResult(identity.pageKey);
        }
        const data = response.data || {};
        const replies = [
          ...(firstPage && Array.isArray(data.top_replies) ? data.top_replies : []),
          ...(Array.isArray(data.replies) ? data.replies : [])
        ];
        firstPage = false;
        replies.forEach((reply) => {
          const thread = normalizeRootReply(reply);
          if (!thread.id || rootIds.has(thread.id)) return;
          rootIds.add(thread.id);
          threads.push(thread);
        });
        postComments("BILIBILI_COMMENTS_PROGRESS", {
          pageKey: identity.pageKey,
          count: commentCount(threads)
        });

        if (data.cursor?.is_end) break;
        const nextOffset = data.cursor?.pagination_reply?.next_offset;
        if (!nextOffset || nextOffset === offset) {
          throw new Error("Bilibili 评论分页游标无效");
        }
        offset = nextOffset;
      }

      for (const thread of threads) {
        if (thread.replyCount > thread.replies.length) {
          const completed = await loadChildReplies({
            aid,
            currentRequest,
            identity,
            signal,
            thread
          });
          if (!completed) return cancelledCommentResult(identity.pageKey);
          postComments("BILIBILI_COMMENTS_PROGRESS", {
            pageKey: identity.pageKey,
            count: commentCount(threads)
          });
        }
      }

      const count = commentCount(threads);
      return {
        pageKey: identity.pageKey,
        count,
        text: formatCommentThreads(threads)
      };
    } catch (error) {
      return {
        pageKey: identity.pageKey,
        error: !isCurrentCommentRequest(currentRequest, identity.pageKey)
          ? "评论任务已取消"
          : error instanceof Error ? error.message : "评论读取失败",
        cancelled: !isCurrentCommentRequest(currentRequest, identity.pageKey)
      };
    } finally {
      if (commentAbortController === abortController) commentAbortController = null;
    }
  }

  async function load(force = false) {
    const identity = getIdentity();
    if (!identity) return;
    if (commentPageKey && identity.pageKey !== commentPageKey) {
      invalidateCommentRequest(identity.pageKey);
    }
    if (!force && identity.pageKey === lastPageKey) return;
    lastPageKey = identity.pageKey;
    const currentRequest = ++requestId;
    post({ ...identity, status: "loading" });

    try {
      const idKey = identity.videoId.toLowerCase().startsWith("av") ? "aid" : "bvid";
      const idValue = idKey === "aid" ? identity.videoId.slice(2) : identity.videoId;
      const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${idKey}=${encodeURIComponent(idValue)}`);
      const video = view.data;
      const page = video.pages?.find((item) => item.page === identity.pageNumber) || video.pages?.[0];
      if (!video?.aid || !page?.cid) throw new Error("无法确定视频 aid/cid");

      const player = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?aid=${video.aid}&cid=${page.cid}`);
      const subtitles = player.data?.subtitle?.subtitles?.filter((item) => item.subtitle_url) || [];
      const tracks = subtitles.map((subtitle, index) => ({
        id: `${subtitle.lan || "unknown"}:${subtitle.id ?? index}`,
        language: subtitle.lan || "unknown",
        label: subtitle.lan_doc || subtitle.lan || `字幕 ${index + 1}`,
        url: absoluteUrl(subtitle.subtitle_url)
      }));

      if (currentRequest !== requestId) return;
      post({
        ...identity,
        status: tracks.length ? "ready" : "empty",
        title: video.title || document.title,
        needLogin: Boolean(player.data?.need_login_subtitle),
        viewPoints: player.data?.view_points || [],
        tracks
      });
    } catch (error) {
      if (currentRequest !== requestId) return;
      post({
        ...identity,
        status: "error",
        error: error instanceof Error ? error.message : "未知错误",
        tracks: []
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== EXTENSION_SOURCE) return;
    if (event.data?.type === "LOAD_BILIBILI") load(true);
  });

  globalThis.CaptionLiteBilibiliCommentLoader = { loadAllComments };

  setInterval(() => load(false), 500);
})();
