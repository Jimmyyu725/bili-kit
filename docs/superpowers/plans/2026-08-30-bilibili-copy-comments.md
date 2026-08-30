# Bilibili Copy Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stationary background loading and one-click copying of every Bilibili root comment and reply, and place the embedded caption panel above the Bilibili danmaku list.

**Architecture:** Dependency-free helpers in the isolated content-script world own WBI signing, reply normalization, deduplication, text formatting, and serial pagination, so long jobs are not bound to a Manifest V3 service-worker event lifetime. The page MAIN world never exposes or returns comment data. `content.js` owns abortable job generations, clipboard writing, and compact UI state; the service worker sends trusted Chrome navigation invalidations. The panel renders one Bilibili-only action, while the existing absolute-position strategy anchors against the danmaku container instead of the playlist.

**Tech Stack:** Chrome Manifest V3, browser JavaScript, Bilibili web APIs, Node.js built-in test runner primitives, Git.

---

## File map

- Create `src/bilibili-comments.js`: deterministic MD5/WBI signing, reply normalization, thread merging, and clipboard text formatting.
- Create `tests/bilibili-comments.test.mjs`: unit coverage for the helper module.
- Modify `manifest.json`: grant clipboard writing and navigation-event access.
- Create `src/bilibili-comment-loader.js`: load comments inside the isolated content-script world without a service-worker time limit.
- Modify `src/content.js`: start/cancel comment jobs, write the clipboard, broadcast compact state, and reposition the Bilibili panel.
- Modify `src/service-worker.js`: forward copy commands and send trusted cancellation signals on committed/history navigation.
- Modify `src/sidepanel.html`: add the Bilibili-only copy-comments action.
- Modify `src/sidepanel.css`: lay out the new full-width action without compressing existing caption actions.
- Modify `src/sidepanel.js`: render comment-copy state and trigger the command.
- Modify `tests/manifest.test.mjs`: integration and layout source assertions consistent with the project's existing dependency-free test style.
- Modify `package.json`: include the new unit test in `npm test`.
- Modify `README.md`: document the Bilibili-only feature and stationary background loading.

### Task 1: Comment helper module

**Files:**
- Create: `src/bilibili-comments.js`
- Create: `tests/bilibili-comments.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing helper tests**

Create tests that load the browser IIFE with `vm.runInThisContext` and assert the public API:

```js
assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");

const signed = signWbiParams(
  { z: "last", a: "hello world", unsafe: "a!b(c)*d'" },
  "7cd084941338484aae1ad9425b84077c",
  "4932caff0ff746eab6f01bf08b70ac45",
  1702204169
);
assert.equal(signed.get("wts"), "1702204169");
assert.equal(signed.get("w_rid"), "acd13f71b93375881c347534b320881d");
assert.equal(signed.get("unsafe"), "abcd");

