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
  const rootOffsets = [];
  const loader = createLoader();
  const result = await loader.loadAllComments({
    pageKey: "BV1111111111:1",
    videoId: "BV1111111111",
    onProgress: (count) => progress.push(count),
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

console.log("Bilibili comment loader checks passed.");
