import assert from "node:assert/strict";

import { buildFakeAudio, SAMPLE_DURATION, TIMESCALE } from "./helpers/fake-audio.mjs";

await import("../src/transcribe-core.js");
await import("../src/bilibili-transcriber.js");

const { parseFragments, HOP_SECONDS } = globalThis.CaptionLiteTranscribeCore;
const { transcribe } = globalThis.CaptionLiteBilibiliTranscriber;

// 60 fragments x 216 samples is about 301 s of audio, fetched in three groups.
const audio = buildFakeAudio({ fragmentCount: 60 });
const PAUSES = [22, 50, 76, 101, 124, 150, 177, 201, 229, 255, 281];
const SAMPLE_RATE = 1000;

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
}

function createFetch({ failingHost = "", playData } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const { hostname, pathname } = new URL(url);
    if (pathname === "/x/web-interface/view") {
      return jsonResponse({
        aid: 111,
        title: "测试视频",
        desc: "一段简介",
        owner: { name: "测试UP" },
        pages: [{ page: 1, cid: 222, part: "P1" }]
      });
    }
    if (pathname === "/x/player/playurl") {
      return jsonResponse(playData || {
        dash: {
          audio: [
            {
              bandwidth: 128000,
              baseUrl: "https://cdn-a.example/high.m4s",
              segment_base: { initialization: audio.initRange, index_range: audio.indexRange }
            },
            {
              bandwidth: 64000,
              baseUrl: "https://cdn-a.example/low.m4s",
              backupUrl: ["https://cdn-b.example/low.m4s"],
              segment_base: { initialization: audio.initRange, index_range: audio.indexRange }
            }
          ]
        }
      });
    }
    if (hostname === failingHost) return { ok: false, status: 403 };
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const body = audio.file.slice(Number(start), Number(end) + 1);
    return { ok: true, status: 206, arrayBuffer: async () => body.buffer };
  };
  return { fetchImpl, calls };
}

// Loud everywhere except half-second pauses, positioned on the real timeline.
async function decodeAudio(bytes) {
  const { samples } = parseFragments(bytes.subarray(audio.init.length));
  const start = samples[0].time / TIMESCALE;
  const length = Math.round(samples.length * SAMPLE_DURATION / TIMESCALE * SAMPLE_RATE);
  const channel = new Float32Array(length).fill(0.5);
  for (const pause of PAUSES) {
    const from = Math.round((pause - start) * SAMPLE_RATE);
    if (from + 500 > 0 && from < length) channel.fill(0, Math.max(0, from), Math.min(length, from + 500));
  }
  return { sampleRate: SAMPLE_RATE, channels: [channel] };
}

function createTranscriber() {
  const requests = [];
  const transcribeChunk = async ({ audio: segment, prompt }) => {
    const { samples } = parseFragments(segment.subarray(audio.init.length));
    requests.push({ samples, prompt });
    return `片段${samples[0].time / SAMPLE_DURATION}。`;
  };
  return { requests, transcribeChunk };
}

// --- a full run -------------------------------------------------------------

{
  const { fetchImpl, calls } = createFetch();
  const { requests, transcribeChunk } = createTranscriber();
  const progress = [];
  const result = await transcribe({
    videoId: "BV1xx411c7mD",
    fetchImpl,
    decodeAudio,
    transcribeChunk,
    onProgress: (value) => progress.push(value)
  });

  assert.match(calls[0].url, /view\?bvid=BV1xx411c7mD$/);
  assert.equal(calls[0].options.credentials, "include");
  assert.match(calls[1].url, /playurl\?avid=111&cid=222&fnval=16$/);
  assert.equal(calls[2].url, "https://cdn-a.example/low.m4s", "the lowest-bitrate track is enough for speech");
  assert.equal(calls[2].options.headers.Range, `bytes=0-${audio.indexRange.split("-")[1]}`);
  assert.equal(calls.length, 6, "view, playurl, index, then three audio groups");

  assert.ok(Math.abs(result.totalSeconds - audio.durationSeconds) < 1e-6);
  assert.equal(requests.length, PAUSES.length + 1);
  requests.sort((a, b) => a.samples[0].time - b.samples[0].time);

  // Every sample is sent exactly once, in order, and unmodified.
  const sent = requests.flatMap((request) => request.samples);
  assert.equal(sent.length, audio.sampleCount);
  sent.forEach((sample, index) => {
    assert.equal(sample.time, index * SAMPLE_DURATION);
    assert.equal(sample.data.length, 20 + (index % 7));
    assert.equal(sample.data[0], index % 251);
  });

  // Slices start inside the pauses, including the ones that span two groups.
  requests.slice(1).forEach((request, index) => {
    const start = request.samples[0].time / TIMESCALE;
    assert.ok(
      start > PAUSES[index] && start < PAUSES[index] + 0.5,
      `slice ${index + 1} starts at ${start}, expected inside the pause at ${PAUSES[index]}`
    );
  });
  assert.equal(requests[0].prompt, "视频标题：测试视频\nUP主：测试UP\n简介：一段简介");

  assert.equal(result.captions.length, PAUSES.length + 1);
  assert.equal(result.captions[0].startMs, 0);
  assert.equal(result.captions[0].text, "片段0。");
  result.captions.slice(1).forEach((caption, index) => {
    assert.equal(caption.startMs, result.captions[index].endMs);
    assert.ok(caption.startMs > PAUSES[index] * 1000 && caption.startMs < PAUSES[index] * 1000 + 500);
  });
  assert.equal(result.captions.at(-1).endMs, Math.round(audio.durationSeconds * 1000));

  const last = progress.at(-1);
  assert.ok(Math.abs(last.doneSeconds - last.totalSeconds) < 1e-6);
  assert.deepEqual(last.captions, result.captions);
  assert.ok(progress.some((value) => value.loadedSeconds < value.totalSeconds), "progress is reported while downloading");
  assert.ok(progress.every((value, index) => index === 0 || value.doneSeconds >= progress[index - 1].doneSeconds));
}