const thread = normalizeRootReply({
  rpid: 10,
  member: { uname: "Alice" },
  content: { message: "Root\nline" },
  rcount: 2,
  replies: [{ rpid: 11, member: { uname: "Bob" }, content: { message: "Reply" } }]
});
appendChildReplies(thread, [
  { rpid: 11, member: { uname: "Bob" }, content: { message: "Reply" } },
  { rpid: 12, member: { uname: "Carol" }, content: { message: "Second" } }
]);
assert.equal(thread.replies.length, 2);
assert.equal(formatCommentThreads([thread]), "[Alice] Root\nline\n  ↳ [Bob] Reply\n  ↳ [Carol] Second");
```

- [ ] **Step 2: Run the helper test and verify RED**

Run: `node tests/bilibili-comments.test.mjs`

Expected: FAIL because `src/bilibili-comments.js` or `CaptionLiteBilibiliComments` does not exist.

- [ ] **Step 3: Implement the helper API**

Create an IIFE exposing exactly:

```js
globalThis.CaptionLiteBilibiliComments = {
  appendChildReplies,
  extractWbiKeys,
  formatCommentThreads,
  md5,
  normalizeRootReply,
  signWbiParams
};
```

Use Bilibili's 64-entry WBI mixin permutation, remove `[!'()*]` from values, sort keys before URL encoding, append `wts`, and calculate `w_rid = md5(query + mixinKey)`. Normalize IDs to strings, missing usernames to `未知用户`, and missing messages to an empty string. `appendChildReplies` must deduplicate by normalized `rpid` without reordering existing replies.

- [ ] **Step 4: Run helper tests and verify GREEN**

Run: `node tests/bilibili-comments.test.mjs`

Expected: `Bilibili comment helper checks passed.` and exit code 0.

- [ ] **Step 5: Add the helper test to the full suite and commit**

Set:

```json
"test": "node tests/parsers.test.mjs && node tests/bilibili-comments.test.mjs && node tests/comment-copy-controller.test.mjs && node tests/bilibili-comment-loader.test.mjs && node tests/manifest.test.mjs"
```

Run: `npm test`

Expected: all three scripts exit 0.

Commit:

```bash
git add src/bilibili-comments.js tests/bilibili-comments.test.mjs package.json
git commit -m "功能：增加 Bilibili 评论数据工具"
```

### Task 2: Background comment pagination

**Files:**
- Modify: `manifest.json`
- Create: `src/bilibili-comment-loader.js`
- Modify: `src/comment-copy-controller.js`
- Modify: `src/content.js`
- Modify: `src/service-worker.js`
- Modify: `tests/manifest.test.mjs`

- [ ] **Step 1: Write failing manifest/source assertions**

Assert that the Bilibili MAIN-world script order is:

```js
assert.deepEqual(bilibiliMain?.js, ["src/bilibili-main.js"]);
assert.doesNotMatch(bilibiliSource, /CaptionLiteBilibiliCommentLoader|BILIBILI_COMMENTS_/);
assert.match(contentSource, /CaptionLiteBilibiliCommentLoader\.loadAllComments/);
assert.match(serviceWorkerSource, /chrome\.webNavigation\.onHistoryStateUpdated/);
assert.match(serviceWorkerSource, /BILIBILI_NAVIGATION/);
assert.doesNotMatch(serviceWorkerSource, /chrome\.scripting\.executeScript/);
```

- [ ] **Step 2: Run integration test and verify RED**

Run: `node tests/manifest.test.mjs`

Expected: FAIL because the isolated loader, abortable controller, navigation signal, and permission are absent.

- [ ] **Step 3: Implement serial root and child pagination**

Add an abortable loader to `bilibili-comment-loader.js`, load it only in the extension's isolated content-script list, and resolve `aid` from the Bilibili view response. Fetch WBI image keys from `/x/web-interface/nav` and sign root-page parameters:

```js
const params = signWbiParams({
  oid: video.aid,
  type: 1,
  mode: 3,
  plat: 1,
  seek_rpid: "",
  pagination_str: JSON.stringify({ offset }),
  web_location: 1315875
}, imgKey, subKey);
```

Read `data.top_replies` once, `data.replies` on every page, and continue with `data.cursor.pagination_reply.next_offset` until `data.cursor.is_end`. Only when a normalized root has `rcount` greater than its embedded reply count, fetch `/x/v2/reply/reply` with `{ oid, type: 1, root: rpid, pn, ps: 20 }` until `pn * ps >= data.page.count`. The loader reports progress directly to the isolated controller and returns `{ pageKey, count, text }` in the same content-script context. A monotonic per-job token and abort signal, plus service-worker `webNavigation.onCommitted` and `onHistoryStateUpdated` messages, invalidate even fast A → B → A transitions.

- [ ] **Step 4: Run integration and full tests**

Run: `node tests/manifest.test.mjs && npm test`

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/bilibili-comment-loader.js src/comment-copy-controller.js src/content.js src/service-worker.js tests/manifest.test.mjs
git commit -m "功能：后台分页读取 Bilibili 全部评论"
```

### Task 3: Copy-comments UI and message bridge

**Files:**
- Modify: `manifest.json`
- Modify: `src/content.js`
- Modify: `src/service-worker.js`
- Modify: `src/sidepanel.html`
- Modify: `src/sidepanel.css`
- Modify: `src/sidepanel.js`
- Modify: `tests/manifest.test.mjs`

- [ ] **Step 1: Write failing UI and message assertions**

Add assertions for:

```js
assert.ok(manifest.permissions.includes("clipboardWrite"));
assert.match(panelMarkup, /id="copy-comments-button"/);
assert.match(panelStyles, /\.copy-comments-button\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
assert.match(panelSource, /COPY_BILIBILI_COMMENTS/);
assert.match(panelSource, /setCommentCopyState/);
assert.match(contentSource, /CaptionLiteBilibiliCommentLoader\.loadAllComments/);
assert.match(contentSource, /navigator\.clipboard\.writeText/);
assert.match(serviceWorkerSource, /COMMENTS_COPY_STATE/);
```

- [ ] **Step 2: Run integration test and verify RED**

Run: `node tests/manifest.test.mjs`

Expected: FAIL at the first new clipboard/button assertion.

- [ ] **Step 3: Add the panel action and state machine**

Add a hidden full-width footer button:

```html
<button id="copy-comments-button" class="copy-comments-button" type="button" hidden>复制全部评论</button>
```

In `sidepanel.js`, include it in the required elements, show it only when `currentState?.source === "bilibili"`, and add:

```js
function setCommentCopyState(state = {}) {
  const loading = state.status === "loading";
  elements.copyCommentsButton.disabled = loading;
  elements.copyCommentsButton.textContent = loading
    ? `读取评论 ${state.count || 0} 条`
    : "复制全部评论";
  if (state.message) elements.status.textContent = state.message;
}
```

Clicking sends `{ type: "COPY_BILIBILI_COMMENTS", tabId: activeTabId }`. Expose `setCommentCopyState` from the mounted panel and consume `COMMENTS_COPY_STATE` broadcasts for the active tab.

- [ ] **Step 4: Wire command, progress, clipboard, and retry**

The service worker forwards `COPY_BILIBILI_COMMENTS` to the tab and rebroadcasts tab-originated `COMMENTS_COPY_STATE` with `tabId`. The content script acknowledges the start command synchronously, so neither runtime message event waits for the unbounded pagination task.

In `content.js`, use a comment-copy controller that keeps pending clipboard text for the same page and retries it before starting a new fetch. Otherwise emit loading state and invoke the isolated `CaptionLiteBilibiliCommentLoader`. Keep progress and full results inside the isolated world; accept only the Chrome-owned `BILIBILI_NAVIGATION` runtime message as an external cancellation signal. On success:

The controller stores `{ pageKey, text, count }` only after receiving a successful extension-channel result, writes the text, and retains it solely when clipboard access fails so the next click retries without fetching again.

`copyCommentText` first uses `navigator.clipboard.writeText`, then a hidden textarea plus `document.execCommand("copy")`. Clear pending text when the Bilibili `pageKey` changes.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all test scripts exit 0.

Commit:

```bash
git add manifest.json src/content.js src/service-worker.js src/sidepanel.html src/sidepanel.css src/sidepanel.js tests/manifest.test.mjs
git commit -m "功能：增加 Bilibili 全部评论复制按钮"
```

### Task 4: Place captions above danmaku

**Files:**
- Modify: `src/content.js`
- Modify: `tests/manifest.test.mjs`

- [ ] **Step 1: Write failing layout assertions**

Replace playlist-first expectations with:

```js
assert.match(contentSource, /const danmakuContainer = danmakuBox\.parentElement/);
assert.match(contentSource, /paddedBilibiliContainer = danmakuContainer/);
assert.match(contentSource, /placeEmbedRoot\(danmakuContainer, height\)/);
assert.doesNotMatch(contentSource, /document\.querySelector\("\.video-pod"\)/);
```

- [ ] **Step 2: Run integration test and verify RED**

Run: `node tests/manifest.test.mjs`

Expected: FAIL because `mountBilibiliPanel()` still prefers `.video-pod`.

- [ ] **Step 3: Anchor and pad the danmaku container**

In `mountBilibiliPanel()`, set `const danmakuContainer = danmakuBox.parentElement`, preserve its original inline `paddingTop`, set the padding to `height + 12`, and call `placeEmbedRoot(danmakuContainer, height)`. Keep the existing restore logic in `removeEmbeddedPanel()` and when the container identity changes. Do not alter `mountYouTubePanel()`.

- [ ] **Step 4: Run tests and commit**

Run: `npm test`

Expected: all test scripts exit 0.

Commit:

```bash
git add src/content.js tests/manifest.test.mjs
git commit -m "修复：把 Bilibili 字幕面板移到弹幕列表上方"
```

### Task 5: Documentation, verification, private backup, and Mac install

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update user documentation**

Add Bilibili usage bullets stating that “复制全部评论” loads comments and replies in the background without moving the page, and that the embedded caption panel appears above the danmaku list.

- [ ] **Step 2: Run fresh completion verification**

Run:

```bash
npm test
git diff --check
git status --short --branch
```

Expected: tests exit 0, no whitespace errors, and only the intended README change remains before the final commit.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "文档：说明 Bilibili 评论复制功能"
```

- [ ] **Step 4: Verify and push the private feature branch**

Run:

```bash
gh repo view Jimmyyu725/caption-lite --json visibility,nameWithOwner,url
git push -u origin feature/bilibili-copy-comments
git rev-parse HEAD
git ls-remote origin refs/heads/feature/bilibili-copy-comments
```

Expected: GitHub reports `PRIVATE`, and local/remote hashes match.

- [ ] **Step 5: Install on the Mac after the reverse SSH tunnel is healthy**

Connect through the configured `jingtian-mac` host, discover the existing unpacked extension directory without changing Chrome profile data, then synchronize the project files into that exact directory while excluding `.git`, `docs`, and test-only files. Preserve the previous installed folder as a timestamped sibling backup before replacement. Finally run `npm test` against the synchronized source on the Mac and tell the user to click Caption Lite's reload button at `chrome://extensions`.

- [ ] **Step 6: Manual acceptance on Bilibili**

Verify in Mac Chrome that:

1. The subtitle card is above “弹幕列表”.
2. Clicking “复制全部评论” does not change `window.scrollY`.
3. Progress count increases and includes nested replies.
4. The final clipboard has ordered root comments and indented replies.
5. YouTube caption loading, seeking, copying, and downloads are unchanged.
