import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(projectRoot, "src/comment-copy-controller.js"), "utf8");
vm.runInThisContext(source, { filename: "comment-copy-controller.js" });

const { createController } = globalThis.CaptionLiteCommentCopy;

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

{
  const pageKey = "BV1:1";
  const request = deferred();
  const states = [];
  const copied = [];
  let callbacks;
  let requests = 0;
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_pageKey, options) => {
      requests += 1;
      callbacks = options;
      return request.promise;
    },
    copyText: async (text) => { copied.push(text); return true; },
    publishState: (state) => states.push(state)
  });

  const loading = controller.startLoading();
  await Promise.resolve();
  assert.equal(controller.startLoading(), loading);
  callbacks.onSnapshot({ pageKey, count: 2, text: "first", complete: false, phase: "roots" });
  assert.equal(await controller.copyCurrent(), true);
  callbacks.onSnapshot({ pageKey, count: 4, text: "second", complete: false, phase: "replies" });
  assert.equal(await controller.copyCurrent(), true);
  assert.deepEqual(copied, ["first", "second"]);
  assert.equal(requests, 1);
  assert.equal(states.at(-1).status, "loading");
  assert.match(states.at(-1).message, /仍在继续加载/);

  const finalSnapshot = {
    pageKey,
    count: 5,
    text: "all",
    complete: true,
    phase: "complete"
  };
  callbacks.onSnapshot(finalSnapshot);
  request.resolve(finalSnapshot);
  assert.equal(await loading, true);
  assert.equal(await controller.copyCurrent(), true);
  assert.equal(await controller.copyCurrent(), true);
  assert.deepEqual(copied, ["first", "second", "all", "all"]);
  assert.equal(requests, 1);
  assert.equal(states.at(-1).status, "complete");
  assert.equal(states.at(-1).count, 5);
}

{
  const request = deferred();
  const states = [];
  let callbacks;
  let requests = 0;
  const copyResults = [false, true];
  const controller = createController({
    getPageKey: () => "retry:1",
    loadComments: (_pageKey, options) => {
      requests += 1;
      callbacks = options;
      return request.promise;
    },
    copyText: async () => copyResults.shift(),
    publishState: (state) => states.push(state)
  });

  const loading = controller.startLoading();
  await Promise.resolve();
  assert.equal(await controller.copyCurrent(), false);
  assert.match(states.at(-1).message, /准备中/);
  callbacks.onSnapshot({
    pageKey: "retry:1",
    count: 3,
    text: "retry text",
    complete: false,
    phase: "roots"
  });
  callbacks.onRetry({ pageKey: "retry:1", count: 3, delay: 2000, reason: "cursor" });
  assert.equal(states.at(-1).status, "retrying");
  assert.equal(states.at(-1).canCopy, true);
  assert.equal(await controller.copyCurrent(), false);
  assert.equal(states.at(-1).canRetry, true);
  assert.equal(await controller.copyCurrent(), true);
  assert.equal(requests, 1);
  request.resolve({
    pageKey: "retry:1",
    count: 3,
    text: "retry text",
    complete: true,
    phase: "complete"
  });
  await loading;
}

{
  let pageKey = "A:1";
  const requests = [];
  const copied = [];
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (requestedPageKey, options) => {
      const request = deferred();
      requests.push({ requestedPageKey, options, request });
      return request.promise;
    },
    copyText: async (text) => { copied.push(text); return true; },
    publishState: () => {}
  });

  const oldLoading = controller.startLoading();
  await Promise.resolve();
  pageKey = "B:1";
  controller.invalidate();
  assert.equal(requests[0].options.signal.aborted, true);
  pageKey = "A:1";
  const newLoading = controller.startLoading();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[0].options.onSnapshot({
    pageKey: "A:1",
    count: 1,
    text: "stale",
    complete: false,
    phase: "roots"
  });
  requests[0].request.resolve({ cancelled: true, pageKey: "A:1" });
  assert.equal(await oldLoading, false);
  requests[1].options.onSnapshot({
    pageKey: "A:1",
    count: 1,
    text: "fresh",
    complete: true,
    phase: "complete"
  });
  requests[1].request.resolve({
    pageKey: "A:1",
    count: 1,
    text: "fresh",
    complete: true,
    phase: "complete"
  });
  assert.equal(await newLoading, true);
  assert.equal(await controller.copyCurrent(), true);
  assert.deepEqual(copied, ["fresh"]);
}