// --- mirrors, cache and failures -------------------------------------------

{
  const { fetchImpl, calls } = createFetch({ failingHost: "cdn-a.example" });
  const { transcribeChunk } = createTranscriber();
  const result = await transcribe({ videoId: "av170001", fetchImpl, decodeAudio, transcribeChunk });
  assert.match(calls[0].url, /view\?aid=170001$/);
  assert.equal(result.captions.length, PAUSES.length + 1);
  assert.equal(
    calls.filter((call) => call.url.startsWith("https://cdn-a.example/")).length,
    1,
    "after one failure the working mirror is used first"
  );
}

{
  // The first run dies on its fourth slice; the retry only pays for what is missing.
  const cache = new Map();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 4) throw Object.assign(new Error("额度不足"), { code: "HTTP_429" });
    return "好。";
  };
  const seen = [];
  await assert.rejects(
    transcribe({
      videoId: "BV1xx411c7mD",
      cache,
      fetchImpl: createFetch().fetchImpl,
      decodeAudio,
      transcribeChunk: flaky,
      onProgress: (value) => seen.push(value)
    }),
    /额度不足/
  );
  assert.ok(cache.size >= 3 && cache.size < PAUSES.length + 1);
  assert.equal(seen.at(-1).captions.length, cache.size, "finished slices stay visible after a failure");

  const paid = cache.size;
  const { requests, transcribeChunk } = createTranscriber();
  const result = await transcribe({
    videoId: "BV1xx411c7mD",
    cache,
    fetchImpl: createFetch().fetchImpl,
    decodeAudio,
    transcribeChunk
  });
  assert.equal(requests.length, PAUSES.length + 1 - paid);
  assert.equal(result.captions.filter((caption) => caption.text === "好。").length, paid);
}

{
  // Transient errors are retried with backoff; permanent ones are not.
  const waits = [];
  let attempts = 0;
  const result = await transcribe({
    videoId: "BV1xx411c7mD",
    fetchImpl: createFetch().fetchImpl,
    decodeAudio,
    wait: async (milliseconds) => waits.push(milliseconds),
    transcribeChunk: async () => {
      attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error("busy"), { retryable: true });
      return "好。";
    }
  });
  assert.equal(result.captions.length, PAUSES.length + 1);
  assert.deepEqual(waits.sort((a, b) => a - b), [1500, 1500]);
}

{
  // Undecodable audio still works: evenly spaced cuts, no pause snapping.
  const { requests, transcribeChunk } = createTranscriber();
  const result = await transcribe({
    videoId: "BV1xx411c7mD",
    fetchImpl: createFetch().fetchImpl,
    decodeAudio: async () => { throw new Error("EncodingError"); },
    transcribeChunk
  });
  assert.equal(requests.length, 12);
  assert.ok(Math.abs(result.captions[1].startMs - 25_000) < 30);
}

{
  // Digital silence is not sent for transcription.
  const { requests, transcribeChunk } = createTranscriber();
  const result = await transcribe({
    videoId: "BV1xx411c7mD",
    fetchImpl: createFetch().fetchImpl,
    decodeAudio: async (bytes) => {
      const { samples } = parseFragments(bytes.subarray(audio.init.length));
      const length = Math.round(samples.length * SAMPLE_DURATION / TIMESCALE * SAMPLE_RATE);
      return { sampleRate: SAMPLE_RATE, channels: [new Float32Array(length)] };
    },
    transcribeChunk
  });
  assert.equal(requests.length, 0);
  assert.deepEqual(result.captions, []);
}

{
  const controller = new AbortController();
  const { transcribeChunk } = createTranscriber();
  await assert.rejects(
    transcribe({
      videoId: "BV1xx411c7mD",
      signal: controller.signal,
      fetchImpl: createFetch().fetchImpl,
      decodeAudio,
      transcribeChunk: async (request) => {
        controller.abort();
        return transcribeChunk(request);
      }
    }),
    { name: "AbortError" }
  );
}

await assert.rejects(
  transcribe({
    videoId: "BV1xx411c7mD",
    fetchImpl: createFetch({ playData: { durl: [{ url: "https://cdn-a.example/video.flv" }] } }).fetchImpl,
    decodeAudio,
    transcribeChunk: async () => ""
  }),
  /没有可单独读取的音轨/
);

assert.ok(HOP_SECONDS > 0);
console.log("Bilibili transcriber checks passed.");
