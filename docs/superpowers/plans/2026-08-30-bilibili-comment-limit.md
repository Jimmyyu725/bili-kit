# Bilibili Comment 500-Item Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Bilibili comment loading at exactly 500 combined root comments and replies while keeping copy status honest.

**Architecture:** Enforce the limit inside the isolated-page loader so no downstream snapshot can exceed 500. Propagate a `limitReached` flag through the controller and content state to the side panel, where it selects limit-specific status and button text.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, Node.js built-in test runner scripts and `node:assert`.

---

### Task 1: Enforce the hard limit in the loader

**Files:**
- Modify: `tests/bilibili-comment-loader.test.mjs`
- Modify: `src/bilibili-comment-loader.js`
- Modify: `src/bilibili-comments.js`

- [ ] **Step 1: Write failing loader tests**

Add one fixture returning more than 500 root comments and assert that the result is exactly:

```js
assert.equal(result.count, 500);
assert.equal(result.complete, true);
assert.equal(result.limitReached, true);
assert.equal(result.phase, "limit");
assert.equal(mainCalls, 1);
assert.ok(snapshots.every(({ count }) => count <= 500));
```

Add a second fixture with 490 root comments and a child-reply page containing more than 10 new replies:

```js
assert.equal(result.count, 500);
assert.equal(result.limitReached, true);
assert.equal(childCalls, 1);
assert.equal(mainCalls, 1);
assert.ok(snapshots.every(({ count }) => count <= 500));
```

- [ ] **Step 2: Run the focused test and verify red state**

Run: `node tests/bilibili-comment-loader.test.mjs`

Expected: FAIL because results currently exceed 500 or do not contain `limitReached`.

- [ ] **Step 3: Add capacity-aware merging and termination**

In `src/bilibili-comments.js`, allow reply merging to stop at a caller-provided per-thread size:

```js
function appendChildReplies(thread, replies, maxReplyCount = Number.POSITIVE_INFINITY) {
  const existing = new Set(thread.replies.map((reply) => reply.id));
  for (const rawReply of Array.isArray(replies) ? replies : []) {
    if (thread.replies.length >= maxReplyCount) break;
    const reply = normalizeReply(rawReply);
    if (!reply.id || existing.has(reply.id)) continue;
    existing.add(reply.id);
    thread.replies.push(reply);
  }
}
```

In `src/bilibili-comment-loader.js`, define `MAX_COMMENT_COUNT = 500`, add `limitReached` to `createSnapshot`, trim embedded replies to remaining capacity, and return immediately after emitting:

```js
const limitedSnapshot = createSnapshot(pageKey, threads, {
  complete: true,
  limitReached: true,
  phase: "limit"
});
onSnapshot(limitedSnapshot);
return limitedSnapshot;
```

For child pages, calculate the remaining global capacity before merging and pass `thread.replies.length + remaining` to `appendChildReplies`. Return a distinct `"limit"` result before issuing another request.

- [ ] **Step 4: Run the focused test and verify green state**

Run: `node tests/bilibili-comment-loader.test.mjs`

Expected: `Bilibili comment loader checks passed.`

- [ ] **Step 5: Commit the loader change**

```bash
git add src/bilibili-comment-loader.js src/bilibili-comments.js tests/bilibili-comment-loader.test.mjs
git commit -m "功能：限制评论最多五百条"
```

### Task 2: Propagate and render the limit state

**Files:**
- Modify: `tests/comment-copy-controller.test.mjs`
- Modify: `tests/manifest.test.mjs`
- Modify: `src/comment-copy-controller.js`
- Modify: `src/content.js`
- Modify: `src/sidepanel.js`

- [ ] **Step 1: Write failing controller and UI contract tests**

Add a final limit snapshot and verify the published state and post-copy message:

