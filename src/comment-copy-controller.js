(() => {
  "use strict";

  function createController({ getPageKey, requestComments, copyText, publishState }) {
    let generation = 0;
    let activeJob = null;
    let pendingCopy = null;

    function emit(state) {
      return publishState({
        status: state?.status || "idle",
        count: Math.max(0, Number(state?.count) || 0),
        message: String(state?.message || ""),
        canRetry: Boolean(state?.canRetry)
      });
    }

    async function copyPending() {
      if (!pendingCopy) return false;
      let copied = false;
      try {
        copied = await copyText(pendingCopy.text);
      } catch {
        copied = false;
      }
      const count = pendingCopy.count;
      if (copied) pendingCopy = null;
      await emit(copied
        ? { status: "success", count, message: `已复制 ${count} 条评论。` }
        : {
            status: "error",
            count,
            canRetry: true,
            message: "复制失败，请再次点击复制。"
          });
      return copied;
    }

    async function start() {
      const pageKey = String(getPageKey() || "");
      if (!pageKey) {
        await emit({ status: "error", message: "请先打开 Bilibili 视频。" });
        return false;
      }
      if (pendingCopy?.pageKey === pageKey) return copyPending();
      pendingCopy = null;

      const job = { generation: ++generation, pageKey };
      activeJob = job;
      await emit({ status: "loading", count: 0, message: "正在读取评论……" });

      let response;
      try {
        response = await requestComments(pageKey);
      } catch (error) {
        response = {
          success: false,
          error: error instanceof Error ? error.message : "评论读取失败"
        };
      }

      if (activeJob?.generation !== job.generation || getPageKey() !== pageKey) return false;
      activeJob = null;
      if (!response?.success) {
        await emit({
          status: "error",
          message: `评论读取失败：${String(response?.error || "未知错误")}`
        });
        return false;
      }
      if (response.pageKey !== pageKey) {
        await emit({ status: "error", message: "评论结果与当前视频不匹配。" });
        return false;
      }
      if (!response.text || !Number(response.count)) {
        await emit({ status: "error", message: "未找到可复制的评论。" });
        return false;
      }

      pendingCopy = {
        pageKey,
        text: String(response.text),
        count: Math.max(0, Number(response.count) || 0)
      };
      return copyPending();
    }

    function updateProgress(progress) {
      const pageKey = String(progress?.pageKey || "");
      if (!activeJob
          || activeJob.pageKey !== pageKey
          || getPageKey() !== pageKey) return false;
      const count = Math.max(0, Number(progress?.count) || 0);
      emit({
        status: "loading",
        count,
        message: `正在读取评论：${count} 条`
      });
      return true;
    }

    function invalidate() {
      generation += 1;
      activeJob = null;
      pendingCopy = null;
      emit({ status: "idle" });
    }

    return { invalidate, start, updateProgress };
  }

  globalThis.CaptionLiteCommentCopy = { createController };
})();
