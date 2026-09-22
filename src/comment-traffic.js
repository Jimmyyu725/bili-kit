(() => {
  "use strict";

  const FIELDS = ["requests", "completed", "failedRequests", "decodedBytes", "transferBytes", "measuredRequests", "cachedRequests", "unmeasuredBodies"];
  const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;

  function normalize(value) {
    if (!value || typeof value !== "object") return null;
    const result = Object.fromEntries(FIELDS.map((key) => [key, nonnegative(value[key])]));
    result.completed = Math.min(result.completed, result.requests);
    result.measuredRequests = Math.min(result.measuredRequests, result.completed);
    result.cachedRequests = Math.min(result.cachedRequests, result.measuredRequests);
    return result;
  }

  function formatBytes(value) {
    const bytes = nonnegative(value);
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }

  function describe(value) {
    const stats = normalize(value);
    if (!stats) return { text: "", title: "" };
    const measured = stats.completed > 0 && stats.measuredRequests === stats.completed;
    const pending = stats.requests > stats.completed;
    const text = (measured
      ? `评论传输：${formatBytes(stats.transferBytes)}`
      : `评论数据：${formatBytes(stats.decodedBytes)}（解压后）`)
      + ` · ${stats.requests} 次请求` + (pending ? " · 读取中" : "");
    const title = "仅统计本次视频的插件评论请求，含视频信息、签名密钥、主评论、楼中楼和重试；不含视频、图片或网站自身请求。"
      + `已读取响应体（解压后）：${formatBytes(stats.decodedBytes)}。`
      + `浏览器可读传输：${formatBytes(stats.transferBytes)}，覆盖 ${stats.measuredRequests}/${stats.completed} 次已结束请求（${stats.cachedRequests} 次缓存命中）。`
      + "传输量按 Resource Timing 记录的响应头和响应体统计，不含上传、TLS 等开销；跨域大小未开放时不把零值当作零流量。"
      + (stats.unmeasuredBodies ? ` ${stats.unmeasuredBodies} 次响应读取不完整或大小未取得，数据量可能不完整。` : "")
      + (stats.failedRequests ? ` HTTP/网络异常 ${stats.failedRequests} 次。` : "");
    return { text, title };
  }

  function createMeasuredFetch(fetchImpl, onTraffic = () => {}, {
    performanceImpl = globalThis.performance,
    settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  } = {}) {
    const stats = normalize({});
    const publish = () => { try { onTraffic({ ...stats }); } catch { /* Metering must not stop loading. */ } };
    const entries = (url) => {
      try { return performanceImpl?.getEntriesByName(url, "resource") || []; }
      catch { return []; }
    };
    publish();
    return async (input, options) => {
      const url = String(input);
      const previous = new Set(entries(url).map((entry) => entry.startTime));
      const startedAt = performanceImpl?.now?.() ?? 0;
      stats.requests += 1;
      publish();
      let failed = false;
      try {
        const response = await fetchImpl(input, options);
        failed = !response.ok;
        try {
          if (typeof response.clone !== "function") {
            stats.unmeasuredBodies += 1;
          } else {
            const copy = response.clone();
            if (copy.body) {
              const reader = copy.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  stats.decodedBytes += value.byteLength;
                }
              } finally { reader.releaseLock(); }
            }
          }
        } catch {
          stats.unmeasuredBodies += 1;
          failed = true;
        }
        return response;
      } catch (error) {
        failed = true;
        stats.unmeasuredBodies += 1;
        throw error;
      } finally {
        const endedAt = performanceImpl?.now?.() ?? Infinity;
        if (performanceImpl?.getEntriesByName) {
          try { await settle(); } catch { /* No timing entry is still a valid measurement outcome. */ }
          const matches = entries(url).filter((entry) => !previous.has(entry.startTime)
            && entry.startTime >= startedAt && entry.startTime <= endedAt
            && entry.initiatorType === "fetch");
          // Ambiguous or zeroed cross-origin entries are not attributed to this request.
          const entry = matches.length === 1 ? matches[0] : null;
          if (entry && (entry.transferSize > 0 || entry.decodedBodySize > 0)) {
            stats.transferBytes += nonnegative(entry.transferSize);
            stats.measuredRequests += 1;
            if (entry.transferSize === 0 && entry.decodedBodySize > 0) stats.cachedRequests += 1;
          }
        }
        stats.completed += 1;
        if (failed) stats.failedRequests += 1;
        publish();
      }
    };
  }

  globalThis.CaptionLiteCommentTraffic = { normalize, formatBytes, describe, createMeasuredFetch };
})();
