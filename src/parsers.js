(() => {
  "use strict";

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseYouTubeJson3(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    const events = Array.isArray(data?.events) ? data.events : [];
    const rows = events
      .map((event) => ({
        startMs: Number(event?.tStartMs),
        durationMs: Number(event?.dDurationMs),
        text: cleanText(
          Array.isArray(event?.segs)
            ? event.segs.map((segment) => segment?.utf8 ?? "").join("")
            : ""
        )
      }))
      .filter((row) => Number.isFinite(row.startMs) && row.text)
      .sort((a, b) => a.startMs - b.startMs);

    return rows.map((row, index) => {
      const nextStartMs = rows[index + 1]?.startMs;
      const fallbackDuration = Number.isFinite(nextStartMs)
        ? Math.max(1, nextStartMs - row.startMs)
        : 2000;
      const durationMs = Number.isFinite(row.durationMs) && row.durationMs > 0
        ? row.durationMs
        : fallbackDuration;

      return {
        startMs: Math.max(0, Math.round(row.startMs)),
        endMs: Math.max(0, Math.round(row.startMs + durationMs)),
        text: row.text
      };
    });
  }

  function parseYouTubeXml(input) {
    if (typeof DOMParser === "undefined") {
      throw new Error("XML parsing requires a browser DOM");
    }

    const documentNode = new DOMParser().parseFromString(input, "text/xml");
    if (documentNode.querySelector("parsererror")) {
      throw new Error("Invalid YouTube caption payload");
    }

    return [...documentNode.querySelectorAll("text")]
      .map((node) => {
        const startMs = Math.round(Number(node.getAttribute("start")) * 1000);
        const durationMs = Math.round(Number(node.getAttribute("dur")) * 1000);
        return {
          startMs,
          endMs: startMs + (durationMs > 0 ? durationMs : 2000),
          text: cleanText(node.textContent)
        };
      })
      .filter((row) => Number.isFinite(row.startMs) && row.text);
  }

  function parseYouTubePayload(input) {
    try {
      return parseYouTubeJson3(input);
    } catch {
      return parseYouTubeXml(input);
    }
  }

  function getYouTubeCaptionTracks(playerResponse) {
    const tracks = playerResponse?.captions
      ?.playerCaptionsTracklistRenderer
      ?.captionTracks;

    return (Array.isArray(tracks) ? tracks : [])
      .map((track, index) => {
        const url = String(track?.baseUrl || "");
        if (!url) return null;
        const language = cleanText(track?.languageCode) || "unknown";
        const label = cleanText(
          track?.name?.simpleText
          || track?.name?.runs?.map((run) => run?.text || "").join("")
          || language
        );
        return {
          id: cleanText(track?.vssId) || `${language}:${cleanText(track?.kind) || "manual"}:${index}`,
          language,
          label,
          url
        };
      })
      .filter(Boolean);
  }

  function parseYouTubeChapters(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    const markers = data?.playerOverlays
      ?.playerOverlayRenderer
      ?.decoratedPlayerBarRenderer
      ?.decoratedPlayerBarRenderer
      ?.playerBar
      ?.multiMarkersPlayerBarRenderer
      ?.markersMap;
    const marker = (Array.isArray(markers) ? markers : []).find((item) =>
      item?.key === "DESCRIPTION_CHAPTERS"
    ) || (Array.isArray(markers) ? markers : []).find((item) =>
      item?.key === "AUTO_CHAPTERS"
    ) || (Array.isArray(markers) ? markers : []).find((item) =>
      Array.isArray(item?.value?.chapters) && item.value.chapters.length
    );

    return (Array.isArray(marker?.value?.chapters) ? marker.value.chapters : [])
      .map((item) => {
        const chapter = item?.chapterRenderer;
        const startMs = Number(chapter?.timeRangeStartMillis);
        const title = cleanText(
          chapter?.title?.simpleText
          || chapter?.title?.runs?.map((run) => run?.text || "").join("")
        );
        return { startMs: Math.max(0, Math.round(startMs)), title };
      })
      .filter((chapter) => Number.isFinite(chapter.startMs) && chapter.title)
      .sort((a, b) => a.startMs - b.startMs);
  }

  function parseBilibiliJson(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    const body = Array.isArray(data?.body) ? data.body : [];

    return body
      .map((item) => {
        const startMs = Math.round(Number(item?.from) * 1000);
        const endMs = Math.round(Number(item?.to) * 1000);
        return {
          startMs,
          endMs: endMs > startMs ? endMs : startMs + 2000,
          text: cleanText(item?.content)
        };
      })
      .filter((row) => Number.isFinite(row.startMs) && row.text);
  }

  function parseBilibiliChapters(input) {
    const items = Array.isArray(input) ? input : [];
    return items
      .filter((item) => item?.type === 2)
      .map((item) => ({
        startMs: Math.max(0, Math.round(Number(item.from) * 1000)),
        endMs: Math.max(0, Math.round(Number(item.to) * 1000)),
        title: cleanText(item.content)
      }))
      .filter((item) => Number.isFinite(item.startMs) && item.title)
      .sort((a, b) => a.startMs - b.startMs);
  }

  function isAllowedBilibiliSubtitleUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return false;
      return ["bilibili.com", "hdslb.com"].some((domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      );
    } catch {
      return false;
    }
  }

  function formatTimestamp(milliseconds) {
    const total = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  }

  function formatSrt(captions) {
    return (captions ?? [])
      .map((caption, index) => [
        index + 1,
        `${formatTimestamp(caption.startMs)} --> ${formatTimestamp(caption.endMs)}`,
        caption.text,
        ""
      ].join("\n"))
      .join("\n");
  }

  function sanitizeFileName(value) {
    return cleanText(value || "captions")
      .replace(/[\\/:*?"<>|]/g, "-")
      .slice(0, 100) || "captions";
  }

  globalThis.CaptionLiteParsers = {
    cleanText,
    parseYouTubeJson3,
    parseYouTubePayload,
    getYouTubeCaptionTracks,
    parseYouTubeChapters,
    parseBilibiliJson,
    parseBilibiliChapters,
    isAllowedBilibiliSubtitleUrl,
    formatTimestamp,
    formatSrt,
    sanitizeFileName
  };
})();
