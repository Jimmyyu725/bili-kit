(() => {
  "use strict";

  const {
    appendChildReplies,
    extractWbiKeys,
    formatCommentThreads,
    normalizeRootReply,
    signWbiParams
  } = globalThis.CaptionLiteBilibiliComments;

  function commentCount(threads) {
    return threads.reduce((total, thread) => total + 1 + thread.replies.length, 0);
  }

  async function fetchJson(fetchImpl, url, signal) {
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (Number(data?.code) !== 0) {
      throw new Error(data?.message || data?.msg || `Bilibili 错误 ${data?.code}`);
    }
    return data;
  }

  async function fetchWbiKeys(fetchImpl, signal) {
    const response = await fetchImpl("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`WBI 密钥 HTTP ${response.status}`);
    const { data } = await response.json();
    return extractWbiKeys(data?.wbi_img);
  }

  function cancelledResult(pageKey) {
    return { pageKey, error: "评论任务已取消", cancelled: true };
  }

  async function loadChildReplies({
    aid,
    fetchImpl,
    isCurrent,
    signal,
    thread
  }) {
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
      const response = await fetchJson(fetchImpl, url, signal);
      if (!isCurrent()) return false;
      appendChildReplies(thread, response.data?.replies || []);
      const total = Math.max(0, Number(response.data?.page?.count) || 0);
      if (pageNumber * pageSize >= total) return true;
    }
  }

  async function loadAllComments({
    fetchImpl = fetch,
    isCurrent = () => true,
    onProgress = () => {},
    pageKey,
    signal,
    videoId
  }) {
    onProgress(0);
    try {
      const idKey = String(videoId).toLowerCase().startsWith("av") ? "aid" : "bvid";
      const idValue = idKey === "aid" ? String(videoId).slice(2) : String(videoId);
      const view = await fetchJson(
        fetchImpl,
        `https://api.bilibili.com/x/web-interface/view?${idKey}=${encodeURIComponent(idValue)}`,
        signal
      );
      if (!isCurrent()) return cancelledResult(pageKey);
      const aid = view.data?.aid;
      if (!aid) throw new Error("无法确定视频 aid");

      const { imgKey, subKey } = await fetchWbiKeys(fetchImpl, signal);
      if (!isCurrent()) return cancelledResult(pageKey);

      const threads = [];
      const rootIds = new Set();
      const seenOffsets = new Set();
      let offset = "";
      let firstPage = true;

      while (true) {
        const params = signWbiParams({
          oid: aid,
          type: 1,
          mode: 3,
          pagination_str: JSON.stringify({ offset }),
          plat: 1,
          seek_rpid: "",
          web_location: 1315875
        }, imgKey, subKey);
        const response = await fetchJson(
          fetchImpl,
          `https://api.bilibili.com/x/v2/reply/wbi/main?${params.toString()}`,
          signal
        );
        if (!isCurrent()) return cancelledResult(pageKey);

        const data = response.data || {};
        const replies = [
          ...(firstPage && Array.isArray(data.top_replies) ? data.top_replies : []),
          ...(Array.isArray(data.replies) ? data.replies : [])
        ];
        firstPage = false;
        for (const rawReply of replies) {
          const thread = normalizeRootReply(rawReply);
          if (!thread.id || rootIds.has(thread.id)) continue;
          rootIds.add(thread.id);
          threads.push(thread);
        }
        onProgress(commentCount(threads));

        if (data.cursor?.is_end) break;
        const nextOffset = String(data.cursor?.pagination_reply?.next_offset ?? "");
        if (!nextOffset || seenOffsets.has(nextOffset)) {
          throw new Error("评论分页游标异常");
        }
        seenOffsets.add(nextOffset);
        offset = nextOffset;
      }

      for (const thread of threads) {
        if (thread.replyCount <= thread.replies.length) continue;
        const completed = await loadChildReplies({
          aid,
          fetchImpl,
          isCurrent,
          signal,
          thread
        });
        if (!completed) return cancelledResult(pageKey);
        onProgress(commentCount(threads));
      }

      return {
        pageKey,
        count: commentCount(threads),
        text: formatCommentThreads(threads)
      };
    } catch (error) {
      if (!isCurrent() || signal?.aborted) return cancelledResult(pageKey);
      return {
        pageKey,
        error: error instanceof Error ? error.message : "评论读取失败"
      };
    }
  }

  globalThis.CaptionLiteBilibiliCommentLoader = { loadAllComments };
})();
