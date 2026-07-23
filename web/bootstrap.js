import { unpackMediaPack } from "./media-pack.js";

const loading = document.querySelector("#loading");
const message = document.querySelector("#loading-message");
const detail = document.querySelector("#loading-detail");
const progress = document.querySelector("#loading-progress");
const retry = document.querySelector("#retry");
const screen = document.querySelector("#screen");
const CACHE_PREFIX = "freekill-web-";
const mountedMediaPacks = new Set();

function showStatus(title, description = "", value = null) {
  message.textContent = title;
  detail.textContent = description;
  if (value === null) {
    progress.removeAttribute("value");
  } else {
    progress.value = Math.max(0, Math.min(1, value));
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

async function loadConfiguration() {
  const response = await fetch("config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`config.json: HTTP ${response.status}`);
  const config = await response.json();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const webSocketPath = config.webSocketPath || "/ws";
  window.FREEKILL_WEB_CONFIG = {
    ...config,
    webSocketUrl: config.webSocketUrl || `${scheme}//${location.host}${webSocketPath}`,
  };
}

function downloadSize(asset) {
  return asset.downloadSize || asset.size;
}

function revisionKey(asset) {
  // Deferred media packs already carry their revision in the filename, so
  // their existing cache markers are safe to reuse. Startup artifacts use
  // stable filenames and need a new marker namespace after switching to
  // revisioned CDN requests, otherwise a stale CDN response cached under a
  // current manifest revision could be reused indefinitely.
  const markerVersion = asset.startup === false ? "" : "v2/";
  return `/.freekill-cache/${markerVersion}${asset.revision}/${encodeURIComponent(asset.url)}`;
}

function revisionedAssetUrl(asset) {
  const url = new URL(asset.url, location.href);
  url.searchParams.set("v", asset.revision);
  return url.href;
}

async function cacheAsset(cache, asset, response) {
  await Promise.all([
    cache.put(asset.url, response),
    cache.put(revisionKey(asset), new Response(asset.revision)),
  ]);
}

async function matchingResponse(cache, asset) {
  const [response, marker] = await Promise.all([
    cache.match(asset.url),
    cache.match(revisionKey(asset)),
  ]);
  return response && marker ? response : null;
}

async function reusableResponse(cacheName, cache, asset) {
  const current = await matchingResponse(cache, asset);
  if (current) {
    return { response: current, alreadyCurrent: true };
  }

  for (const name of await caches.keys()) {
    if (!name.startsWith(CACHE_PREFIX) || name === cacheName) continue;
    const previous = await caches.open(name);
    const candidate = await matchingResponse(previous, asset);
    if (candidate) {
      return { response: candidate, alreadyCurrent: false };
    }
  }
  return null;
}

async function fetchAndCache(cacheName, cache, asset, onBytes = () => {}, allowNetwork = true) {
  const reusable = await reusableResponse(cacheName, cache, asset);
  if (reusable) {
    if (!reusable.alreadyCurrent) await cacheAsset(cache, asset, reusable.response.clone());
    onBytes(downloadSize(asset));
    return true;
  }
  if (!allowNetwork) return false;
  const response = await fetch(revisionedAssetUrl(asset), { cache: "no-store" });
  if (!response.ok) throw new Error(`${asset.url}: HTTP ${response.status}`);
  await cacheAsset(cache, asset, response);
  onBytes(downloadSize(asset));
  return true;
}

async function warmApplicationCache() {
  const response = await fetch("asset-manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`asset-manifest.json: HTTP ${response.status}`);
  const manifest = await response.json();
  if (!("caches" in window)) {
    showStatus("正在加载游戏资源……", "当前浏览器不支持离线缓存。", null);
    return { manifest, cache: null };
  }

  const cache = await caches.open(manifest.cacheName);
  const startupAssets = manifest.assets.filter((asset) => asset.startup !== false);
  const deferredAssets = manifest.assets.filter((asset) => asset.startup === false);
  const totalBytes = startupAssets.reduce((sum, asset) => sum + downloadSize(asset), 0);
  let completedBytes = 0;
  const queue = [...startupAssets];

  const onBytes = (bytes) => {
    completedBytes += bytes;
    const ratio = totalBytes === 0 ? 1 : completedBytes / totalBytes;
    showStatus(
      "正在缓存游戏资源……",
      `${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}`,
      ratio,
    );
  };

  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const asset = queue.shift();
      await fetchAndCache(manifest.cacheName, cache, asset, onBytes);
    }
  });
  await Promise.all(workers);

  // Preserve unchanged deferred packs before removing an older build cache.
  for (const asset of deferredAssets) {
    await fetchAndCache(manifest.cacheName, cache, asset, undefined, false);
  }
  const existing = await caches.keys();
  await Promise.all(
    existing
      .filter((name) => name.startsWith("freekill-web-") && name !== manifest.cacheName)
      .map((name) => caches.delete(name)),
  );
  return { manifest, cache };
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("service-worker.js", { scope: "./" });
  await navigator.serviceWorker.ready;
}

function mediaStatus(manifest, state, pack = null, error = null) {
  const status = {
    state,
    total: manifest.deferredPacks?.length || 0,
    mounted: mountedMediaPacks.size,
    pack: pack?.id || null,
    error: error ? String(error) : null,
  };
  window.FREEKILL_MEDIA_STATUS = status;
  window.dispatchEvent(new CustomEvent("freekill-media-status", { detail: status }));
}

async function mountMediaResponse(runtime, manifest, pack, response) {
  const key = `${pack.id}:${pack.revision}`;
  if (mountedMediaPacks.has(key)) return;
  mediaStatus(manifest, "mounting", pack);
  const count = unpackMediaPack(runtime.FS, await response.arrayBuffer());
  mountedMediaPacks.add(key);
  mediaStatus(manifest, "mounted", pack);
  console.info(`Mounted ${count} deferred media files from ${pack.id}`);
}

async function mountCachedMedia(runtime, context) {
  if (!context.cache) return;
  for (const pack of context.manifest.deferredPacks || []) {
    const response = await context.cache.match(pack.url);
    if (response) await mountMediaResponse(runtime, context.manifest, pack, response);
  }
}

async function downloadDeferredMedia(runtime, context) {
  const packs = context.manifest.deferredPacks || [];
  if (packs.length === 0) return;
  const assets = new Map(context.manifest.assets.map((asset) => [asset.url, asset]));
  mediaStatus(context.manifest, "downloading");

  for (const pack of packs) {
    const key = `${pack.id}:${pack.revision}`;
    if (mountedMediaPacks.has(key)) continue;
    try {
      let response;
      if (context.cache) {
        const asset = assets.get(pack.url);
        if (!asset) throw new Error(`Missing asset metadata for ${pack.url}`);
        await fetchAndCache(context.manifest.cacheName, context.cache, asset);
        response = await context.cache.match(pack.url);
      } else {
        response = await fetch(pack.url, { cache: "no-store" });
        if (!response.ok) throw new Error(`${pack.url}: HTTP ${response.status}`);
      }
      if (!response) throw new Error(`Unable to read cached media pack: ${pack.url}`);
      await mountMediaResponse(runtime, context.manifest, pack, response);
    } catch (error) {
      console.warn(`Unable to load deferred media pack ${pack.id}`, error);
      mediaStatus(context.manifest, "error", pack, error);
    }
  }
  mediaStatus(context.manifest, "ready");
}

async function loadQtApplication(context) {
  const qtLoader =
    typeof window.qtLoad === "function"
      ? window.qtLoad
      : typeof qtLoad === "function"
        ? qtLoad
        : null;
  const entryFunction =
    typeof window.createQtAppInstance === "function"
      ? window.createQtAppInstance
      : typeof window.FreeKill_entry === "function"
        ? window.FreeKill_entry
        : typeof FreeKill_entry === "function"
          ? FreeKill_entry
          : null;
  if (!qtLoader || !entryFunction) {
    throw new Error("Qt WebAssembly loader is missing");
  }

  let runtimeModule;
  showStatus("正在启动 FreeKill……", "语音和大型动画将在进入游戏后于后台缓存。", null);
  await qtLoader({
    qt: {
      entryFunction,
      containerElements: [screen],
      onLoaded() {
        document.body.dataset.state = "ready";
        loading.setAttribute("aria-hidden", "true");
        if (runtimeModule) void downloadDeferredMedia(runtimeModule, context);
      },
      onExit(exitData) {
        document.body.dataset.state = "error";
        showStatus("游戏已经退出", exitData?.text || "请刷新页面重新进入。", 0);
        retry.hidden = false;
      },
    },
    preRun: [
      function mountPersistentStorage(module) {
        const runtime = module || this;
        runtimeModule = runtime;
        const { FS, addRunDependency, removeRunDependency } = runtime;
        const IDBFS = FS?.filesystems?.IDBFS;
        if (!FS || !IDBFS) return;
        if (!FS.analyzePath("/persistent").exists) FS.mkdir("/persistent");
        FS.mount(IDBFS, {}, "/persistent");
        addRunDependency("freekill-idbfs");
        FS.syncfs(true, (error) => {
          if (error) console.warn("Unable to restore FreeKill persistent data", error);
          removeRunDependency("freekill-idbfs");
        });
      },
      function mountDeferredMedia(module) {
        const runtime = module || this;
        runtimeModule = runtime;
        if (!context.cache || !(context.manifest.deferredPacks || []).length) return;
        const dependency = "freekill-cached-media";
        runtime.addRunDependency(dependency);
        void mountCachedMedia(runtime, context)
          .catch((error) => console.warn("Unable to mount cached media", error))
          .finally(() => runtime.removeRunDependency(dependency));
      },
    ],
  });
}

async function start() {
  retry.hidden = true;
  document.body.dataset.state = "loading";
  try {
    await Promise.all([loadConfiguration(), registerServiceWorker()]);
    const context = await warmApplicationCache();
    await loadQtApplication(context);
  } catch (error) {
    console.error(error);
    document.body.dataset.state = "error";
    showStatus("无法启动 FreeKill", error instanceof Error ? error.message : String(error), 0);
    retry.hidden = false;
  }
}

retry.addEventListener("click", () => location.reload());
void start();