{
  let pageKey = "A:1";
  const requests = [];
  const copied = [];
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (requestedPageKey, options) => {
      const request = deferred();
      requests.push({ requestedPageKey, options, request });
      return request.promise;
    },
    copyText: async (text) => { copied.push(text); return true; },
    publishState: () => {}
  });

  const oldLoading = controller.startLoading();
  await Promise.resolve();
  pageKey = "B:1";
  pageKey = "A:1";
  const restartedLoading = controller.restartLoading();
  await Promise.resolve();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(requests.length, 2);
  requests[0].options.onSnapshot({
    pageKey: "A:1",
    count: 1,
    text: "old-A",
    complete: true,
    phase: "complete"
  });
  requests[0].request.resolve({ cancelled: true, pageKey: "A:1" });
  assert.equal(await oldLoading, false);
  requests[1].options.onSnapshot({
    pageKey: "A:1",
    count: 1,
    text: "new-A",
    complete: true,
    phase: "complete"
  });
  requests[1].request.resolve({
    pageKey: "A:1",
    count: 1,
    text: "new-A",
    complete: true,
    phase: "complete"
  });
  assert.equal(await restartedLoading, true);
  assert.equal(await controller.copyCurrent(), true);
  assert.deepEqual(copied, ["new-A"]);
}

{
  const pageKey = "growing:1";
  const loadingRequest = deferred();
  const copyRequest = deferred();
  const states = [];
  const copied = [];
  let callbacks;
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_pageKey, options) => {
      callbacks = options;
      return loadingRequest.promise;
    },
    copyText: async (text) => {
      copied.push(text);
      return copyRequest.promise;
    },
    publishState: (state) => states.push(state)
  });

  const loading = controller.startLoading();
  await Promise.resolve();
  callbacks.onSnapshot({ pageKey, count: 1, text: "first", complete: false, phase: "roots" });
  const copying = controller.copyCurrent();
  callbacks.onSnapshot({
    pageKey,
    count: 500,
    text: "limited",
    complete: true,
    limitReached: true,
    phase: "limit"
  });
  copyRequest.resolve(true);
  assert.equal(await copying, true);
  assert.deepEqual(copied, ["first"]);
  assert.equal(states.at(-1).count, 500);
  assert.equal(states.at(-1).limitReached, true);
  assert.match(states.at(-1).message, /已复制 1 条；现已达到 500 条上限，可再次复制。/);

  loadingRequest.resolve({
    pageKey,
    count: 500,
    text: "limited",
    complete: true,
    limitReached: true,
    phase: "limit"
  });
  await loading;
}

{
  const pageKey = "limit:1";
  const request = deferred();
  const states = [];
  let callbacks;
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_pageKey, options) => {
      callbacks = options;
      return request.promise;
    },
    copyText: async () => true,
    publishState: (state) => states.push(state)
  });

  const loading = controller.startLoading();
  await Promise.resolve();
  const limitSnapshot = {
    pageKey,
    count: 500,
    text: "limited",
    complete: true,
    limitReached: true,
    phase: "limit"
  };
  callbacks.onSnapshot(limitSnapshot);
  request.resolve(limitSnapshot);
  assert.equal(await loading, true);
  assert.deepEqual(states.at(-1), {
    status: "complete",
    count: 500,
    message: "已达到 500 条上限，停止加载。",
    canCopy: true,
    canRetry: false,
    complete: true,
    limitReached: true
  });

  assert.equal(await controller.copyCurrent(), true);
  assert.equal(states.at(-1).message, "已复制 500 条评论（已达上限）。");
}

{
  const pageKey = "copy-token:1";
  const loadingRequest = deferred();
  const copyRequests = [deferred(), deferred()];
  const states = [];
  let callbacks;
  let nextCopyRequest = 0;
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_pageKey, options) => {
      callbacks = options;
      return loadingRequest.promise;
    },
    copyText: () => copyRequests[nextCopyRequest++].promise,
    publishState: (state) => states.push(state)
  });

  controller.startLoading();
  await Promise.resolve();
  callbacks.onSnapshot({ pageKey, count: 1, text: "first", complete: true, phase: "complete" });
  const firstCopy = controller.copyCurrent();
  const secondCopy = controller.copyCurrent();

  copyRequests[1].resolve(true);
  assert.equal(await secondCopy, true);
  const emissionsAfterLatestCopy = states.length;
  copyRequests[0].resolve(true);
  assert.equal(await firstCopy, true);
  assert.equal(states.length, emissionsAfterLatestCopy);
}

