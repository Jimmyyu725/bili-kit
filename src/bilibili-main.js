(() => {
  "use strict";

  if (window.__captionLiteBilibiliMain) return;
  window.__captionLiteBilibiliMain = true;

  const PAGE_SOURCE = "caption-lite-page";
  const EXTENSION_SOURCE = "caption-lite-extension";
  let requestId = 0;
  let lastPageKey = "";

  function getIdentity() {
    const url = new URL(location.href);
    const videoId = url.pathname.match(/\/video\/(BV[^/?]+|av\d+)/i)?.[1];
    if (!videoId) return null;
    const pageNumber = Math.max(1, Number(url.searchParams.get("p")) || 1);
    return { videoId, pageNumber, pageKey: `${videoId}:${pageNumber}` };
  }

  function post(payload) {
    window.postMessage({ source: PAGE_SOURCE, type: "BILIBILI_CAPTIONS", payload }, "*");
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (typeof data?.code === "number" && data.code !== 0) {
      throw new Error(data.message || `Bilibili API ${data.code}`);
    }
    return data;
  }

  function absoluteUrl(url) {
    if (url.startsWith("//")) return `https:${url}`;
    return new URL(url, location.href).toString();
  }

  async function load(force = false) {
    const identity = getIdentity();
    if (!identity) return;
    if (!force && identity.pageKey === lastPageKey) return;
    lastPageKey = identity.pageKey;
    const currentRequest = ++requestId;
    post({ ...identity, status: "loading" });

    try {
      const idKey = identity.videoId.toLowerCase().startsWith("av") ? "aid" : "bvid";
      const idValue = idKey === "aid" ? identity.videoId.slice(2) : identity.videoId;
      const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${idKey}=${encodeURIComponent(idValue)}`);
      const video = view.data;
      const page = video.pages?.find((item) => item.page === identity.pageNumber) || video.pages?.[0];
      if (!video?.aid || !page?.cid) throw new Error("无法确定视频 aid/cid");

      const player = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?aid=${video.aid}&cid=${page.cid}`);
      const subtitles = player.data?.subtitle?.subtitles?.filter((item) => item.subtitle_url) || [];
      const tracks = subtitles.map((subtitle, index) => ({
        id: `${subtitle.lan || "unknown"}:${subtitle.id ?? index}`,
        language: subtitle.lan || "unknown",
        label: subtitle.lan_doc || subtitle.lan || `字幕 ${index + 1}`,
        url: absoluteUrl(subtitle.subtitle_url)
      }));

      if (currentRequest !== requestId) return;
      post({
        ...identity,
        status: tracks.length ? "ready" : "empty",
        title: video.title || document.title,
        needLogin: Boolean(player.data?.need_login_subtitle),
        viewPoints: player.data?.view_points || [],
        tracks
      });
    } catch (error) {
      if (currentRequest !== requestId) return;
      post({
        ...identity,
        status: "error",
        error: error instanceof Error ? error.message : "未知错误",
        tracks: []
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== EXTENSION_SOURCE) return;
    if (event.data?.type === "LOAD_BILIBILI") load(true);
  });

  setInterval(() => load(false), 500);
})();
