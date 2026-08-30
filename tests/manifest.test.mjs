import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, "114");
assert.deepEqual(manifest.permissions.sort(), ["clipboardWrite", "sidePanel", "storage"]);
assert.ok(!manifest.host_permissions.includes("<all_urls>"));
assert.ok(!manifest.host_permissions.includes("https://translation.googleapis.com/*"));
assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
assert.deepEqual(manifest.action.default_icon, {
  "16": "assets/icons/icon-16.png",
  "32": "assets/icons/icon-32.png"
});

const bilibiliMain = manifest.content_scripts.find((script) =>
  script.js?.includes("src/bilibili-main.js")
);
assert.equal(bilibiliMain?.world, "MAIN");
assert.deepEqual(bilibiliMain?.js, ["src/bilibili-comments.js", "src/bilibili-main.js"]);
const youtubeMain = manifest.content_scripts.find((script) =>
  script.js?.includes("src/youtube-main.js")
);
assert.equal(youtubeMain?.world, "MAIN");
assert.deepEqual(youtubeMain?.js, ["src/parsers.js", "src/youtube-main.js"]);
assert.ok(manifest.web_accessible_resources.some((entry) =>
  entry.resources.includes("src/sidepanel.html")
  && entry.resources.includes("src/sidepanel.css")
  && entry.matches.includes("https://*.youtube.com/*")
  && entry.matches.includes("https://*.bilibili.com/*")
));

const isolatedContent = manifest.content_scripts.find((script) =>
  script.js?.includes("src/content.js")
);
assert.deepEqual(isolatedContent?.js, [
  "src/parsers.js",
  "src/sidepanel.js",
  "src/content.js"
]);

