import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = await readFile(resolve(projectRoot, "src/bilibili-comments.js"), "utf8");
const loaderSource = await readFile(resolve(projectRoot, "src/bilibili-comment-loader.js"), "utf8");
const wbiImage = {
  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
};

function response(data) {
  return {
    ok: true,
    status: 200,
    async json() { return data; }
  };
}

function createLoader() {
  const context = vm.createContext({
    AbortController,
    BigInt,
    TextEncoder,
    URL,
    URLSearchParams
  });
  vm.runInContext(helperSource, context, { filename: "bilibili-comments.js" });
  vm.runInContext(loaderSource, context, { filename: "bilibili-comment-loader.js" });
  return context.CaptionLiteBilibiliCommentLoader;
}

{
  const childRoots = [];
  const progress = [];
  const snapshots = [];
  const rootOffsets = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "BV1111111111:1",
    videoId: "BV1111111111",
    onProgress: (count) => progress.push(count),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: -101, data: { wbi_img: wbiImage } });
      }
      if (url.pathname === "/x/v2/reply/wbi/main") {
        const offset = JSON.parse(url.searchParams.get("pagination_str")).offset;
        rootOffsets.push(offset);
        if (!offset) {
          return response({
            code: 0,
            data: {
              cursor: {
                is_end: false,
                pagination_reply: { next_offset: "next-page" }
              },
              replies: [
                {
                  rpid: 10,
                  member: { uname: "Complete" },
                  content: { message: "Already complete" },
                  rcount: 1,
                  replies: [
                    { rpid: 11, member: { uname: "Child" }, content: { message: "Included" } }
                  ]
                }
              ]
            }
          });
        }
        return response({
          code: 0,
          data: {
            cursor: { is_end: true },
            replies: [
              {
                rpid: 20,
                member: { uname: "Incomplete" },
                content: { message: "Needs one" },
                rcount: 2,
                replies: [
                  { rpid: 21, member: { uname: "First" }, content: { message: "One" } }
                ]
              }
            ]
          }
        });
      }
      if (url.pathname === "/x/v2/reply/reply") {
        childRoots.push(url.searchParams.get("root"));
        return response({
          code: 0,
          data: {
            page: { count: 2 },
            replies: [
              { rpid: 21, member: { uname: "First" }, content: { message: "One" } },
              { rpid: 22, member: { uname: "Second" }, content: { message: "Two" } }
            ]
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.count, 5, JSON.stringify(result));
  assert.deepEqual(rootOffsets, ["", "next-page"]);
  assert.deepEqual(childRoots, ["20"]);
  assert.deepEqual(progress, [0, 2, 4, 5]);
  assert.deepEqual(snapshots.map(({ count, complete, phase }) => ({ count, complete, phase })), [
    { count: 2, complete: false, phase: "roots" },
    { count: 4, complete: false, phase: "roots" },
    { count: 5, complete: false, phase: "replies" },
    { count: 5, complete: true, phase: "complete" }
  ]);
  assert.equal(result.complete, true);
  assert.match(result.text, /\[Complete\] Already complete/);
  assert.match(result.text, /↳ \[Second\] Two/);
}

{
  let current = true;
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "A:1",
    videoId: "BV1111111111",
    isCurrent: () => current,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        current = false;
        return response({ code: 0, data: { aid: 123 } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.cancelled, true);
  assert.match(result.error, /取消/);
}

{
  let mainCalls = 0;
  const waits = [];
  const retryStates = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "stall:1",
    videoId: "BV1111111111",
    wait: async (milliseconds) => { waits.push(milliseconds); return true; },
    onRetry: (state) => retryStates.push(state),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: -101, data: { wbi_img: wbiImage } });
      }
      if (url.pathname !== "/x/v2/reply/wbi/main") {
        throw new Error(`Unexpected URL: ${url}`);
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: {} },
            replies: [
              { rpid: 1, member: { uname: "First" }, content: { message: "One" }, rcount: 0 }
            ]
          }
        });
      }
      if (mainCalls === 2) {
        return response({
          code: 0,
          data: {
            cursor: {
              is_end: false,
              pagination_reply: { next_offset: "next-page" }
            },
            replies: [
              { rpid: 1, member: { uname: "First" }, content: { message: "One" }, rcount: 0 }
            ]
          }
        });
      }
      return response({
        code: 0,
        data: {
          cursor: { is_end: true },
          replies: [
            { rpid: 2, member: { uname: "Second" }, content: { message: "Two" }, rcount: 0 }
          ]
        }
      });
    }
  });

  assert.deepEqual(waits, [2000]);
  assert.equal(retryStates[0].count, 1);
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.count, 2);
}

