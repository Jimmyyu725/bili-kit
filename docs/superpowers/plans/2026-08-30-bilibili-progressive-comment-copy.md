# Bilibili Progressive Comment Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically load Bilibili comments when a video opens, keep a live in-memory snapshot that can be copied at any time, continue loading after copying, and recover from transient cursor stalls without losing data.

**Architecture:** `bilibili-comment-loader.js` remains the isolated-world network and aggregation unit, but emits immutable snapshots after every batch and retries transient stalls with capped backoff. `comment-copy-controller.js` owns one abortable loading generation per page, stores the latest snapshot, and separates `startLoading()` from `copyCurrent()`. `content.js` starts loading on Bilibili navigation, while `sidepanel.js` renders the state and only requests a snapshot copy.

**Tech Stack:** Chrome Manifest V3 content scripts, browser `fetch`, `AbortController`, plain JavaScript IIFEs, Node.js `assert`/`vm` tests.

---

### Task 1: Streaming loader snapshots and cursor recovery

**Files:**
- Modify: `tests/bilibili-comment-loader.test.mjs`
- Modify: `src/bilibili-comment-loader.js`

- [ ] **Step 1: Write a failing snapshot test**

Extend the two-page root/child fixture so it passes `onSnapshot` and asserts exact snapshots:

```js
const snapshots = [];
const result = await loader.loadAllComments({
  pageKey: "BV1111111111:1",
  videoId: "BV1111111111",
  onSnapshot: (snapshot) => snapshots.push(snapshot),
  fetchImpl
});

assert.deepEqual(snapshots.map(({ count, complete, phase }) => ({ count, complete, phase })), [
  { count: 2, complete: false, phase: "roots" },
  { count: 4, complete: false, phase: "roots" },
  { count: 5, complete: false, phase: "replies" },
  { count: 5, complete: true, phase: "complete" }
]);
assert.equal(result.complete, true);
```

- [ ] **Step 2: Run the loader test and verify RED**

Run: `node tests/bilibili-comment-loader.test.mjs`

Expected: FAIL because `onSnapshot` is ignored and `complete`/`phase` do not exist.

- [ ] **Step 3: Implement immutable snapshot emission**

Add:

```js
function createSnapshot(pageKey, threads, { complete = false, phase = "roots" } = {}) {
  return {
    pageKey,
    count: commentCount(threads),
    text: formatCommentThreads(threads),
    complete,
    phase
  };
}
```

Accept `onSnapshot = () => {}` in `loadAllComments()`. Emit after every root page, after every child page, and once with `{ complete: true, phase: "complete" }`. Return that final snapshot.

- [ ] **Step 4: Run the loader test and verify GREEN**

Run: `node tests/bilibili-comment-loader.test.mjs`

Expected: `Bilibili comment loader checks passed.`

- [ ] **Step 5: Write a failing cursor-stall recovery test**

Add a fixture whose first root response returns `is_end: false` with an empty `pagination_reply`, whose second response for the same offset returns a new offset, and whose final response ends:

```js
const waits = [];
const retryStates = [];
const result = await loader.loadAllComments({
  pageKey: "stall:1",
  videoId: "BV1111111111",
  fetchImpl,
  wait: async (milliseconds) => waits.push(milliseconds),
  onRetry: (state) => retryStates.push(state)
});

assert.deepEqual(waits, [2000]);
assert.equal(retryStates[0].count, 1);
assert.equal(result.complete, true);
assert.equal(result.count, 2);
```

Add a repeated-stall fixture and assert delays `[2000, 4000, 8000, 15000, 30000, 30000]`. Then return a valid new cursor and assert the next stall starts again at `2000`.

- [ ] **Step 6: Run the cursor tests and verify RED**

Run: `node tests/bilibili-comment-loader.test.mjs`

Expected: FAIL with the existing `评论分页游标异常` result.

- [ ] **Step 7: Implement cancellable capped retry**

Add constants and helpers:

```js
const RETRY_DELAYS = [2000, 4000, 8000, 15000, 30000];

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
```

Accept `wait = defaultWait` and `onRetry = () => {}`. When `is_end` is false and `next_offset` is empty, equal to the current offset, or previously used, emit the latest snapshot plus retry metadata, wait, then request the same page with a fresh WBI signature. Use the same retry loop for network, HTTP 429, and HTTP 5xx failures. Reset the retry attempt to zero only after obtaining a new cursor or increasing the deduplicated comment count. Abort immediately when `isCurrent()` is false or the signal is aborted.

- [ ] **Step 8: Run loader and full tests**

Run: `node tests/bilibili-comment-loader.test.mjs && npm test`

Expected: all checks pass.

- [ ] **Step 9: Commit the loader increment**

```bash
git add src/bilibili-comment-loader.js tests/bilibili-comment-loader.test.mjs
git commit -m "功能：持续生成评论快照并恢复分页"
```

