import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = await readFile(resolve(projectRoot, "src/bilibili-comments.js"), "utf8");
const mainSource = await readFile(resolve(projectRoot, "src/bilibili-main.js"), "utf8");
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

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function createHarness(fetchImpl) {
  const messages = [];
  const intervals = [];
  const location = { href: "https://www.bilibili.com/video/BV1111111111" };
  const window = {
    addEventListener() {},
    postMessage(message) { messages.push(message); }
  };
  const context = vm.createContext({
    AbortController,
    BigInt,
    console,
    fetch: fetchImpl,
    location,
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    TextEncoder,
    URL,
    URLSearchParams,
    window
  });
  vm.runInContext(helperSource, context, { filename: "bilibili-comments.js" });
  vm.runInContext(mainSource, context, { filename: "bilibili-main.js" });
  return {
    intervals,
    loader: context.CaptionLiteBilibiliCommentLoader,
    location,
    messages
  };
}

{
  const childRoots = [];
  const harness = createHarness(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/x/web-interface/view") {
      return response({ code: 0, data: { aid: 123, pages: [{ page: 1, cid: 456 }] } });
    }
    if (url.pathname === "/x/web-interface/nav") {
      return response({ code: -101, data: { wbi_img: wbiImage } });
    }
    if (url.pathname === "/x/v2/reply/wbi/main") {
      return response({
        code: 0,
        data: {
          cursor: { is_end: true },
          replies: [
            {
              rpid: 10,
              member: { uname: "Complete" },
              content: { message: "Already complete" },
              rcount: 1,
              replies: [{ rpid: 11, member: { uname: "Child" }, content: { message: "Included" } }]
            },
            {
              rpid: 20,
              member: { uname: "Incomplete" },
              content: { message: "Needs one" },
              rcount: 2,
              replies: [{ rpid: 21, member: { uname: "First" }, content: { message: "One" } }]
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
  });

  const result = await harness.loader.loadAllComments();
  assert.equal(result.count, 5);
  assert.deepEqual(childRoots, ["20"]);
  assert.match(result.text, /\[Complete\] Already complete/);
  assert.match(result.text, /↳ \[Second\] Two/);
  assert.ok(harness.messages.some((message) =>
    message.type === "BILIBILI_COMMENTS_PROGRESS" && message.payload.count === 5
  ));
}

{
  const mainFetch = deferred();
  const mainStarted = deferred();
  const harness = createHarness(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/x/web-interface/view") {
      return response({ code: 0, data: { aid: 123, pages: [{ page: 1, cid: 456 }] } });
    }
    if (url.pathname === "/x/web-interface/nav") {
      return response({ code: -101, data: { wbi_img: wbiImage } });
    }
    if (url.pathname === "/x/player/wbi/v2") {
      return response({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    if (url.pathname === "/x/v2/reply/wbi/main") {
      mainStarted.resolve();
      return mainFetch.promise;
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const oldJob = harness.loader.loadAllComments();
  await mainStarted.promise;
  harness.location.href = "https://www.bilibili.com/video/BV2222222222";
  harness.intervals[0]();
  harness.location.href = "https://www.bilibili.com/video/BV1111111111";
  harness.intervals[0]();
  mainFetch.resolve(response({
    code: 0,
    data: {
      cursor: { is_end: true },
      replies: [{ rpid: 30, member: { uname: "Old" }, content: { message: "Stale" }, rcount: 0 }]
    }
  }));

  const result = await oldJob;
  assert.equal(result.cancelled, true);
  assert.match(result.error, /取消/);
}

console.log("Bilibili main pagination checks passed.");