{
  let mainCalls = 0;
  const waits = [];
  const retryStates = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "rate-limit:1",
    videoId: "BV1111111111",
    wait: async (milliseconds) => { waits.push(milliseconds); return true; },
    onRetry: (state) => retryStates.push(state),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: -101, data: { wbi_img: wbiImage } });
      }
      if (url.pathname !== "/x/v2/reply/wbi/main") {
        throw new Error(`Unexpected URL: ${url}`);
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        return { ok: false, status: 429, async json() { return {}; } };
      }
      return response({
        code: 0,
        data: {
          cursor: { is_end: true },
          replies: [
            { rpid: 1, member: { uname: "Recovered" }, content: { message: "Done" }, rcount: 0 }
          ]
        }
      });
    }
  });

  assert.deepEqual(waits, [2000]);
  assert.equal(retryStates[0].reason, "request");
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.count, 1);
}

{
  const waits = [];
  let navCalls = 0;
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "invalid-wbi:1",
    videoId: "BV1111111111",
    wait: async (milliseconds) => { waits.push(milliseconds); return false; },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        navCalls += 1;
        return response({ code: 0, data: { wbi_img: {} } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(navCalls, 1);
  assert.deepEqual(waits, []);
  assert.match(result.error, /WBI 签名密钥/);
}

{
  const waits = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "permission:1",
    videoId: "BV1111111111",
    wait: async (milliseconds) => { waits.push(milliseconds); return false; },
    fetchImpl: async () => response({ code: -101, message: "账号未登录" })
  });

  assert.deepEqual(waits, []);
  assert.match(result.error, /账号未登录/);
}

{
  let mainCalls = 0;
  const waits = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "backoff:1",
    videoId: "BV1111111111",
    wait: async (milliseconds) => { waits.push(milliseconds); return true; },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: -101, data: { wbi_img: wbiImage } });
      }
      if (url.pathname !== "/x/v2/reply/wbi/main") {
        throw new Error(`Unexpected URL: ${url}`);
      }
      mainCalls += 1;
      if (mainCalls <= 6) {
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: {} },
            replies: [
              { rpid: 1, member: { uname: "First" }, content: { message: "One" }, rcount: 0 }
            ]
          }
        });
      }
      if (mainCalls === 7) {
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: { next_offset: "after-stall" } },
            replies: []
          }
        });
      }
      if (mainCalls === 8) {
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: {} },
            replies: [
              { rpid: 2, member: { uname: "Second" }, content: { message: "Two" }, rcount: 0 }
            ]
          }
        });
      }
      return response({
        code: 0,
        data: { cursor: { is_end: true }, replies: [] }
      });
    }
  });

  assert.deepEqual(waits, [2000, 4000, 8000, 15000, 30000, 30000, 2000]);
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.count, 2);
}

{
  const offsets = [];
  const waits = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "repeated-cursor:1",
    videoId: "BV1111111111",
    wait: async (milliseconds) => { waits.push(milliseconds); return true; },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: 0, data: { wbi_img: wbiImage } });
      }
      const offset = JSON.parse(url.searchParams.get("pagination_str")).offset;
      offsets.push(offset);
      if (!offset) {
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: { next_offset: "next" } },
            replies: [
              { rpid: 1, member: { uname: "First" }, content: { message: "One" }, rcount: 0 }
            ]
          }
        });
      }
      if (offsets.length === 2) {
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: { next_offset: "next" } },
            replies: [
              { rpid: 2, member: { uname: "Second" }, content: { message: "Two" }, rcount: 0 }
            ]
          }
        });
      }
      return response({ code: 0, data: { cursor: { is_end: true }, replies: [] } });
    }
  });

  assert.deepEqual(offsets, ["", "next", "next"]);
  assert.deepEqual(waits, [2000]);
  assert.equal(result.complete, true);
  assert.equal(result.count, 2);
}

{
  const abortController = new AbortController();
  const waits = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "cancel-wait:1",
    videoId: "BV1111111111",
    signal: abortController.signal,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      abortController.abort();
      return false;
    },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: 0, data: { wbi_img: wbiImage } });
      }
      return response({
        code: 0,
        data: { cursor: { is_end: false, pagination_reply: {} }, replies: [] }
      });
    }
  });

  assert.deepEqual(waits, [2000]);
  assert.equal(result.cancelled, true);
}

