// Builds a tiny fragmented MP4 shaped like a Bilibili DASH audio stream:
// ftyp + moov (init), one sidx, then moof/mdat pairs.

function box(type, ...parts) {
  const size = 8 + parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
  let cursor = 8;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}

function u32(...values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}

function concat(parts) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}

export const SAMPLE_DURATION = 1024;
export const TIMESCALE = 44100;

// Sample `n` is `sampleSize(n)` bytes, every byte equal to `n % 251`.
export function buildFakeAudio({
  fragmentCount = 6,
  samplesPerFragment = 216,
  sampleSize = (index) => 20 + (index % 7)
} = {}) {
  const init = concat([
    box("ftyp", u32(0x69736f35, 1)),
    box("moov", box("mvex", u32(0, 1, 1, SAMPLE_DURATION, 0, 0)))
  ]);

  const fragments = [];
  let sampleIndex = 0;
  for (let fragment = 0; fragment < fragmentCount; fragment += 1) {
    const sizes = [];
    const payload = [];
    for (let index = 0; index < samplesPerFragment; index += 1, sampleIndex += 1) {
      const size = sampleSize(sampleIndex);
      sizes.push(size);
      payload.push(new Uint8Array(size).fill(sampleIndex % 251));
    }
    const decodeTime = fragment * samplesPerFragment * SAMPLE_DURATION;
    const trunBody = (dataOffset) => concat([u32(0x000201, sizes.length, dataOffset), u32(...sizes)]);
    const moofFor = (dataOffset) => box(
      "moof",
      box("mfhd", u32(0, fragment + 1)),
      box(
        "traf",
        box("tfhd", u32(0x020038, 1, SAMPLE_DURATION, 0, 0x02000000)),
        box("tfdt", u32(0x01000000, Math.floor(decodeTime / 2 ** 32), decodeTime >>> 0)),
        box("trun", trunBody(dataOffset))
      )
    );
    const moof = moofFor(moofFor(0).length + 8);
    fragments.push(concat([moof, box("mdat", ...payload)]));
  }

  const references = fragments.flatMap((bytes) => [
    bytes.length,
    samplesPerFragment * SAMPLE_DURATION,
    0x90000000
  ]);
  const sidx = box("sidx", u32(0x01000000, 1, TIMESCALE, 0, 0, 0, 0, fragments.length), u32(...references));
  const file = concat([init, sidx, ...fragments]);
  return {
    file,
    init,
    initRange: `0-${init.length - 1}`,
    indexRange: `${init.length}-${init.length + sidx.length - 1}`,
    sampleCount: sampleIndex,
    durationSeconds: sampleIndex * SAMPLE_DURATION / TIMESCALE
  };
}