const contentSource = await readFile(resolve(projectRoot, "src/content.js"), "utf8");
assert.match(contentSource, /attachShadow\(\{ mode: "open" \}\)/);
assert.doesNotMatch(contentSource, /createElement\("iframe"\)/);
assert.match(contentSource, /embeddedPanel\?\.setState\(latestState\)/);
assert.match(contentSource, /embeddedPanel\?\.setPlayback\(latestPlaybackMs\)/);
assert.match(contentSource, /function mountYouTubePanel\(\)/);
assert.match(contentSource, /ytd-watch-flexy #secondary-inner/);
assert.match(contentSource, /document\.body\.append\(embedRoot\)/);
assert.doesNotMatch(contentSource, /danmakuBox\.before\(|sidebar\.prepend\(/);
assert.match(contentSource, /document\.querySelector\("\.video-pod"\)/);
assert.match(contentSource, /playlistContainer\.style\.paddingTop/);
assert.match(contentSource, /embeddedPanelCollapsed\s*\? COLLAPSED_PANEL_HEIGHT/);
assert.match(contentSource, /COLLAPSED_PANEL_HEIGHT = 174/);
assert.match(contentSource, /function scheduleBilibiliRetry\(pageKey\)/);
assert.match(contentSource, /bilibiliRetryDelay \* 1\.6/);
assert.match(contentSource, /BILIBILI_MAX_RETRY_DELAY = 10_000/);
assert.match(contentSource, /loadBilibili\(true\)/);
assert.match(contentSource, /tracks\.length\) resetBilibiliRetry\(identity\.pageKey\)/);
assert.match(contentSource, /BILIBILI_COMMENTS_PROGRESS/);
assert.match(contentSource, /BILIBILI_COMMENTS_RESULT/);
assert.match(contentSource, /navigator\.clipboard\.writeText/);
assert.match(contentSource, /pendingCommentCopy/);

const panelSource = await readFile(resolve(projectRoot, "src/sidepanel.js"), "utf8");
assert.match(panelSource, /setPlayback\(currentMs\)/);
assert.match(panelSource, /captionList\.scrollTo\(/);
assert.match(panelSource, /const wheelTarget = embedded && root\.host/);
assert.match(panelSource, /if \(!embedded \|\| response\?\.state\)/);
assert.match(panelSource, /atBottom && event\.deltaY > 0/);
assert.doesNotMatch(panelSource, /elements\.autoScroll/);
assert.match(panelSource, /pauseAutoScrollTemporarily/);
assert.match(panelSource, /let autoScrollActive = true/);
assert.match(panelSource, /autoScrollActive = false/);
assert.match(panelSource, /highlightCurrentCaption\(true\);\s*\}, 3000\)/);
assert.match(panelSource, /onCollapsedChange\?\.\(collapsed\)/);
assert.match(panelSource, /aria-expanded/);
assert.match(panelSource, /\[\$\{formatClock\(caption\.startMs\)\}\] \$\{caption\.text\}/);
assert.match(panelSource, /COPY_BILIBILI_COMMENTS/);
assert.match(panelSource, /setCommentCopyState/);
assert.doesNotMatch(panelSource, /TRANSLATE_CAPTIONS|Google 翻译/);

const panelMarkup = await readFile(resolve(projectRoot, "src/sidepanel.html"), "utf8");
assert.doesNotMatch(panelMarkup, /translate-row|Google 翻译/);
assert.doesNotMatch(panelMarkup, /auto-scroll|自动跟随/);
assert.match(panelMarkup, /<h1>字幕列表<\/h1>/);
assert.match(panelMarkup, /复制（含时间）/);
assert.match(panelMarkup, /id="collapse-button"/);
assert.match(panelMarkup, /id="copy-comments-button"/);

const panelStyles = await readFile(resolve(projectRoot, "src/sidepanel.css"), "utf8");
assert.match(panelStyles, /\.caption-row \.text \{ font-size: 17px; \}/);
assert.match(panelStyles, /font-family: ui-monospace/);
assert.match(panelStyles, /box-shadow: inset 3px 0 var\(--accent\)/);
assert.match(panelStyles, /\.caption-lite-app\.embedded\.collapsed \.caption-list/);
assert.match(panelStyles, /\.copy-comments-button\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
assert.doesNotMatch(panelStyles, /\.caption-lite-app\.embedded\.collapsed \.footer/);

const serviceWorkerSource = await readFile(resolve(projectRoot, "src/service-worker.js"), "utf8");
assert.doesNotMatch(serviceWorkerSource, /TRANSLATE_CAPTIONS|translation\.googleapis\.com|private-config/);
assert.match(serviceWorkerSource, /COPY_BILIBILI_COMMENTS/);
assert.match(serviceWorkerSource, /COMMENTS_COPY_STATE/);

const bilibiliSource = await readFile(resolve(projectRoot, "src/bilibili-main.js"), "utf8");
assert.match(bilibiliSource, /LOAD_BILIBILI"\) load\(true\)/);
assert.match(bilibiliSource, /setInterval\(\(\) => load\(false\), 500\)/);
assert.match(bilibiliSource, /LOAD_BILIBILI_COMMENTS/);
assert.match(bilibiliSource, /BILIBILI_COMMENTS_PROGRESS/);
assert.match(bilibiliSource, /BILIBILI_COMMENTS_RESULT/);
assert.match(bilibiliSource, /\/x\/v2\/reply\/wbi\/main/);
assert.match(bilibiliSource, /\/x\/v2\/reply\/reply/);
assert.match(bilibiliSource, /async function fetchWbiKeys\(\)/);
assert.match(bilibiliSource, /extractWbiKeys\(data\?\.wbi_img\)/);
assert.doesNotMatch(bilibiliSource, /fetchJson\("https:\/\/api\.bilibili\.com\/x\/web-interface\/nav"\)/);

const youtubeSource = await readFile(resolve(projectRoot, "src/youtube-main.js"), "utf8");
assert.match(youtubeSource, /getPlayerResponse\(\)/);
assert.match(youtubeSource, /url\.searchParams\.set\("fmt", "json3"\)/);
assert.match(youtubeSource, /event\.data\?\.type === "LOAD_YOUTUBE"/);
assert.match(youtubeSource, /YOUTUBE_CHAPTERS/);
assert.match(youtubeSource, /\/youtubei\/v1\/next/);
assert.match(youtubeSource, /setInterval\(\(\) => loadCaptionTracks\(false\), 750\)/);

const referencedFiles = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => script.js || [])
];

for (const file of new Set(referencedFiles)) {
  await access(resolve(projectRoot, file));
}

console.log("Manifest checks passed.");
