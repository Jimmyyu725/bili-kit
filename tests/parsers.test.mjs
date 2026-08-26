import assert from "node:assert/strict";

await import("../src/parsers.js");

const {
  parseYouTubeJson3,
  getYouTubeCaptionTracks,
  parseYouTubeChapters,
  parseBilibiliJson,
  parseBilibiliChapters,
  isAllowedBilibiliSubtitleUrl,
  formatSrt,
  sanitizeFileName
} = globalThis.CaptionLiteParsers;

const youtubeRows = parseYouTubeJson3({
  events: [
    { tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 2500, segs: [{ utf8: "Next line" }] },
    { tStartMs: 4000, segs: [{ utf8: "   " }] }
  ]
});

assert.deepEqual(youtubeRows, [
  { startMs: 1000, endMs: 2500, text: "Hello world" },
  { startMs: 2500, endMs: 4500, text: "Next line" }
]);

assert.deepEqual(getYouTubeCaptionTracks({
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hans",
          vssId: ".zh-Hans",
          languageCode: "zh-Hans",
          name: { simpleText: "中文（简体）" }
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr",
          languageCode: "en",
          kind: "asr",
          name: { runs: [{ text: "English" }, { text: " (auto-generated)" }] }
        },
        { languageCode: "ja", name: { simpleText: "日本語" } }
      ]
    }
  }
}), [
  {
    id: ".zh-Hans",
    language: "zh-Hans",
    label: "中文（简体）",
    url: "https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hans"
  },
  {
    id: "en:asr:1",
    language: "en",
    label: "English (auto-generated)",
    url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr"
  }
]);

assert.deepEqual(parseYouTubeChapters({
  playerOverlays: {
    playerOverlayRenderer: {
      decoratedPlayerBarRenderer: {
        decoratedPlayerBarRenderer: {
          playerBar: {
            multiMarkersPlayerBarRenderer: {
              markersMap: [{
                key: "DESCRIPTION_CHAPTERS",
                value: {
                  chapters: [
                    { chapterRenderer: { timeRangeStartMillis: 60000, title: { runs: [{ text: "第二章" }] } } },
                    { chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: "开场" } } }
                  ]
                }
              }]
            }
          }
        }
      }
    }
  }
}), [
  { startMs: 0, title: "开场" },
  { startMs: 60000, title: "第二章" }
]);

const bilibiliRows = parseBilibiliJson({
  body: [
    { from: 1.25, to: 2.75, content: "第一句" },
    { from: 3, to: 5, content: "第二句" }
  ]
});

assert.deepEqual(bilibiliRows, [
  { startMs: 1250, endMs: 2750, text: "第一句" },
  { startMs: 3000, endMs: 5000, text: "第二句" }
]);

assert.deepEqual(parseBilibiliChapters([
  { type: 1, from: 0, to: 10, content: "忽略" },
  { type: 2, from: 39, to: 106, content: " 早期种田90年代 " },
  { type: 2, from: 0, to: 39, content: "引言" }
]), [
  { startMs: 0, endMs: 39000, title: "引言" },
  { startMs: 39000, endMs: 106000, title: "早期种田90年代" }
]);
assert.equal(isAllowedBilibiliSubtitleUrl("https://aisubtitle.hdslb.com/bfs/subtitle/example.json"), true);
assert.equal(isAllowedBilibiliSubtitleUrl("https://example.com/subtitle.json"), false);
assert.equal(isAllowedBilibiliSubtitleUrl("javascript:alert(1)"), false);

assert.equal(
  formatSrt(bilibiliRows),
  "1\n00:00:01,250 --> 00:00:02,750\n第一句\n\n2\n00:00:03,000 --> 00:00:05,000\n第二句\n"
);
assert.equal(sanitizeFileName("a/b:c*?"), "a-b-c--");

console.log("Parser checks passed.");