```js
const limitedSnapshot = {
  pageKey,
  count: 500,
  text: "limited",
  complete: true,
  limitReached: true,
  phase: "limit"
};
callbacks.onSnapshot(limitedSnapshot);
request.resolve(limitedSnapshot);
await loading;
assert.equal(states.at(-1).limitReached, true);
assert.match(states.at(-1).message, /500 条上限/);
assert.equal(await controller.copyCurrent(), true);
assert.match(states.at(-1).message, /已复制 500 条评论（已达上限）/);
```

Update the UI source assertions to require:

```js
assert.match(panelSource, /复制 \$\{commentCopyState\.count\} 条（上限）/);
assert.match(panelSource, /limitReached: Boolean\(state\.limitReached\)/);
assert.match(contentSource, /limitReached: Boolean\(state\?\.limitReached\)/);
```

- [ ] **Step 2: Run focused tests and verify red state**

Run: `node tests/comment-copy-controller.test.mjs && node tests/manifest.test.mjs`

Expected: FAIL because `limitReached` is currently discarded and no limit label exists.

- [ ] **Step 3: Propagate state and render honest messages**

Add `limitReached: Boolean(...)` to controller snapshots, emitted state, content-script state and side-panel state. In the controller use:

```js
message: snapshot.limitReached
  ? "已达到 500 条上限，停止加载。"
  : snapshot.complete
    ? "全部评论已加载。"
    : `正在加载评论：${snapshot.count} 条`
```

When copying a completed limited snapshot, publish `已复制 500 条评论（已达上限）。`. In the side panel render the limit label before the natural-completion label:

```js
elements.copyCommentsButton.textContent = commentCopyState.limitReached
  ? `复制 ${commentCopyState.count} 条（上限）`
  : commentCopyState.complete
    ? `复制全部 ${commentCopyState.count} 条`
    : commentCopyState.count > 0
      ? `复制当前 ${commentCopyState.count} 条`
      : "正在加载评论…";
```

- [ ] **Step 4: Run focused tests and verify green state**

Run: `node tests/comment-copy-controller.test.mjs && node tests/manifest.test.mjs`

Expected: both scripts print their success messages.

- [ ] **Step 5: Commit the state and UI change**

```bash
git add src/comment-copy-controller.js src/content.js src/sidepanel.js tests/comment-copy-controller.test.mjs tests/manifest.test.mjs
git commit -m "界面：提示评论加载上限"
```

### Task 3: Document, verify and deliver

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update user documentation**

Replace the unlimited-completion description with explicit behavior:

```markdown
- 打开 Bilibili 视频后会在后台持续读取主评论和楼中楼回复，合计最多 500 条；页面不会自动滚动。
- 加载过程中可随时复制当前结果，复制后会继续加载；达到 500 条上限或服务端没有更多评论时停止。
```

- [ ] **Step 2: Run all checks**

Run: `npm test && git diff --check`

Expected: every test script passes and `git diff --check` prints no errors.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "文档：说明评论五百条限制"
```

- [ ] **Step 4: Review the complete branch diff**

Run: `git diff 8ce44de...HEAD --stat && git diff 8ce44de...HEAD --check && git status --short --branch`

Expected: only the planned specification, tests, loader, state/UI and README files changed; the worktree is clean.

- [ ] **Step 5: Verify the private destination and push**

Run: `gh repo view Jimmyyu725/caption-lite --json visibility,nameWithOwner && git push origin feature/bilibili-progressive-comments`

Expected: visibility is `PRIVATE`, and the remote feature branch resolves to local `HEAD`.

- [ ] **Step 6: Deploy and verify on the Mac**

Over the already configured Mac SSH connection, create a timestamped backup of `/Users/jingtianyu/Documents/Codex/2026-08-26/caption-lite`, synchronize the worktree without `.git`, run `npm test` in the plugin directory, and reload extension `ppfnfkhdmjghpfdieocebepkhlgbfbpn` if browser automation access is available.

Expected: Mac tests pass, the deployed commit matches the pushed branch contents, and Chrome reports a reload time after deployment; if macOS UI permissions still block direct clicking, report that limitation without claiming a visual acceptance test.
