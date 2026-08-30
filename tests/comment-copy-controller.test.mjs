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
  let pageKey = "BV1:1";
  const request = deferred();
  const requestedPageKeys = [];
  const states = [];
  const copied = [];
  const controller = createController({
    getPageKey: () => pageKey,
    requestComments: (requestedPageKey) => {
      requestedPageKeys.push(requestedPageKey);
      return request.promise;
    },
    copyText: async (text) => { copied.push(text); return true; },
    publishState: (state) => states.push(state)
  });

  assert.equal(controller.updateProgress({ pageKey, count: 99 }), false);
  const running = controller.start();
  assert.equal(controller.updateProgress({ pageKey, count: 7 }), true);
  request.resolve({ success: true, pageKey, count: 2, text: "comments" });
  assert.equal(await running, true);
  assert.deepEqual(requestedPageKeys, ["BV1:1"]);
  assert.deepEqual(copied, ["comments"]);
  assert.deepEqual(states.map(({ status, count }) => ({ status, count })), [
    { status: "loading", count: 0 },
    { status: "loading", count: 7 },
    { status: "success", count: 2 }
  ]);

  pageKey = "";
  controller.invalidate();
}

{
  let pageKey = "A:1";
  const request = deferred();
  const copied = [];
  const controller = createController({
    getPageKey: () => pageKey,
    requestComments: () => request.promise,
    copyText: async (text) => { copied.push(text); return true; },
    publishState: () => {}
  });

  const oldJob = controller.start();
  pageKey = "B:1";
  controller.invalidate();
  pageKey = "A:1";
  request.resolve({ success: true, pageKey: "A:1", count: 1, text: "stale" });
  assert.equal(await oldJob, false);
  assert.deepEqual(copied, []);
}

{
  let requests = 0;
  const copyResults = [false, true];
  const states = [];
  const controller = createController({
    getPageKey: () => "retry:1",
    requestComments: async () => {
      requests += 1;
      return { success: true, pageKey: "retry:1", count: 3, text: "retry text" };
    },
    copyText: async () => copyResults.shift(),
    publishState: (state) => states.push(state)
  });

  assert.equal(await controller.start(), false);
  assert.equal(await controller.start(), true);
  assert.equal(requests, 1);
  assert.equal(states.at(-2).canRetry, true);
  assert.equal(states.at(-1).status, "success");
}

{
  const copied = [];
  const states = [];
  const controller = createController({
    getPageKey: () => "error:1",
    requestComments: async () => ({ success: false, error: "rate limited" }),
    copyText: async (text) => { copied.push(text); return true; },
    publishState: (state) => states.push(state)
  });

  assert.equal(await controller.start(), false);
  assert.deepEqual(copied, []);
  assert.equal(states.at(-1).status, "error");
  assert.match(states.at(-1).message, /rate limited/);
}

console.log("Comment copy controller checks passed.");
