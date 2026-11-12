import assert from "node:assert/strict";
await import("../src/comment-traffic.js");
const { createMeasuredFetch, normalize, describe, formatBytes } = globalThis.CaptionLiteCommentTraffic;
const data = { text: "中文🙂", number: 3 };
const payload = JSON.stringify(data);
const bytes = new TextEncoder().encode(payload).byteLength;
const jsonResponse = () => new Response(payload, { headers: { "Content-Length": "1", "Content-Encoding": "gzip" } });
let latest;
const snapshots = [];
const emit = (value) => { latest = value; snapshots.push(value); };
const metered = createMeasuredFetch(async () => jsonResponse(), emit, { performanceImpl: null });
assert.equal(latest.requests, 0);
assert.deepEqual(await (await metered("https://api.example.test/comments")).json(), data);
assert.equal(latest.decodedBytes, bytes);
assert.equal(latest.requests, 1);
assert.equal(latest.completed, 1);
assert.equal(latest.measuredRequests, 0);
assert.equal(latest.transferBytes, 0, "Content-Length alone is not wire usage");
assert.match(describe(latest).text, /解压后/);
await metered("https://api.example.test/comments");
assert.equal(latest.decodedBytes, bytes * 2);
assert.equal(snapshots[1].decodedBytes, 0, "published snapshots must not mutate");
assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(1234), "1.2 KB");
assert.equal(formatBytes(1234567), "1.23 MB");
assert.equal(normalize({ requests: Infinity }).requests, 0);
assert.equal(normalize(null), null);
assert.equal(normalize({ decodedBytes: -1 }).decodedBytes, 0);
assert.equal(describe(null).text, "");

let clock = 100;
let resourceEntries = [];
const perf = { now: () => clock, getEntriesByName: () => resourceEntries };
function entry(transferSize, decodedBodySize, startTime = clock) {
  return { startTime, initiatorType: "fetch", transferSize, decodedBodySize };
}
const timed = createMeasuredFetch(async () => {
  resourceEntries.push(entry(315, bytes));
  clock += 5;
  return jsonResponse();
}, emit, { performanceImpl: perf, settle: async () => {} });
await timed("https://api.example.test/one");
assert.equal(latest.transferBytes, 315);
assert.equal(latest.measuredRequests, 1);
assert.match(describe(latest).text, /评论传输/);
await timed("https://api.example.test/one");
assert.equal(latest.transferBytes, 630, "old timing entries must not be counted again");
assert.equal(latest.requests, 2);
for (const [entries, measured, cached] of [
  [[entry(0, bytes)], 1, 1],
  [[entry(0, 0)], 0, 0],
  [[entry(300, bytes), entry(400, bytes)], 0, 0]
]) {
  resourceEntries = [];
  const fetcher = createMeasuredFetch(async () => { resourceEntries = entries; return jsonResponse(); }, emit,
    { performanceImpl: perf, settle: async () => {} });
  await fetcher("https://api.example.test/check");
  assert.equal(latest.measuredRequests, measured);
  assert.equal(latest.cachedRequests, cached);
}

let attempt = 0;
const failures = createMeasuredFetch(async () => {
  attempt++;
  if (attempt === 1) throw new TypeError("network failed");
  return new Response("retry error", { status: 503 });
}, emit, { performanceImpl: null });
await assert.rejects(failures("/first"), /network failed/);
assert.equal(latest.failedRequests, 1);
assert.equal(latest.completed, 1);
assert.equal(latest.unmeasuredBodies, 1);
const failedResponse = await failures("/second");
assert.equal(failedResponse.status, 503);
assert.equal(await failedResponse.text(), "retry error");
assert.equal(latest.failedRequests, 2);
assert.equal(latest.decodedBytes, 11);
assert.equal(latest.requests, 2);
assert.match(describe(latest).title, /读取不完整/);

const partial = createMeasuredFetch(async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
    setTimeout(() => controller.error(new DOMException("cancelled", "AbortError")), 10);
  }
})), emit, { performanceImpl: null });
const partialResponse = await partial("/cancelled");
await assert.rejects(partialResponse.json());
assert.equal(latest.decodedBytes, 3);
assert.equal(latest.unmeasuredBodies, 1);
assert.equal(latest.failedRequests, 1);
assert.equal(latest.requests, 1, "a fresh load starts from zero");

console.log("Comment traffic checks passed.");