### Task 2: Loading controller separated from snapshot copying

**Files:**
- Modify: `tests/comment-copy-controller.test.mjs`
- Modify: `src/comment-copy-controller.js`

- [ ] **Step 1: Replace the old click-to-load test with a failing auto-load test**

Construct the controller with `loadComments(pageKey, callbacks)` and assert:

```js
const loading = controller.startLoading();
await Promise.resolve();
callbacks.onSnapshot({ pageKey, count: 2, text: "first", complete: false, phase: "roots" });
assert.equal(await controller.copyCurrent(), true);
assert.deepEqual(copied, ["first"]);
assert.equal(requests, 1);

callbacks.onSnapshot({ pageKey, count: 4, text: "second", complete: false, phase: "replies" });
assert.equal(await controller.copyCurrent(), true);
assert.deepEqual(copied, ["first", "second"]);
assert.equal(requests, 1);
```

Resolve the loader only after both copies and assert the same task continued running.

- [ ] **Step 2: Run controller test and verify RED**

Run: `node tests/comment-copy-controller.test.mjs`

Expected: FAIL because `startLoading` and `copyCurrent` do not exist.

- [ ] **Step 3: Implement the loading/snapshot state machine**

Replace `start()` with functions following these exact state transitions:

```js
function acceptSnapshot(job, value) {
  if (activeJob !== job || getPageKey() !== job.pageKey || value?.pageKey !== job.pageKey) return false;
  latestSnapshot = {
    pageKey: job.pageKey,
    count: Math.max(0, Number(value.count) || 0),
    text: String(value.text || ""),
    complete: Boolean(value.complete),
    phase: String(value.phase || "roots")
  };
  emit({
    status: latestSnapshot.complete ? "complete" : "loading",
    count: latestSnapshot.count,
    complete: latestSnapshot.complete,
    canCopy: latestSnapshot.count > 0,
    message: latestSnapshot.complete ? "全部评论已加载。" : `正在加载评论：${latestSnapshot.count} 条`
  });
  return true;
}

function acceptRetry(job) {
  if (activeJob !== job) return false;
  emit({
    status: "retrying",
    count: latestSnapshot?.count || 0,
    canCopy: Boolean(latestSnapshot?.count),
    message: `加载暂时停在 ${latestSnapshot?.count || 0} 条，正在自动重试……`
  });
  return true;
}

function startLoading() {
  const pageKey = String(getPageKey() || "");
  if (!pageKey) return Promise.resolve(false);
  if (activeJob?.pageKey === pageKey) return activeJob.promise;
  const abortController = new AbortController();
  const job = { abortController, generation: ++generation, pageKey, promise: null };
  activeJob = job;
  latestSnapshot = null;
  emit({ status: "loading", count: 0, canCopy: false, message: "正在加载评论……" });
  job.promise = loadComments(pageKey, {
    signal: abortController.signal,
    onSnapshot: (value) => acceptSnapshot(job, value),
    onRetry: () => acceptRetry(job)
  }).then((result) => finishLoading(job, result));
  return job.promise;
}

async function copyCurrent() {
  if (!latestSnapshot?.count || latestSnapshot.pageKey !== getPageKey()) {
    await emit({ status: "loading", count: 0, canCopy: false, message: "评论仍在准备中……" });
    return false;
  }
  const copied = await copyText(latestSnapshot.text).catch(() => false);
  await emit({
    status: latestSnapshot.complete ? "complete" : "loading",
    count: latestSnapshot.count,
    complete: latestSnapshot.complete,
    canCopy: true,
    message: copied
      ? latestSnapshot.complete
        ? `已复制全部 ${latestSnapshot.count} 条评论。`
        : `已复制 ${latestSnapshot.count} 条，仍在继续加载……`
      : "复制失败，请再次点击复制。"
  });
  return copied;
}
```

Keep `latestSnapshot` after successful copies. `copyCurrent()` publishes `status: "loading"` and “仍在继续加载” while the task runs, or `status: "complete"` after the final snapshot. If no non-empty snapshot exists, return false and publish “评论仍在准备中”。

- [ ] **Step 4: Add failing tests for completion, clipboard retry, and navigation**

Add concrete assertions after delivering a final snapshot and after an A → B → A invalidation:

```js
callbacks.onSnapshot({ pageKey, count: 5, text: "all", complete: true, phase: "complete" });
request.resolve({ pageKey, count: 5, text: "all", complete: true, phase: "complete" });
await loading;
assert.equal(await controller.copyCurrent(), true);
assert.equal(states.at(-1).status, "complete");
assert.equal(requests, 1);

const oldSignal = requestSignal;
pageKey = "B:1";
controller.invalidate();
pageKey = "A:1";
controller.startLoading();
await Promise.resolve();
assert.equal(oldSignal.aborted, true);
assert.equal(requests, 2);
```

- [ ] **Step 5: Implement completion and retry semantics**

