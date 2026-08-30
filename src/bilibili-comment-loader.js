(() => {
  "use strict";

  const {
    appendChildReplies,
    extractWbiKeys,
    formatCommentThreads,
    normalizeRootReply,
    signWbiParams
  } = globalThis.CaptionLiteBilibiliComments;
  const RETRY_DELAYS = [2000, 4000, 8000, 15000, 30000];

  function commentCount(threads) {
    return threads.reduce((total, thread) => total + 1 + thread.replies.length, 0);
  }

  function createSnapshot(pageKey, threads, { complete = false, phase = "roots" } = {}) {
    return {
      pageKey,
      count: commentCount(threads),
      text: formatCommentThreads(threads),
      complete,
      phase
    };
  }

  function retryDelay(attempt) {
    return RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
  }

  async function defaultWait(milliseconds, signal) {
    if (signal?.aborted) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(false);
      }, { once: true });
    });
  }

  async function fetchJson(fetchImpl, url, signal) {
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      throw error;
    }
    const data = await response.json();
    if (Number(data?.code) !== 0) {
      const error = new Error(data?.message || data?.msg || `Bilibili 错误 ${data?.code}`);
      error.retryable = ![-400, -404].includes(Number(data?.code));
      throw error;
    }
    return data;
  }

  async function fetchWbiKeys(fetchImpl, signal) {
    const response = await fetchImpl("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) {
      const error = new Error(`WBI 密钥 HTTP ${response.status}`);
      error.retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      throw error;
    }
    const { data } = await response.json();
    return extractWbiKeys(data?.wbi_img);
  }

  function cancelledResult(pageKey) {
    return { pageKey, error: "评论任务已取消", cancelled: true };
  }

  async function requestWithRetry(operation, {
    getSnapshot,
    isCurrent,
    onRetry,
    phase,
    signal,
    wait
  }) {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (error?.retryable === false) throw error;
        const delay = retryDelay(attempt);
        attempt += 1;
        onRetry({
          ...getSnapshot(),
          delay,
          error: error instanceof Error ? error.message : "网络请求失败",
          phase,
          reason: "request"
        });
        const shouldContinue = await wait(delay, signal);
        if (!shouldContinue || !isCurrent()) throw new Error("评论任务已取消");
      }
    }
  }

  async function loadChildReplies({
    aid,
    fetchImpl,
    getSnapshot,
    isCurrent,
    onBatch,
    onRetry,
    pageKey,
    signal,
    thread,
    wait
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
      const response = await requestWithRetry(
        () => fetchJson(fetchImpl, url, signal),
        { getSnapshot, isCurrent, onRetry, pageKey, phase: "replies", signal, wait }
      );
      if (!isCurrent()) return false;
      appendChildReplies(thread, response.data?.replies || []);
      onBatch();
      const total = Math.max(0, Number(response.data?.page?.count) || 0);
      if (pageNumber * pageSize >= total) return true;
    }
  }

  async function loadAllComments({
    fetchImpl = fetch,
    isCurrent = () => true,
    onProgress = () => {},
    onRetry = () => {},
    onSnapshot = () => {},
    pageKey,
    signal,
    videoId,
    wait = defaultWait
  }) {
    onProgress(0);
    try {
      const threads = [];
      const getSnapshot = (phase = "roots") => createSnapshot(pageKey, threads, { phase });
      const idKey = String(videoId).toLowerCase().startsWith("av") ? "aid" : "bvid";
      const idValue = idKey === "aid" ? String(videoId).slice(2) : String(videoId);
      const view = await requestWithRetry(
        () => fetchJson(
          fetchImpl,
          `https://api.bilibili.com/x/web-interface/view?${idKey}=${encodeURIComponent(idValue)}`,
          signal
        ),
        { getSnapshot, isCurrent, onRetry, phase: "roots", signal, wait }
      );
      if (!isCurrent()) return cancelledResult(pageKey);
      const aid = view.data?.aid;
      if (!aid) throw new Error("无法确定视频 aid");

      const { imgKey, subKey } = await requestWithRetry(
        () => fetchWbiKeys(fetchImpl, signal),
        { getSnapshot, isCurrent, onRetry, phase: "roots", signal, wait }
      );
      if (!isCurrent()) return cancelledResult(pageKey);

      const rootIds = new Set();
      const seenOffsets = new Set();
      let offset = "";
      let firstPage = true;
      let retryAttempt = 0;

      while (true) {
        const countBeforePage = commentCount(threads);
        const response = await requestWithRetry(
          () => {
            const params = signWbiParams({
              oid: aid,
              type: 1,
              mode: 3,
              pagination_str: JSON.stringify({ offset }),
              plat: 1,
              seek_rpid: "",
              web_location: 1315875
            }, imgKey, subKey);
            return fetchJson(
              fetchImpl,
              `https://api.bilibili.com/x/v2/reply/wbi/main?${params.toString()}`,
              signal
            );
          },
          { getSnapshot, isCurrent, onRetry, phase: "roots", signal, wait }
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
        const snapshot = createSnapshot(pageKey, threads, { phase: "roots" });
        onProgress(snapshot.count);
        onSnapshot(snapshot);
        if (snapshot.count > countBeforePage) retryAttempt = 0;

        if (data.cursor?.is_end) break;
        const nextOffset = String(data.cursor?.pagination_reply?.next_offset ?? "");
        if (!nextOffset || nextOffset === offset || seenOffsets.has(nextOffset)) {
          const delay = retryDelay(retryAttempt);
          retryAttempt += 1;
          onRetry({ ...snapshot, delay, reason: "cursor" });
          const shouldContinue = await wait(delay, signal);
          if (!shouldContinue || !isCurrent()) return cancelledResult(pageKey);
          continue;
        }
        seenOffsets.add(nextOffset);
        offset = nextOffset;
        retryAttempt = 0;
      }

      for (const thread of threads) {
        if (thread.replyCount <= thread.replies.length) continue;
        const completed = await loadChildReplies({
          aid,
          fetchImpl,
          getSnapshot: () => getSnapshot("replies"),
          isCurrent,
          onBatch() {
            const snapshot = createSnapshot(pageKey, threads, { phase: "replies" });
            onProgress(snapshot.count);
            onSnapshot(snapshot);
          },
          onRetry,
          pageKey,
          signal,
          thread,
          wait
        });
        if (!completed) return cancelledResult(pageKey);
      }

      const snapshot = createSnapshot(pageKey, threads, { complete: true, phase: "complete" });
      onSnapshot(snapshot);
      return snapshot;
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