{
  let pageKey = "A:1";
  const requests = [];
  const copyRequest = deferred();
  const states = [];
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_pageKey, options) => {
      const request = deferred();
      requests.push({ options, request });
      return request.promise;
    },
    copyText: () => copyRequest.promise,
    publishState: (state) => states.push(state)
  });

  controller.startLoading();
  await Promise.resolve();
  requests[0].options.onSnapshot({ pageKey, count: 1, text: "old", complete: true, phase: "complete" });
  const oldCopy = controller.copyCurrent();
  pageKey = "B:1";
  controller.invalidate();
  pageKey = "A:1";
  controller.startLoading();
  await Promise.resolve();
  requests[1].options.onSnapshot({ pageKey, count: 2, text: "fresh", complete: true, phase: "complete" });

  const emissionsAfterRestart = states.length;
  copyRequest.resolve(true);
  assert.equal(await oldCopy, true);
  assert.equal(states.length, emissionsAfterRestart);
}

{
  const pageKey = "copy-error:1";
  const loadingRequest = deferred();
  const copyRequest = deferred();
  const states = [];
  let callbacks;
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_pageKey, options) => {
      callbacks = options;
      return loadingRequest.promise;
    },
    copyText: () => copyRequest.promise,
    publishState: (state) => states.push(state)
  });

  const loading = controller.startLoading();
  await Promise.resolve();
  callbacks.onSnapshot({ pageKey, count: 2, text: "partial", complete: false, phase: "roots" });
  const copying = controller.copyCurrent();
  loadingRequest.resolve({ pageKey, error: "网络错误" });
  assert.equal(await loading, false);
  copyRequest.resolve(true);
  assert.equal(await copying, true);
  assert.equal(states.at(-1).status, "error");
  assert.match(states.at(-1).message, /已复制 2 条；评论加载失败/);
  assert.doesNotMatch(states.at(-1).message, /仍在继续加载/);
}



// Traffic updates share the current job identity and survive copying a snapshot.
await import("../src/comment-traffic.js");
{
  let pageKey = "meter:first";
  const states = [];
  const jobs = [];
  let loads = 0;
  const controller = createController({
    getPageKey: () => pageKey,
    loadComments: (_key, callbacks) => {
      loads++;
      const request = deferred();
      jobs.push({ callbacks, request });
      return request.promise;
    },
    copyText: async () => true,
    publishState: (state) => states.push(state)
  });
  const first = controller.startLoading();
  await Promise.resolve();
  jobs[0].callbacks.onTraffic({ requests: 2, completed: 2, decodedBytes: 4321 });
  jobs[0].callbacks.onSnapshot({ pageKey, count: 1, text: "test", complete: true });
  jobs[0].request.resolve({ pageKey, count: 1, text: "test", complete: true });
  await first;
  await controller.copyCurrent();
  await controller.copyCurrent();
  assert.equal(loads, 1);
  assert.equal(states.at(-1).traffic.decodedBytes, 4321);
  assert.equal(states.at(-1).traffic.requests, 2);
  assert.equal(states.at(-1).status, "complete");
  pageKey = "meter:second";
  const second = controller.startLoading();
  await Promise.resolve();
  assert.equal(states.at(-1).traffic, undefined);
  jobs[0].callbacks.onTraffic({ requests: 99, decodedBytes: 999999 });
  assert.equal(states.at(-1).traffic, undefined, "late old-tab metrics ignored");
  jobs[1].callbacks.onTraffic({ requests: 1, completed: 1, decodedBytes: 42 });
  jobs[1].request.resolve({ pageKey, error: "HTTP 403" });
  await second;
  assert.equal(states.at(-1).traffic.decodedBytes, 42);
  assert.equal(states.at(-1).status, "error");
  controller.invalidate();
  assert.equal(states.at(-1).traffic, undefined);
}

console.log("Comment copy controller checks passed.");
