import assert from "node:assert/strict";

import { buildFakeAudio, SAMPLE_DURATION, TIMESCALE } from "./helpers/fake-audio.mjs";

await import("../src/transcribe-core.js");

const {
  HOP_SECONDS,
  parseSidx,
  parseFragments,
  buildSegment,
  computeEnergy,
  findQuietest,
  planCuts,
  splitSentences,
  captionsForChunk,
  mergeChunkCaptions
} = globalThis.CaptionLiteTranscribeCore;

// --- fragmented MP4 -------------------------------------------------------

const audio = buildFakeAudio({ fragmentCount: 3, samplesPerFragment: 10 });
const indexEnd = Number(audio.indexRange.split("-")[1]);
const index = parseSidx(audio.file.subarray(0, indexEnd + 1));

assert.equal(index.timescale, TIMESCALE);
assert.equal(index.initEnd, audio.init.length);
assert.equal(index.fragments.length, 3);
assert.equal(index.fragments[0].offset, indexEnd + 1);
assert.equal(index.fragments[1].offset, index.fragments[0].offset + index.fragments[0].size);
assert.equal(index.fragments[2].offset + index.fragments[2].size, audio.file.length);
assert.deepEqual(index.fragments.map((fragment) => fragment.time), [0, 10240, 20480]);
assert.equal(index.fragments[0].duration, 10 * SAMPLE_DURATION);
assert.throws(() => parseSidx(audio.init), /音频索引解析失败/);

const mediaStart = index.fragments[0].offset;
const parsed = parseFragments(audio.file.subarray(mediaStart), mediaStart);
assert.equal(parsed.trackId, 1);
assert.equal(parsed.samples.length, 30);
parsed.samples.forEach((sample, sampleIndex) => {
  assert.equal(sample.time, sampleIndex * SAMPLE_DURATION);
  assert.equal(sample.duration, SAMPLE_DURATION);
  assert.equal(sample.data.length, 20 + (sampleIndex % 7));
  assert.ok(sample.data.every((byte) => byte === sampleIndex));
});
assert.throws(() => parseFragments(audio.init), /音频分片解析失败/);

// A slice that starts and ends mid-fragment survives a round trip.
const slice = parsed.samples.slice(7, 23);
const segment = buildSegment(audio.init, slice, { trackId: parsed.trackId, sequence: 4 });
assert.deepEqual([...segment.subarray(0, audio.init.length)], [...audio.init]);
const reparsed = parseFragments(segment.subarray(audio.init.length));
assert.equal(reparsed.trackId, 1);
assert.equal(reparsed.samples.length, 16);
reparsed.samples.forEach((sample, sampleIndex) => {
  assert.equal(sample.time, slice[sampleIndex].time);
  assert.equal(sample.duration, SAMPLE_DURATION);
  assert.deepEqual([...sample.data], [...slice[sampleIndex].data]);
});

// Decode times past 32 bits are written in full.
const late = [{ data: new Uint8Array([9, 9]), time: 2 ** 33 + 5, duration: 1024 }];
assert.equal(
  parseFragments(buildSegment(audio.init, late, { trackId: 1 }).subarray(audio.init.length)).samples[0].time,
  2 ** 33 + 5
);

// --- loudness and cut planning --------------------------------------------

assert.deepEqual(
  [...computeEnergy([Float32Array.from([1, 1, 0, 0]), Float32Array.from([1, 1, 0, 0])], 100, 0.02)],
  [1, 0]
);

// 100 s of speech at level 1 with pauses (level 0) at the given seconds.
function speechWithPauses(seconds, pauses, pauseSeconds = 0.5) {
  const energy = new Float32Array(Math.round(seconds / HOP_SECONDS)).fill(1);
  for (const pause of pauses) {
    energy.fill(0, Math.round(pause / HOP_SECONDS), Math.round((pause + pauseSeconds) / HOP_SECONDS));
  }
  return energy;
}

const quiet = findQuietest(speechWithPauses(10, [4]), 0, 500, 15, 0);
assert.ok(Math.abs(quiet.index * HOP_SECONDS - 4.25) <= 0.11, `pause centre, got ${quiet.index * HOP_SECONDS}`);
assert.equal(quiet.level, 0);
assert.equal(findQuietest(new Float32Array(5), 0, 5, 15, 0), null);

// Two equally quiet pauses: the one nearest the preferred position wins.
const nearest = findQuietest(speechWithPauses(10, [2, 7]), 0, 500, 15, 6.5 / HOP_SECONDS);
assert.ok(Math.abs(nearest.index * HOP_SECONDS - 7.25) <= 0.11);

const energy = speechWithPauses(100, [21, 47, 49, 70, 96]);
const cuts = planCuts({ energy, start: 0, end: 100, final: true });
assert.equal(cuts.length, 4);
assert.ok(Math.abs(cuts[0] - 21.25) <= 0.11, `first cut at the pause, got ${cuts[0]}`);
assert.ok(Math.abs(cuts[1] - 47.25) <= 0.11, `second cut prefers the pause nearest 25 s in, got ${cuts[1]}`);
assert.ok(Math.abs(cuts[2] - 70.25) <= 0.11, `third cut, got ${cuts[2]}`);
assert.equal(cuts[3], 100, "the last chunk absorbs the tail instead of leaving a stub");

