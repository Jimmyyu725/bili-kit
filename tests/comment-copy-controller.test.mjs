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

console.log("Comment copy controller checks passed.");
