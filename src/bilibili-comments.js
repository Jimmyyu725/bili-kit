(() => {
  "use strict";

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];
  const MD5_ROTATIONS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const MD5_CONSTANTS = Array.from(
    { length: 64 },
    (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0
  );

  function rotateLeft(value, bits) {
    return (value << bits) | (value >>> (32 - bits));
  }

  function littleEndianHex(value) {
    return [0, 8, 16, 24]
      .map((shift) => ((value >>> shift) & 0xff).toString(16).padStart(2, "0"))
      .join("");
  }

  function md5(value) {
    const input = new TextEncoder().encode(String(value));
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(input);
    bytes[input.length] = 0x80;

    const bitLength = BigInt(input.length) * 8n;
    for (let index = 0; index < 8; index += 1) {
      bytes[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
    }

    let hashA = 0x67452301;
    let hashB = 0xefcdab89;
    let hashC = 0x98badcfe;
    let hashD = 0x10325476;

    for (let offset = 0; offset < bytes.length; offset += 64) {
      const words = Array.from({ length: 16 }, (_, index) => {
        const start = offset + index * 4;
        return bytes[start]
          | (bytes[start + 1] << 8)
          | (bytes[start + 2] << 16)
          | (bytes[start + 3] << 24);
      });
      let a = hashA;
      let b = hashB;
      let c = hashC;
      let d = hashD;

      for (let index = 0; index < 64; index += 1) {
        let mixed;
        let wordIndex;
        if (index < 16) {
          mixed = (b & c) | (~b & d);
          wordIndex = index;
        } else if (index < 32) {
          mixed = (d & b) | (~d & c);
          wordIndex = (5 * index + 1) % 16;
        } else if (index < 48) {
          mixed = b ^ c ^ d;
          wordIndex = (3 * index + 5) % 16;
        } else {
          mixed = c ^ (b | ~d);
          wordIndex = (7 * index) % 16;
        }

        const previousD = d;
        d = c;
        c = b;
        const sum = (a + mixed + MD5_CONSTANTS[index] + words[wordIndex]) | 0;
        b = (b + rotateLeft(sum, MD5_ROTATIONS[index])) | 0;
        a = previousD;
      }

      hashA = (hashA + a) | 0;
      hashB = (hashB + b) | 0;
      hashC = (hashC + c) | 0;
      hashD = (hashD + d) | 0;
    }

    return [hashA, hashB, hashC, hashD].map(littleEndianHex).join("");
  }

  function extractFileKey(url) {
    try {
      return new URL(url).pathname.split("/").pop()?.split(".")[0] || "";
    } catch {
      return "";
    }
  }

  function extractWbiKeys(wbiImage) {
    const imgKey = extractFileKey(wbiImage?.img_url);
    const subKey = extractFileKey(wbiImage?.sub_url);
    if (!imgKey || !subKey) throw new Error("无法取得 Bilibili WBI 签名密钥");
    return { imgKey, subKey };
  }

  function signWbiParams(params, imgKey, subKey, timestamp = Math.floor(Date.now() / 1000)) {
    const originalKey = `${imgKey}${subKey}`;
    const mixinKey = MIXIN_KEY_ENC_TAB
      .map((index) => originalKey[index] || "")
      .join("")
      .slice(0, 32);
    const values = { ...params, wts: timestamp };
    const query = Object.keys(values)
      .sort()
      .map((key) => {
        const value = String(values[key] ?? "").replace(/[!'()*]/g, "");
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join("&");
    return new URLSearchParams(`${query}&w_rid=${md5(query + mixinKey)}`);
  }

  function normalizeReply(reply) {
    return {
      id: String(reply?.rpid_str || reply?.rpid || ""),
      username: String(reply?.member?.uname || "未知用户"),
      message: String(reply?.content?.message || "").replace(/\r\n?/g, "\n")
    };
  }

  function appendChildReplies(thread, replies, maxReplies = Infinity) {
    const seen = new Set(thread.replies.map((reply) => reply.id));
    (replies || []).forEach((rawReply) => {
      if (thread.replies.length >= maxReplies) return;
      const reply = normalizeReply(rawReply);
      if (!reply.id || seen.has(reply.id)) return;
      seen.add(reply.id);
      thread.replies.push(reply);
    });
    return thread;
  }

  function normalizeRootReply(reply, maxReplies = Infinity) {
    const thread = {
      ...normalizeReply(reply),
      replyCount: Math.max(0, Number(reply?.rcount) || 0),
      replies: []
    };
    appendChildReplies(thread, reply?.replies, maxReplies);
    thread.replyCount = Math.max(thread.replyCount, thread.replies.length);
    return thread;
  }

  function formatMessage(message, continuationPrefix) {
    return String(message).replace(/\n/g, `\n${continuationPrefix}`);
  }

  function formatCommentThreads(threads) {
    return (threads || []).map((thread) => {
      const lines = [`[${thread.username}] ${formatMessage(thread.message, "")}`];
      thread.replies.forEach((reply) => {
        lines.push(`  ↳ [${reply.username}] ${formatMessage(reply.message, "    ")}`);
      });
      return lines.join("\n");
    }).join("\n\n");
  }

  globalThis.CaptionLiteBilibiliComments = {
    appendChildReplies,
    extractWbiKeys,
    formatCommentThreads,
    md5,
    normalizeRootReply,
    signWbiParams
  };
})();
