(() => {
  "use strict";

  // Parsers for YouTube's own player data. They run in the page's MAIN world,
  // so they live in their own file: Chrome injects a given file only once per
  // page, and a file shared with the isolated-world scripts would be missing
  // from one of the two worlds.

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
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

  globalThis.CaptionLiteYouTubeParsers = {
    getYouTubeCaptionTracks,
    parseYouTubeChapters
  };
})();
