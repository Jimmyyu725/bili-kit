(() => {
  "use strict";

  function createRegistry() {
    let nextGeneration = 0;
    const generations = new Map();
    const activeJobs = new Map();

    function invalidate(tabId) {
      const generation = ++nextGeneration;
      generations.set(tabId, generation);
      activeJobs.get(tabId)?.abortController.abort();
      activeJobs.delete(tabId);
      return generation;
    }

    function begin(tabId) {
      const generation = invalidate(tabId);
      const abortController = new AbortController();
      const record = { abortController, generation, tabId };
      activeJobs.set(tabId, record);
      return {
        generation,
        signal: abortController.signal,
        tabId,
        isCurrent() {
          return generations.get(tabId) === generation
            && activeJobs.get(tabId) === record;
        }
      };
    }

    function complete(job) {
      const record = activeJobs.get(job?.tabId);
      if (record?.generation === job?.generation) activeJobs.delete(job.tabId);
    }

    return { begin, complete, invalidate };
  }

  globalThis.CaptionLiteCommentJobs = { createRegistry };
})();