{
  let mainCalls = 0;
  const snapshots = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "root-limit:1",
    videoId: "BV1111111111",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: 0, data: { wbi_img: wbiImage } });
      }
      if (url.pathname === "/x/v2/reply/wbi/main") {
        mainCalls += 1;
        return response({
          code: 0,
          data: {
            cursor: { is_end: false, pagination_reply: { next_offset: "must-not-request" } },
            replies: Array.from({ length: 501 }, (_, index) => ({
              rpid: index + 1,
              member: { uname: `Root ${index + 1}` },
              content: { message: "Comment" },
              rcount: 0
            }))
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(mainCalls, 1);
  assert.equal(result.count, 500, JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.limitReached, true);
  assert.equal(result.phase, "limit");
  assert.deepEqual(snapshots.map(({ count, complete, limitReached, phase }) => ({
    count, complete, limitReached, phase
  })), [
    { count: 500, complete: true, limitReached: true, phase: "limit" }
  ]);
  assert.equal(snapshots.filter((snapshot) => snapshot.complete && snapshot.limitReached).length, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.count <= 500));
}

{
  let mainCalls = 0;
  const childRequests = [];
  const snapshots = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "child-limit:1",
    videoId: "BV1111111111",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: 0, data: { wbi_img: wbiImage } });
      }
      if (url.pathname === "/x/v2/reply/wbi/main") {
        mainCalls += 1;
        return response({
          code: 0,
          data: {
            cursor: { is_end: true },
            replies: Array.from({ length: 490 }, (_, index) => ({
              rpid: index + 1,
              member: { uname: `Root ${index + 1}` },
              content: { message: "Comment" },
              rcount: 1
            }))
          }
        });
      }
      if (url.pathname === "/x/v2/reply/reply") {
        childRequests.push({
          root: url.searchParams.get("root"),
          page: url.searchParams.get("pn")
        });
        return response({
          code: 0,
          data: {
            page: { count: 40 },
            replies: Array.from({ length: 20 }, (_, index) => ({
              rpid: 10_000 + index,
              member: { uname: `Child ${index + 1}` },
              content: { message: "Reply" }
            }))
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(mainCalls, 1);
  assert.deepEqual(childRequests, [{ root: "1", page: "1" }]);
  assert.equal(result.count, 500, JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.limitReached, true);
  assert.equal(result.phase, "limit");
  assert.deepEqual(snapshots.map(({ count, complete, limitReached, phase }) => ({
    count, complete, limitReached, phase
  })), [
    { count: 490, complete: false, limitReached: false, phase: "roots" },
    { count: 500, complete: true, limitReached: true, phase: "limit" }
  ]);
  assert.equal(snapshots.filter((snapshot) => snapshot.complete && snapshot.limitReached).length, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.count <= 500));
}

{
  const childRequests = [];
  const snapshots = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "embedded-child-limit:1",
    videoId: "BV1111111111",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/x/web-interface/view") {
        return response({ code: 0, data: { aid: 123 } });
      }
      if (url.pathname === "/x/web-interface/nav") {
        return response({ code: 0, data: { wbi_img: wbiImage } });
      }
      if (url.pathname === "/x/v2/reply/wbi/main") {
        return response({
          code: 0,
          data: {
            cursor: { is_end: true },
            replies: [
              {
                rpid: 1,
                member: { uname: "Target root" },
                content: { message: "Comment" },
                rcount: 20,
                replies: Array.from({ length: 5 }, (_, index) => ({
                  rpid: 1_000 + index,
                  member: { uname: `Embedded ${index + 1}` },
                  content: { message: "Reply" }
                }))
              },
              ...Array.from({ length: 489 }, (_, index) => ({
                rpid: index + 2,
                member: { uname: `Root ${index + 2}` },
                content: { message: "Comment" },
                rcount: 1
              }))
            ]
          }
        });
      }
      if (url.pathname === "/x/v2/reply/reply") {
        childRequests.push({
          root: url.searchParams.get("root"),
          page: url.searchParams.get("pn")
        });
        return response({
          code: 0,
          data: {
            page: { count: 40 },
            replies: Array.from({ length: 20 }, (_, index) => ({
              rpid: 2_000 + index,
              member: { uname: `Child ${index + 1}` },
              content: { message: "Reply" }
            }))
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.deepEqual(childRequests, [{ root: "1", page: "1" }]);
  assert.equal(result.count, 500, JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.equal(result.limitReached, true);
  assert.equal(result.phase, "limit");
  assert.deepEqual(snapshots.map(({ count, complete, limitReached, phase }) => ({
    count, complete, limitReached, phase
  })), [
    { count: 495, complete: false, limitReached: false, phase: "roots" },
    { count: 500, complete: true, limitReached: true, phase: "limit" }
  ]);
  assert.equal(snapshots.filter((snapshot) => snapshot.complete && snapshot.limitReached).length, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.count <= 500));
}

console.log("Bilibili comment loader checks passed.");