When the loader returns, accept its final snapshot only if the job generation and page match. On a terminal loader error, retain an existing snapshot and publish `status: "error"`, `canCopy: true`; clear only on navigation invalidation.

- [ ] **Step 6: Run controller and full tests**

Run: `node tests/comment-copy-controller.test.mjs && npm test`

Expected: all checks pass.

- [ ] **Step 7: Commit the controller increment**

```bash
git add src/comment-copy-controller.js tests/comment-copy-controller.test.mjs
git commit -m "功能：支持自动加载与随时复制评论"
```

### Task 3: Auto-start wiring and panel behavior

**Files:**
- Modify: `src/content.js`
- Modify: `src/sidepanel.js`
- Modify: `tests/manifest.test.mjs`

- [ ] **Step 1: Write failing source/UI assertions**

Add assertions that `content.js` invokes `commentCopyController.startLoading()` from `loadBilibili()` after a new `pageKey`, and that the runtime `COPY_BILIBILI_COMMENTS` handler calls only `copyCurrent()`.

Assert button rendering includes:

```js
status === "complete" ? `复制全部 ${count} 条`
  : count > 0 ? `复制当前 ${count} 条`
  : "正在加载评论…"
```

Assert loading/retrying buttons are disabled only when `count === 0`, not for the entire loading task.

- [ ] **Step 2: Run manifest test and verify RED**

Run: `node tests/manifest.test.mjs`

Expected: FAIL because loading still starts from the copy command and the button is disabled while loading.

- [ ] **Step 3: Wire automatic loading**

In `content.js`, pass loader callbacks through the controller:

```js
loadComments: (pageKey, { signal, onSnapshot, onRetry }) =>
  globalThis.CaptionLiteBilibiliCommentLoader.loadAllComments({
    pageKey,
    videoId: getBilibiliIdentity().videoId,
    signal,
    isCurrent: () => !signal.aborted && getBilibiliIdentity()?.pageKey === pageKey,
    onSnapshot,
    onRetry
  })
```

After setting `currentBilibiliPageKey` for a new video, invoke `commentCopyController.startLoading()`. Change `COPY_BILIBILI_COMMENTS` to call `copyCurrent()` and acknowledge immediately.

- [ ] **Step 4: Update panel rendering**

Store `complete` and `canCopy` in compact comment state. Do not replace the state with a fake loading state on button click. Render “复制当前 N 条” while loading/retrying, “复制全部 N 条” when complete, and disable only when the source is not Bilibili, there is no active tab, or `canCopy` is false.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all checks pass.

```bash
git add src/content.js src/sidepanel.js tests/manifest.test.mjs
git commit -m "功能：打开视频后自动加载评论"
```

### Task 4: Documentation, review, deployment, and real-browser acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-30-bilibili-copy-comments-design.md`
- Modify: `docs/superpowers/plans/2026-08-30-bilibili-copy-comments.md`

- [ ] **Step 1: Update user-facing documentation**

State that comments begin loading automatically on video entry, copying is always a snapshot operation, loading continues after copy, and transient stalls retry without scrolling.

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
for file in src/*.js tests/*.mjs; do node --check "$file"; done
git diff --check
```

Expected: every command exits zero and the worktree contains only intended changes.

- [ ] **Step 3: Request code review and address only verified findings**

Review the full range from `a40170f` to `HEAD`, focusing on snapshot mutability, loader cancellation, retry loops, duplicate requests, clipboard continuation, page spoofing, and MV3 lifetime behavior. Re-run the exact affected tests after any accepted fix.

- [ ] **Step 4: Commit documentation and review fixes**

```bash
git add README.md docs/superpowers/specs/2026-08-30-bilibili-copy-comments-design.md docs/superpowers/plans/2026-08-30-bilibili-copy-comments.md
git commit -m "文档：说明评论持续加载与快照复制"
```

- [ ] **Step 5: Verify privacy and push the feature branch**

Confirm `Jimmyyu725/caption-lite` reports `PRIVATE`, push `feature/bilibili-copy-comments`, and verify `refs/heads/feature/bilibili-copy-comments` equals local `HEAD`.

- [ ] **Step 6: Back up and update the Mac plugin directory**

Verify `/Users/jingtianyu/Documents/Codex/2026-08-26/caption-lite` is clean, create a new timestamped sibling backup, push the tested branch directly over SSH if Mac GitHub HTTPS authentication remains unavailable, switch the Mac plugin directory to the branch, and run `npm test` through `zsh -lic`.

- [ ] **Step 7: Real Chrome acceptance**

Reload Caption Lite at `chrome://extensions`, refresh an open Bilibili video, and verify:

1. The count starts growing without clicking copy.
2. Clicking at an intermediate count copies that snapshot.
3. The count continues growing after the copy.
4. A later copy contains at least the later count.
5. Completion changes the button to “复制全部 N 条”.
6. The page never scrolls because of comment loading.