// Streaming: nothing is cut until the search window is fully available.
assert.deepEqual(planCuts({ energy, start: 0, end: 30, final: false }), []);
const partial = planCuts({ energy, start: 0, end: 50, final: false });
assert.equal(partial.length, 1);
assert.ok(Math.abs(partial[0] - 21.25) <= 0.11);
assert.deepEqual(planCuts({ energy, start: partial[0], end: 100, final: true }), cuts.slice(1));

// No loudness data: fall back to evenly spaced cuts.
assert.deepEqual(planCuts({ energy: null, start: 0, end: 100, final: true }), [25, 50, 75, 100]);
assert.deepEqual(planCuts({ energy: null, start: 0, end: 20, final: true }), [20]);
assert.deepEqual(planCuts({ energy: null, start: 0, end: 20, final: false }), []);
assert.deepEqual(planCuts({ energy: null, start: 20, end: 20, final: true }), []);

// --- captions ---------------------------------------------------------------

assert.deepEqual(splitSentences("  你好。今天\n天气不错！ 是吗？ "), ["你好。", "今天 天气不错！", "是吗？"]);
assert.deepEqual(splitSentences("他说：“走吧。”然后就走了。"), ["他说：“走吧。”", "然后就走了。"]);
assert.deepEqual(splitSentences("每天就要花费超过22.6万。"), ["每天就要花费超过22.6万。"]);
assert.deepEqual(splitSentences(""), []);
assert.deepEqual(
  splitSentences("那按照咱们正常人的想法，就是这些东西都是基因决定的，正常的现象，即便有些人心里不喜欢，但是只要不影响到自己，大家都是无所谓的。"),
  [
    "那按照咱们正常人的想法，就是这些东西都是基因决定的，",
    "正常的现象，即便有些人心里不喜欢，",
    "但是只要不影响到自己，大家都是无所谓的。"
  ]
);
assert.deepEqual(
  splitSentences("This is a fairly long English sentence without any commas that keeps going and going until it finally stops here."),
  [
    "This is a fairly long English sentence without any commas",
    "that keeps going and going until it finally stops here."
  ]
);
assert.deepEqual(splitSentences("Short one. Another one."), ["Short one.", "Another one."]);

// Without loudness data, time is shared by spoken length.
const even = captionsForChunk({ text: "一二三四五。六七八九十。", startMs: 10_000, endMs: 20_000 });
assert.deepEqual(even, {
  captions: [
    { startMs: 10_000, endMs: 15_000, text: "一二三四五。" },
    { startMs: 15_000, endMs: 20_000, text: "六七八九十。" }
  ],
  open: false
});

// A pause near the estimate pulls the boundary onto it.
const snapped = captionsForChunk({
  text: "一二三四五。六七八九十。",
  startMs: 10_000,
  endMs: 20_000,
  energy: speechWithPauses(10, [5.8])
});
assert.ok(Math.abs(snapped.captions[0].endMs - 16_050) <= 110, `snapped to the pause, got ${snapped.captions[0].endMs}`);
assert.equal(snapped.captions[1].startMs, snapped.captions[0].endMs);

// A pause too far from the estimate is ignored.
const far = captionsForChunk({
  text: "一二三四五。六七八九十。",
  startMs: 10_000,
  endMs: 20_000,
  energy: speechWithPauses(10, [8.5])
});
assert.equal(far.captions[0].endMs, 15_000);

// A chunk that stops mid-sentence is flagged so it can be joined to the next.
assert.deepEqual(captionsForChunk({ text: "这种思想影响很大。比如……", startMs: 0, endMs: 9000 }), {
  captions: [
    { startMs: 0, endMs: 7200, text: "这种思想影响很大。" },
    { startMs: 7200, endMs: 9000, text: "比如" }
  ],
  open: true
});
assert.equal(captionsForChunk({ text: "没有句号的结尾", startMs: 0, endMs: 1000 }).open, true);
assert.equal(captionsForChunk({ text: "Done.", startMs: 0, endMs: 1000 }).open, false);
assert.deepEqual(captionsForChunk({ text: " …… ", startMs: 0, endMs: 1000 }), { captions: [], open: false });

const merged = mergeChunkCaptions({
  0: captionsForChunk({ text: "这种思想影响很大。比如……", startMs: 0, endMs: 9000 }),
  1: captionsForChunk({ text: "说啊，右翼加速主义者。", startMs: 9000, endMs: 12_000 }),
  3: captionsForChunk({ text: "后面的内容。", startMs: 20_000, endMs: 22_000 })
});
assert.deepEqual(merged, [
  { startMs: 0, endMs: 7200, text: "这种思想影响很大。" },
  { startMs: 7200, endMs: 12_000, text: "比如说啊，右翼加速主义者。" },
  { startMs: 20_000, endMs: 22_000, text: "后面的内容。" }
]);

// An open chunk is not joined across a gap that is still being transcribed.
assert.equal(mergeChunkCaptions({
  0: captionsForChunk({ text: "比如……", startMs: 0, endMs: 1000 }),
  2: captionsForChunk({ text: "说啊。", startMs: 2000, endMs: 3000 })
}).length, 2);

// English halves are joined with a space.
assert.equal(mergeChunkCaptions({
  0: captionsForChunk({ text: "and then we", startMs: 0, endMs: 1000 }),
  1: captionsForChunk({ text: "went home.", startMs: 1000, endMs: 2000 })
})[0].text, "and then we went home.");

console.log("Transcribe core checks passed.");
