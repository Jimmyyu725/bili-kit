(() => {
  "use strict";

  // Pure helpers for AI transcription: fragmented-MP4 slicing, pause detection
  // and turning untimed transcript text into timed captions. No DOM, no network.

  const HOP_SECONDS = 0.02;
  const MAX_CAPTION_UNITS = 30;

  function readUint32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function readUint64(bytes, offset) {
    return readUint32(bytes, offset) * 4294967296 + readUint32(bytes, offset + 4);
  }

  function writeUint32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }

  function writeType(bytes, offset, type) {
    for (let index = 0; index < 4; index += 1) bytes[offset + index] = type.charCodeAt(index);
  }

  function* iterateBoxes(bytes, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = readUint32(bytes, offset);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        size = readUint64(bytes, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) return;
      yield {
        type: String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]),
        start: offset,
        bodyStart: offset + headerSize,
        end: offset + size
      };
      offset += size;
    }
  }

  // `bytes` is the head of the file (offset 0 through the end of the sidx box).
  function parseSidx(bytes) {
    for (const box of iterateBoxes(bytes, 0, bytes.length)) {
      if (box.type !== "sidx") continue;
      const version = bytes[box.bodyStart];
      let cursor = box.bodyStart + 8;
      const timescale = readUint32(bytes, cursor);
      cursor += 4;
      let time;
      let firstOffset;
      if (version === 0) {
        time = readUint32(bytes, cursor);
        firstOffset = readUint32(bytes, cursor + 4);
        cursor += 8;
      } else {
        time = readUint64(bytes, cursor);
        firstOffset = readUint64(bytes, cursor + 8);
        cursor += 16;
      }
      const count = (bytes[cursor + 2] << 8) | bytes[cursor + 3];
      cursor += 4;
      let offset = box.end + firstOffset;
      const fragments = [];
      for (let index = 0; index < count && cursor + 12 <= box.end; index += 1, cursor += 12) {
        const reference = readUint32(bytes, cursor);
        if (reference >= 0x80000000) throw new Error("不支持嵌套的音频索引");
        const duration = readUint32(bytes, cursor + 4);
        fragments.push({ offset, size: reference, time, duration });
        offset += reference;
        time += duration;
      }
      if (!timescale || !fragments.length) break;
      return { timescale, initEnd: box.start, fragments };
    }
    throw new Error("音频索引解析失败");
  }

  // `bytes` holds whole moof+mdat pairs; `fileOffset` is where it starts in the file.
  function parseFragments(bytes, fileOffset = 0) {
    const samples = [];
    let trackId = 0;
    for (const moof of iterateBoxes(bytes, 0, bytes.length)) {
      if (moof.type !== "moof") continue;
      for (const traf of iterateBoxes(bytes, moof.bodyStart, moof.end)) {
        if (traf.type !== "traf") continue;
        let base = moof.start;
        let defaultDuration = 0;
        let defaultSize = 0;
        let time = samples.length ? samples.at(-1).time + samples.at(-1).duration : 0;
        let dataCursor = null;
        let skip = false;
        for (const box of iterateBoxes(bytes, traf.bodyStart, traf.end)) {
          if (box.type === "tfhd") {
            const flags = readUint32(bytes, box.bodyStart) & 0xffffff;
            let cursor = box.bodyStart + 4;
            const id = readUint32(bytes, cursor);
            cursor += 4;
            trackId ||= id;
            skip = id !== trackId;
            if (flags & 0x1) {
              base = readUint64(bytes, cursor) - fileOffset;
              cursor += 8;
            }
            if (flags & 0x2) cursor += 4;
            if (flags & 0x8) {
              defaultDuration = readUint32(bytes, cursor);
              cursor += 4;
            }
            if (flags & 0x10) defaultSize = readUint32(bytes, cursor);
          } else if (box.type === "tfdt") {
            time = bytes[box.bodyStart] === 1
              ? readUint64(bytes, box.bodyStart + 4)
              : readUint32(bytes, box.bodyStart + 4);
          } else if (box.type === "trun" && !skip) {
            const flags = readUint32(bytes, box.bodyStart) & 0xffffff;
            const count = readUint32(bytes, box.bodyStart + 4);
            let cursor = box.bodyStart + 8;
            if (flags & 0x1) {
              dataCursor = base + (readUint32(bytes, cursor) | 0);
              cursor += 4;
            } else if (dataCursor == null) {
              dataCursor = base;
            }
            if (flags & 0x4) cursor += 4;
            for (let index = 0; index < count; index += 1) {
              let duration = defaultDuration;
              let size = defaultSize;
              if (flags & 0x100) {
                duration = readUint32(bytes, cursor);
                cursor += 4;
              }
              if (flags & 0x200) {
                size = readUint32(bytes, cursor);
                cursor += 4;
              }
              if (flags & 0x400) cursor += 4;
              if (flags & 0x800) cursor += 4;
              if (!duration || !size || dataCursor < 0 || dataCursor + size > bytes.length) {
                throw new Error("音频分片解析失败");
              }
              samples.push({ data: bytes.subarray(dataCursor, dataCursor + size), time, duration });
              dataCursor += size;
              time += duration;
            }
          }
        }
      }
    }
    if (!samples.length) throw new Error("音频分片解析失败");
    return { trackId, samples };
  }

  // Wraps `samples` in one new fragment so a slice can start at any sample.
  function buildSegment(init, samples, { trackId, sequence = 1 }) {
    const trunSize = 20 + samples.length * 8;
    const trafSize = 8 + 16 + 20 + trunSize;
    const moofSize = 8 + 16 + trafSize;
    const dataSize = samples.reduce((total, sample) => total + sample.data.length, 0);
    const output = new Uint8Array(init.length + moofSize + 8 + dataSize);
    output.set(init, 0);
    let cursor = init.length;

    writeUint32(output, cursor, moofSize);
    writeType(output, cursor + 4, "moof");
    cursor += 8;
    writeUint32(output, cursor, 16);
    writeType(output, cursor + 4, "mfhd");
    writeUint32(output, cursor + 12, sequence);
    cursor += 16;
    writeUint32(output, cursor, trafSize);
    writeType(output, cursor + 4, "traf");
    cursor += 8;
    writeUint32(output, cursor, 16);
    writeType(output, cursor + 4, "tfhd");
    writeUint32(output, cursor + 8, 0x020000); // default-base-is-moof
    writeUint32(output, cursor + 12, trackId);
    cursor += 16;
    writeUint32(output, cursor, 20);
    writeType(output, cursor + 4, "tfdt");
    writeUint32(output, cursor + 8, 0x01000000);
    const decodeTime = samples[0]?.time || 0;
    writeUint32(output, cursor + 12, Math.floor(decodeTime / 4294967296));
    writeUint32(output, cursor + 16, decodeTime % 4294967296);
    cursor += 20;
    writeUint32(output, cursor, trunSize);
    writeType(output, cursor + 4, "trun");
    writeUint32(output, cursor + 8, 0x000301); // data-offset, sample-duration, sample-size
    writeUint32(output, cursor + 12, samples.length);
    writeUint32(output, cursor + 16, moofSize + 8);
    cursor += 20;
    for (const sample of samples) {
      writeUint32(output, cursor, sample.duration);
      writeUint32(output, cursor + 4, sample.data.length);
      cursor += 8;
    }
    writeUint32(output, cursor, 8 + dataSize);
    writeType(output, cursor + 4, "mdat");
    cursor += 8;
    for (const sample of samples) {
      output.set(sample.data, cursor);
      cursor += sample.data.length;
    }
    return output;
  }

  // RMS loudness per 20 ms hop across all channels.
  function computeEnergy(channels, sampleRate, hopSeconds = HOP_SECONDS) {
    const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
    const frames = Math.floor((channels[0]?.length || 0) / hop);
    const energy = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (const channel of channels) {
        for (let index = frame * hop, end = index + hop; index < end; index += 1) {
          sum += channel[index] * channel[index];
        }
      }
      energy[frame] = Math.sqrt(sum / (hop * channels.length));
    }
    return energy;
  }

  // Quietest `width`-hop window whose start lies in [from, to); among windows
  // about as quiet as the best one, the closest to `preferred` wins.
  function findQuietest(energy, from, to, width, preferred) {
    const first = Math.max(0, Math.floor(from));
    const last = Math.min(energy.length - width, Math.ceil(to) - 1);
    if (last < first) return null;
    const levels = new Float64Array(last - first + 1);
    let sum = 0;
    for (let index = first; index < first + width; index += 1) sum += energy[index];
    let best = sum;
    levels[0] = sum;
    for (let start = first + 1; start <= last; start += 1) {
      sum += energy[start + width - 1] - energy[start - 1];
      levels[start - first] = sum;
      if (sum < best) best = sum;
    }
    const limit = Math.max(best, 0) * 1.25 + width * 1e-4;
    let chosen = first;
    let chosenDistance = Infinity;
    for (let start = first; start <= last; start += 1) {
      if (levels[start - first] > limit) continue;
      const distance = Math.abs(start + width / 2 - preferred);
      if (distance < chosenDistance) {
        chosen = start;
        chosenDistance = distance;
      }
    }
    return { index: chosen + width / 2, level: levels[chosen - first] / width };
  }

  // Cut times (seconds) after `start`, each at the quietest spot between
  // `minSeconds` and `maxSeconds` into its chunk. Without `final`, stops once
  // the lookahead is too short and leaves the rest for the next call.
  function planCuts({
    energy,
    hopSeconds = HOP_SECONDS,
    start,
    end,
    final,
    minSeconds = 18,
    maxSeconds = 32,
    minTailSeconds = 6
  }) {
    const cuts = [];
    const target = (minSeconds + maxSeconds) / 2;
    const width = Math.round(0.3 / hopSeconds);
    let cursor = start;
    while (end - cursor > maxSeconds + (final ? minTailSeconds : 1)) {
      const quiet = energy && findQuietest(
        energy,
        (cursor + minSeconds) / hopSeconds - width / 2,
        (cursor + maxSeconds) / hopSeconds - width / 2,
        width,
        (cursor + target) / hopSeconds
      );
      cursor = quiet ? quiet.index * hopSeconds : cursor + target;
      cuts.push(cursor);
    }
    if (final && end > cursor) cuts.push(end);
    return cuts;
  }

  function isCjk(code) {
    return (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef);
  }

  // Display width: a CJK character counts 1, anything else half.
  function textUnits(text) {
    let units = 0;
    for (const char of text) units += isCjk(char.codePointAt(0)) ? 1 : 0.5;
    return units;
  }

  // Rough speaking time: CJK characters are syllables, Latin letters are not.
  function speechWeight(text) {
    let weight = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      if (isCjk(code) && !/\p{P}/u.test(char)) weight += 1;
      else if (/[\p{L}\p{N}]/u.test(char)) weight += 0.3;
    }
    return Math.max(weight, 0.5);
  }

  // Packs pieces into rows of similar length instead of leaving a short last row.
  function packPieces(pieces, maxUnits, joiner = "") {
    const total = textUnits(pieces.join(joiner));
    const target = total / Math.ceil(total / maxUnits);
    const rows = [];
    let current = "";
    for (const piece of pieces) {
      const candidate = current ? `${current}${joiner}${piece}` : piece;
      const units = textUnits(candidate);
      if (current && (units > maxUnits * 1.1
          || Math.abs(units - target) > Math.abs(textUnits(current) - target))) {
        rows.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
    if (current) rows.push(current);
    return rows;
  }

  function splitSentences(text, maxUnits = MAX_CAPTION_UNITS) {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const sentences = clean.match(/.+?(?:[。！？!?；;]+|\.(?=\s|$)|$)[”’」』）】)"']*\s*/gs) || [clean];
    return sentences.flatMap((sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed) return [];
      if (textUnits(trimmed) <= maxUnits * 1.2) return [trimmed];
      const clauses = trimmed.match(/.+?(?:[，,、：:]+\s*|$)/gs) || [trimmed];
      return packPieces(clauses, maxUnits).flatMap((row) => {
        const value = row.trim();
        if (textUnits(value) <= maxUnits * 1.5 || !value.includes(" ")) return [value];
        return packPieces(value.split(" "), maxUnits, " ");
      });
    }).filter(Boolean);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = Float32Array.from(values).sort();
    return sorted[sorted.length >> 1];
  }

  // Spreads one chunk's text over its time span: sentence boundaries are
  // estimated from text length, then snapped to a nearby speech pause.
  // `energy` covers the chunk only (index 0 = startMs); it may be null.
  function captionsForChunk({ text, startMs, endMs, energy = null, hopSeconds = HOP_SECONDS }) {
    const raw = String(text ?? "").trim();
    const stripped = raw.replace(/(?:…+|\.{3,})\s*$/, "").trim();
    const rows = splitSentences(stripped);
    if (!rows.length) return { captions: [], open: false };

    const hopMs = hopSeconds * 1000;
    const pauseLevel = energy?.length ? median(energy) * 0.35 : 0;
    const width = Math.round(300 / hopMs);
    const weights = rows.map(speechWeight);
    let remaining = weights.reduce((total, weight) => total + weight, 0);
    const boundaries = [startMs];
    for (let index = 0; index < rows.length - 1; index += 1) {
      const previous = boundaries[index];
      const share = (endMs - previous) * (weights[index] / remaining);
      let boundary = previous + share;
      if (energy?.length) {
        const radius = Math.min(1500, share * 0.45);
        const quiet = findQuietest(
          energy,
          (boundary - radius - startMs) / hopMs - width / 2,
          (boundary + radius - startMs) / hopMs - width / 2,
          width,
          (boundary - startMs) / hopMs
        );
        if (quiet && quiet.level <= pauseLevel) boundary = startMs + quiet.index * hopMs;
      }
      boundaries.push(Math.max(previous + 1, Math.min(boundary, endMs - (rows.length - 1 - index))));
      remaining -= weights[index];
    }
    boundaries.push(endMs);

    return {
      captions: rows.map((row, index) => ({
        startMs: Math.round(boundaries[index]),
        endMs: Math.round(boundaries[index + 1]),
        text: row
      })),
      // The chunk stopped mid-sentence; its last row continues in the next chunk.
      open: stripped !== raw || !/[。！？!?.；;][”’」』）】)"']*$/.test(stripped)
    };
  }

  // `chunks` maps chunk index -> captionsForChunk() result; gaps are allowed
  // while later chunks are still in flight.
  function mergeChunkCaptions(chunks, maxUnits = MAX_CAPTION_UNITS) {
    const captions = [];
    let joinNext = false;
    const indexes = Object.keys(chunks).map(Number).sort((a, b) => a - b);
    indexes.forEach((index, position) => {
      const chunk = chunks[index];
      chunk.captions.forEach((caption, row) => {
        const previous = captions.at(-1);
        if (row === 0 && joinNext && previous
            && textUnits(previous.text) + textUnits(caption.text) <= maxUnits * 1.6) {
          const needsSpace = /[A-Za-z0-9,.]$/.test(previous.text) && /^[A-Za-z0-9]/.test(caption.text);
          previous.text = `${previous.text}${needsSpace ? " " : ""}${caption.text}`;
          previous.endMs = caption.endMs;
        } else {
          captions.push({ ...caption });
        }
      });
      joinNext = chunk.open && chunk.captions.length > 0 && indexes[position + 1] === index + 1;
    });
    return captions;
  }

  globalThis.CaptionLiteTranscribeCore = {
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
  };
})();
