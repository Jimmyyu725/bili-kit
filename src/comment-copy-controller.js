(() => {
  "use strict";

  function createController({ getPageKey, loadComments, copyText, publishState }) {
    let generation = 0;
    let activeJob = null;
    let latestSnapshot = null;
    let latestStatus = "idle";
    let copyToken = 0;
    let traffic = null;
    let lastState = {};

    function emit(state) {
      latestStatus = state?.status || "idle";
      lastState = {
        status: latestStatus,
        count: Math.max(0, Number(state?.count) || 0),
        message: String(state?.message || ""),
        canCopy: Boolean(state?.canCopy),
        canRetry: Boolean(state?.canRetry),
        complete: Boolean(state?.complete),
        limitReached: Boolean(state?.limitReached),
        ...(traffic ? { traffic: { ...traffic } } : {})
      };
      return publishState(lastState);
    }

    function cancelActiveJob() {
      activeJob?.abortController.abort();
      activeJob = null;
    }

    function isCurrentJob(job) {
      return activeJob === job
        && job.generation === generation
        && getPageKey() === job.pageKey
        && !job.abortController.signal.aborted;
    }

    function normalizeSnapshot(value) {
      return {
        pageKey: String(value?.pageKey || ""),
        count: Math.max(0, Number(value?.count) || 0),
        text: String(value?.text || ""),
        complete: Boolean(value?.complete),
        limitReached: Boolean(value?.limitReached),
        phase: String(value?.phase || "roots")
      };
    }

    function acceptSnapshot(job, value) {
      if (!isCurrentJob(job)) return false;
      const snapshot = normalizeSnapshot(value);
      if (snapshot.pageKey !== job.pageKey) return false;
      if (latestSnapshot?.pageKey === job.pageKey && snapshot.count < latestSnapshot.count) return false;
      latestSnapshot = snapshot;
      emit({
        status: snapshot.complete ? "complete" : "loading",
        count: snapshot.count,
        canCopy: snapshot.count > 0,
        complete: snapshot.complete,
        limitReached: snapshot.limitReached,
        message: snapshot.limitReached
          ? "已达到 500 条上限，停止加载。"
          : snapshot.complete
            ? "全部评论已加载。"
          : `正在加载评论：${snapshot.count} 条`
      });
      return true;
    }

    function acceptTraffic(job, value) {
      if (!isCurrentJob(job)) return;
      traffic = globalThis.CaptionLiteCommentTraffic.normalize(value);
      emit(lastState);
    }

    function acceptRetry(job) {
      if (!isCurrentJob(job)) return false;
      const count = latestSnapshot?.count || 0;
      emit({
        status: "retrying",
        count,
        canCopy: count > 0,
        message: `加载暂时停在 ${count} 条，正在自动重试……`
      });
      return true;
    }

    async function finishLoading(job, result) {
      if (!isCurrentJob(job)) return false;
      if (result?.error) {
        activeJob = null;
        const count = latestSnapshot?.count || 0;
        await emit({
          status: "error",
          count,
          canCopy: count > 0,
          message: `评论读取失败：${String(result.error)}`
        });
        return false;
      }
      if (result?.cancelled) {
        activeJob = null;
        return false;
      }
      acceptSnapshot(job, result);
      const completed = Boolean(latestSnapshot?.complete);
      activeJob = null;
      return completed;
    }

    function startLoading() {
      const pageKey = String(getPageKey() || "");
      if (!pageKey) {
        emit({ status: "error", message: "请先打开 Bilibili 视频。" });
        return Promise.resolve(false);
      }
      if (activeJob?.pageKey === pageKey) return activeJob.promise;
      if (latestSnapshot?.pageKey === pageKey && latestSnapshot.complete) {
        return Promise.resolve(true);
      }

      cancelActiveJob();
      latestSnapshot = null;
      traffic = null;
      const abortController = new AbortController();
      const job = {
        abortController,
        generation: ++generation,
        pageKey,
        promise: null
      };
      activeJob = job;
      emit({ status: "loading", count: 0, canCopy: false, message: "正在加载评论……" });

      job.promise = Promise.resolve()
        .then(() => loadComments(pageKey, {
          signal: abortController.signal,
          onSnapshot: (value) => acceptSnapshot(job, value),
          onRetry: () => acceptRetry(job),
          onTraffic: (value) => acceptTraffic(job, value)
        }))
        .catch((error) => ({
          pageKey,
          error: error instanceof Error ? error.message : "评论读取失败"
        }))
        .then((result) => finishLoading(job, result));
      return job.promise;
    }

    function getCopySuccessMessage(copiedSnapshot, currentSnapshot, status) {
      if (currentSnapshot.limitReached) {
        return copiedSnapshot.count === currentSnapshot.count
          ? `已复制 ${copiedSnapshot.count} 条评论（已达上限）。`
          : `已复制 ${copiedSnapshot.count} 条；现已达到 500 条上限，可再次复制。`;
      }
      if (currentSnapshot.complete) {
        return copiedSnapshot.count === currentSnapshot.count
          ? `已复制全部 ${copiedSnapshot.count} 条评论。`
          : `已复制 ${copiedSnapshot.count} 条；全部 ${currentSnapshot.count} 条已加载，可再次复制全部。`;
      }
      if (status === "error") return `已复制 ${copiedSnapshot.count} 条；评论加载失败，请稍后重试。`;
      return `已复制 ${copiedSnapshot.count} 条，仍在继续加载……`;
    }

    async function copyCurrent() {
      const pageKey = String(getPageKey() || "");
      if (!latestSnapshot?.count || latestSnapshot.pageKey !== pageKey) {
        await emit({
          status: activeJob ? "loading" : "idle",
          count: 0,
          canCopy: false,
          message: "评论仍在准备中……"
        });
        return false;
      }

      const copiedSnapshot = latestSnapshot;
      const copyGeneration = generation;
      const currentCopyToken = ++copyToken;

      let copied = false;
      try {
        copied = await copyText(copiedSnapshot.text);
      } catch {
        copied = false;
      }

      if (
        generation !== copyGeneration
        || currentCopyToken !== copyToken
        || String(getPageKey() || "") !== pageKey
        || latestSnapshot?.pageKey !== pageKey
      ) {
        return copied;
      }

      const currentSnapshot = latestSnapshot;
      const loading = Boolean(activeJob) && !currentSnapshot.complete;
      const status = currentSnapshot.complete
        ? "complete"
        : latestStatus === "retrying" ? "retrying" : loading ? "loading" : "error";
      await emit({
        status,
        count: currentSnapshot.count,
        complete: currentSnapshot.complete,
        limitReached: currentSnapshot.limitReached,
        canCopy: true,
        canRetry: !copied,
        message: copied
          ? getCopySuccessMessage(copiedSnapshot, currentSnapshot, status)
          : "复制失败，请再次点击复制。"
      });
      return copied;
    }

    function invalidate() {
      generation += 1;
      cancelActiveJob();
      latestSnapshot = null;
      traffic = null;
      emit({ status: "idle" });
    }

    function restartLoading() {
      invalidate();
      return startLoading();
    }

    return { copyCurrent, invalidate, restartLoading, startLoading };
  }

  globalThis.CaptionLiteCommentCopy = { createController };
})();
