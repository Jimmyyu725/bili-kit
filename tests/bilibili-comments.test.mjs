import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(projectRoot, "src/bilibili-comments.js"), "utf8");
vm.runInThisContext(source, { filename: "bilibili-comments.js" });

const {
  appendChildReplies,
  extractWbiKeys,
  formatCommentThreads,
  md5,
  normalizeRootReply,
  signWbiParams
} = globalThis.CaptionLiteBilibiliComments;

assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");

assert.deepEqual(extractWbiKeys({
  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
}), {
  imgKey: "7cd084941338484aae1ad9425b84077c",
  subKey: "4932caff0ff746eab6f01bf08b70ac45"
});

const signed = signWbiParams(
  { z: "last", a: "hello world", unsafe: "a!b(c)*d'" },
  "7cd084941338484aae1ad9425b84077c",
  "4932caff0ff746eab6f01bf08b70ac45",
  1702204169
);
assert.equal(signed.get("wts"), "1702204169");
assert.equal(signed.get("w_rid"), "acd13f71b93375881c347534b320881d");
assert.equal(signed.get("unsafe"), "abcd");
assert.equal(signed.get("a"), "hello world");

const thread = normalizeRootReply({
  rpid: 10,
  member: { uname: "Alice" },
  content: { message: "Root\nline" },
  rcount: 2,
  replies: [
    { rpid: 11, member: { uname: "Bob" }, content: { message: "Reply" } }
  ]
});
appendChildReplies(thread, [
  { rpid: 11, member: { uname: "Bob" }, content: { message: "Reply" } },
  { rpid: 12, member: { uname: "Carol" }, content: { message: "Second" } }
]);

assert.deepEqual(thread, {
  id: "10",
  username: "Alice",
  message: "Root\nline",
  replyCount: 2,
  replies: [
    { id: "11", username: "Bob", message: "Reply" },
    { id: "12", username: "Carol", message: "Second" }
  ]
});
assert.equal(
  formatCommentThreads([thread]),
  "[Alice] Root\nline\n  ↳ [Bob] Reply\n  ↳ [Carol] Second"
);

assert.deepEqual(normalizeRootReply({ rpid_str: "20", content: {} }), {
  id: "20",
  username: "未知用户",
  message: "",
  replyCount: 0,
  replies: []
});

console.log("Bilibili comment helper checks passed.");
