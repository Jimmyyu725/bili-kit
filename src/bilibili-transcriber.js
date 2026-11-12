(() => {
  "use strict";

  // Turns a Bilibili video's audio track into timed captions: download the
  // DASH audio in the page's own origin, cut it at speech pauses, send each
  // slice to the service worker for transcription, then time the sentences.

  const {
    HOP_SECONDS,
    parseSidx,
    parseFragments,
    buildSegment,
    computeEnergy,
    planCuts,
    captionsForChunk,
    mergeChunkCaptions
  } = globalThis.CaptionLiteTranscribeCore;

  const GROUP_SECONDS = 120;
  const CONCURRENCY = 4;
  const RETRY_DELAYS = [1500, 4000, 9000];
  const DECODE_SAMPLE_RATE = 8000;

  function throwIfAborted(signal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }

  function defaultWait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  async function fetchJson(fetchImpl, url, signal) {
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
    const data = await response.json();
    if (Number(data?.code) !== 0) throw new Error(data?.message || `Bilibili 错误 ${data?.code}`);
    return data.data;
  }

  function pickAudio(play) {
    return (Array.isArray(play?.dash?.audio) ? play.dash.audio : [])
      .map((item) => {
        const base = item.segment_base || item.SegmentBase || {};
        const indexEnd = Number(/^\d+-(\d+)$/.exec(base.index_range || base.indexRange || "")?.[1]);
        const urls = [item.baseUrl || item.base_url, ...(item.backupUrl || item.backup_url || [])]
          .filter((url) => typeof url === "string" && url.startsWith("https://"));
        return indexEnd && urls.length
          ? { bandwidth: Number(item.bandwidth) || 0, indexEnd, urls }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.bandwidth - b.bandwidth)[0] || null;
  }

  // Reads a byte range, moving on to the next mirror when one fails.
  function createRangeReader(fetchImpl, urls, signal) {
    let preferred = 0;
    return async (start, end) => {
      let lastError = null;
      for (let attempt = 0; attempt < urls.length; attempt += 1) {
        const index = (preferred + attempt) % urls.length;
        try {
          const response = await fetchImpl(urls[index], {
            headers: { Range: `bytes=${start}-${end}` },
            signal
          });
          if (!response.ok) throw new Error(`音频下载 HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== end - start + 1) throw new Error("音频下载不完整");
          preferred = index;
          return bytes;
        } catch (error) {
          throwIfAborted(signal);
          lastError = error;
        }
      }
      throw lastError;
    };
  }

  function createLimiter(limit) {
    const queue = [];
    let active = 0;
    const next = () => {
      if (active >= limit || !queue.length) return;
      active += 1;
      const { task, resolve, reject } = queue.shift();
      task().then(resolve, reject).finally(() => {
        active -= 1;
        next();
      });
    };
    return (task) => new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  }

  function buildPrompt(view, page) {
    const part = view.pages?.length > 1 ? page.part : "";
    return [
      view.title && `视频标题：${view.title}`,
      part && `分P标题：${part}`,
      view.owner?.name && `UP主：${view.owner.name}`,
      view.desc && view.desc !== "-" && `简介：${String(view.desc).slice(0, 300)}`
    ].filter(Boolean).join("\n");
  }

  async function browserDecodeAudio(bytes) {
    const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
    const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    };
  }

  function toBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function runtimeTranscribeChunk({ audio, prompt }) {
    const response = await chrome.runtime.sendMessage({
      type: "AI_TRANSCRIBE_CHUNK",
      audio: toBase64(audio),
      prompt
    });
    if (response?.success) return String(response.text || "");
    const error = new Error(response?.error || "转写请求失败");
    error.code = response?.code || "";
    error.retryable = Boolean(response?.retryable);
    throw error;
  }

  // `cache` (a Map) keeps finished slices so a retry never pays for them twice.
  async function transcribe({
    videoId,
    pageNumber = 1,
    signal,
    cache = new Map(),
    onProgress = () => {},
    fetchImpl = (...args) => fetch(...args),
    decodeAudio = browserDecodeAudio,
    transcribeChunk = runtimeTranscribeChunk,
    wait = defaultWait
  }) {
    const idQuery = /^av/i.test(videoId)
      ? `aid=${videoId.slice(2)}`
      : `bvid=${encodeURIComponent(videoId)}`;
    const view = await fetchJson(fetchImpl, `https://api.bilibili.com/x/web-interface/view?${idQuery}`, signal);
    const page = view?.pages?.find((item) => item.page === pageNumber) || view?.pages?.[0];
    if (!view?.aid || !page?.cid) throw new Error("无法确定视频 aid/cid");
    const play = await fetchJson(
      fetchImpl,
      `https://api.bilibili.com/x/player/playurl?avid=${view.aid}&cid=${page.cid}&fnval=16`,
      signal
    );
    const audio = pickAudio(play);
    if (!audio) throw new Error("这个视频没有可单独读取的音轨");

    const readRange = createRangeReader(fetchImpl, audio.urls, signal);
    const head = await readRange(0, audio.indexEnd);
    const { timescale, initEnd, fragments } = parseSidx(head);
    const init = head.subarray(0, initEnd);
    const mediaStart = fragments[0].time / timescale;
    const totalSeconds = (fragments.at(-1).time + fragments.at(-1).duration) / timescale - mediaStart;
    const seconds = (time) => time / timescale - mediaStart;
    const prompt = buildPrompt(view, page);

    // Loudness for the whole track; 1 marks audio that could not be decoded.
    const energy = new Float32Array(Math.ceil(totalSeconds / HOP_SECONDS)).fill(1);
    const results = {};
    const tasks = [];
    const limiter = createLimiter(CONCURRENCY);
    let failed = null;
    let loadedSeconds = 0;
    let doneSeconds = 0;
    let chunkCount = 0;
    let trackId = 0;
    let pending = [];

    const report = () => onProgress({
      loadedSeconds,
      doneSeconds,
      totalSeconds,
      captions: mergeChunkCaptions(results)
    });

    async function requestText(segment) {
      for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(signal);
        try {
          return await transcribeChunk({ audio: segment, prompt, signal });
        } catch (error) {
          if (!error?.retryable || attempt >= RETRY_DELAYS.length) throw error;
          await wait(RETRY_DELAYS[attempt], signal);
        }
      }
    }

    function queueChunk(samples, startSeconds, endSeconds) {
      const chunkIndex = chunkCount;
      chunkCount += 1;
      const startMs = Math.round((startSeconds + mediaStart) * 1000);
      const endMs = Math.round((endSeconds + mediaStart) * 1000);
      const cacheKey = `${startMs}-${endMs}`;
      const slice = energy.subarray(
        Math.round(startSeconds / HOP_SECONDS),
        Math.round(endSeconds / HOP_SECONDS)
      );
      const decoded = slice.some((level) => level !== 1);
      tasks.push(limiter(async () => {
        if (failed) return;
        let text = cache.get(cacheKey);
        if (text == null) {
          // Digital silence has nothing to transcribe.
          text = decoded && slice.every((level) => level < 1e-4)
            ? ""
            : await requestText(buildSegment(init, samples, { trackId, sequence: chunkIndex + 1 }));
          cache.set(cacheKey, text);
        }
        results[chunkIndex] = captionsForChunk({ text, startMs, endMs, energy: decoded ? slice : null });
        doneSeconds += endSeconds - startSeconds;
        report();
      }).catch((error) => {
        failed ||= error;
      }));
    }

    for (let groupStart = 0; groupStart < fragments.length && !failed;) {
      throwIfAborted(signal);
      let groupEnd = groupStart;
      let groupSeconds = 0;
      while (groupEnd < fragments.length && groupSeconds < GROUP_SECONDS) {
        groupSeconds += fragments[groupEnd].duration / timescale;
        groupEnd += 1;
      }
      const first = fragments[groupStart];
      const last = fragments[groupEnd - 1];
      const bytes = await readRange(first.offset, last.offset + last.size - 1);
      const parsed = parseFragments(bytes, first.offset);
      trackId ||= parsed.trackId;
      pending = pending.concat(parsed.samples);

      try {
        const whole = new Uint8Array(init.length + bytes.length);
        whole.set(init, 0);
        whole.set(bytes, init.length);
        const decoded = await decodeAudio(whole);
        const levels = computeEnergy(decoded.channels, decoded.sampleRate, HOP_SECONDS);
        const from = Math.round(seconds(first.time) / HOP_SECONDS);
        const to = Math.min(energy.length, Math.round(seconds(last.time + last.duration) / HOP_SECONDS));
        // 1 is reserved for "not decoded"; real loudness never needs it. A
        // decode that comes up a few hops short repeats its last level.
        for (let index = from; index < to && levels.length; index += 1) {
          energy[index] = Math.min(levels[Math.min(index - from, levels.length - 1)], 0.999);
        }
      } catch {
        throwIfAborted(signal);
      }

      const final = groupEnd === fragments.length;
      const end = seconds(pending.at(-1).time + pending.at(-1).duration);
      loadedSeconds = end;
      for (const cut of planCuts({ energy, start: seconds(pending[0].time), end, final })) {
        let count = 0;
        while (count < pending.length && seconds(pending[count].time) < cut - 1e-6) count += 1;
        if (!count) continue;
        const chunkStart = seconds(pending[0].time);
        const chunkEnd = count < pending.length ? seconds(pending[count].time) : end;
        queueChunk(pending.slice(0, count), chunkStart, chunkEnd);
        pending = pending.slice(count);
      }
      report();
      groupStart = groupEnd;
    }

    await Promise.all(tasks);
    throwIfAborted(signal);
    if (failed) throw failed;
    return { captions: mergeChunkCaptions(results), totalSeconds };
  }

  globalThis.CaptionLiteBilibiliTranscriber = { transcribe };
})();
