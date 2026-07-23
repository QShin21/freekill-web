import { unpackMediaPack } from "./media-pack.js";

const loading = document.querySelector("#loading");
const message = document.querySelector("#loading-message");
const detail = document.querySelector("#loading-detail");
const progress = document.querySelector("#loading-progress");
const retry = document.querySelector("#retry");
const screen = document.querySelector("#screen");
const CACHE_PREFIX = "freekill-web-";
const MAX_ASSET_ATTEMPTS = 4;
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
  if (asset.startup === false) return new URL(asset.url, location.href).href;
  const path = asset.url.replace(/^\/+/, "");
  return new URL(`/.freekill-assets/${asset.revision}/${path}`, location.href).href;
}

function cacheRequestUrl(asset) {
  return asset.startup === false ? asset.url : revisionedAssetUrl(asset);
}

function manifestAsset(manifest, url) {
  const asset = manifest.assets.find((candidate) => candidate.url === url);
  if (!asset) throw new Error(`Missing asset metadata for ${url}`);
  return asset;
}

function loadScriptAsset(manifest, url) {
  const asset = manifestAsset(manifest, url);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = revisionedAssetUrl(asset);
    script.async = false;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error(`Unable to load ${url} revision ${asset.revision}`)),
      { once: true },
    );
    document.head.append(script);
  });
}

async function loadQtRuntime(manifest) {
  await loadScriptAsset(manifest, "/qtloader.js");
  await loadScriptAsset(manifest, "/FreeKill.js");
}

async function cacheAsset(cache, asset, response) {
  const requestUrl = cacheRequestUrl(asset);
  const markerUrl = revisionKey(asset);
  await cache.delete(requestUrl);
  await cache.delete(markerUrl);
  try {
    // Write the revision marker only after the complete response is safely in
    // Cache Storage. Otherwise an interrupted network stream can leave a
    // current marker beside a missing or partial package.
    await cache.put(requestUrl, response);
    await cache.put(markerUrl, new Response(asset.revision));
  } catch (error) {
    await Promise.all([cache.delete(requestUrl), cache.delete(markerUrl)]);
    throw error;
  }
}

async function matchingResponse(cache, asset) {
  const [response, marker] = await Promise.all([
    cache.match(cacheRequestUrl(asset)),
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

function retryDelay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)));
}

async function downloadAsset(asset, onRetry = () => {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ASSET_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await retryDelay(attempt - 1);
    try {
      const response = await fetch(revisionedAssetUrl(asset), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // Fully materialize and validate the decoded response before handing it
      // to Cache Storage. This separates CDN/network failures from cache
      // writes and prevents Cache.put() from consuming a broken live stream.
      const payload = await response.blob();
      if (asset.size && payload.size !== asset.size) {
        throw new Error(`size mismatch: expected ${asset.size}, received ${payload.size}`);
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(payload, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ASSET_ATTEMPTS) onRetry(asset, attempt + 1, error);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${asset.url}: failed after ${MAX_ASSET_ATTEMPTS} attempts (${reason})`);
}

async function fetchAndCache(
  cacheName,
  cache,
  asset,
  onBytes = () => {},
  onRetry = () => {},
  allowNetwork = true,
) {
  const reusable = await reusableResponse(cacheName, cache, asset);
  if (reusable) {
    if (!reusable.alreadyCurrent) await cacheAsset(cache, asset, reusable.response.clone());
    onBytes(downloadSize(asset));
    return true;
  }
  if (!allowNetwork) return false;
  await cacheAsset(cache, asset, await downloadAsset(asset, onRetry));
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
  const requiredAssets = manifest.assets;
  const totalBytes = requiredAssets.reduce((sum, asset) => sum + downloadSize(asset), 0);
  let completedBytes = 0;
  const queue = [...requiredAssets];

  const onBytes = (bytes) => {
    completedBytes += bytes;
    const ratio = totalBytes === 0 ? 1 : completedBytes / totalBytes;
    showStatus(
      "正在缓存游戏资源……",
      `${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}`,
      ratio,
    );
  };

  const onRetry = (asset, attempt, error) => {
    const reason = error instanceof Error ? error.message : String(error);
    showStatus(
      "网络波动，正在重试资源……",
      `${asset.url}（第 ${attempt}/${MAX_ASSET_ATTEMPTS} 次）· ${reason}`,
      totalBytes === 0 ? 0 : completedBytes / totalBytes,
    );
  };

  // Two concurrent transfers keep the browser responsive and avoid several
  // large package streams competing on a constrained connection.
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length > 0) {
      const asset = queue.shift();
      await fetchAndCache(manifest.cacheName, cache, asset, onBytes, onRetry);
    }
  });
  await Promise.all(workers);

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

const fittedQtCanvases = new WeakSet();

function fitQtCanvas(canvas) {
  if (fittedQtCanvases.has(canvas)) return;
  fittedQtCanvases.add(canvas);
  for (const property of ["width", "height"]) {
    canvas.style.setProperty(property, "100%", "important");
  }
  for (const property of ["min-width", "min-height"]) {
    canvas.style.setProperty(property, "0", "important");
  }
  for (const property of ["max-width", "max-height"]) {
    canvas.style.setProperty(property, "100%", "important");
  }
  requestAnimationFrame(() => {
    const bounds = canvas.getBoundingClientRect();
    console.info(
      `[FreeKill] Qt canvas backing ${canvas.width}x${canvas.height}, CSS ${bounds.width}x${bounds.height}, DPR ${window.devicePixelRatio}`,
    );
  });
}

function installQtCanvasFitStyle() {
  const shadowRoot = screen.querySelector("#qt-shadow-container")?.shadowRoot;
  if (!shadowRoot) return null;
  if (!shadowRoot.querySelector("#freekill-canvas-fit")) {
    const style = document.createElement("style");
    style.id = "freekill-canvas-fit";
    style.textContent = `
      canvas.qt-window-content {
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        max-width: 100%;
        max-height: 100%;
      }
    `;
    shadowRoot.append(style);
  }
  shadowRoot.querySelectorAll("canvas.qt-window-content").forEach(fitQtCanvas);
  return shadowRoot;
}

function fitQtCanvasesToWindows() {
  let shadowObserver = null;
  const attachToShadowRoot = () => {
    const shadowRoot = installQtCanvasFitStyle();
    if (!shadowRoot || shadowObserver) return Boolean(shadowRoot);
    shadowObserver = new MutationObserver(() => installQtCanvasFitStyle());
    shadowObserver.observe(shadowRoot, { childList: true, subtree: true });
    return true;
  };
  if (attachToShadowRoot()) return;
  const observer = new MutationObserver(() => {
    if (attachToShadowRoot()) observer.disconnect();
  });
  observer.observe(screen, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 10_000);
}

async function mountMediaResponse(runtime, manifest, pack, response) {
  const key = `${pack.id}:${pack.revision}`;
  if (mountedMediaPacks.has(key)) return;
  mediaStatus(manifest, "mounting", pack);
  const count = unpackMediaPack(runtime.FS, await response.arrayBuffer());
  mountedMediaPacks.add(key);
  mediaStatus(manifest, "mounted", pack);
  console.info(`Mounted ${count} required media files from ${pack.id}`);
}

async function requiredMediaResponse(context, pack) {
  const asset = context.manifest.assets.find((candidate) => candidate.url === pack.url);
  if (!asset) throw new Error(`Missing required media asset metadata: ${pack.url}`);
  if (context.cache) {
    const response = await matchingResponse(context.cache, asset);
    if (!response) throw new Error(`Required media pack is not cached: ${pack.url}`);
    return response;
  }
  const response = await fetch(revisionedAssetUrl(asset), { cache: "no-store" });
  if (!response.ok) throw new Error(`${pack.url}: HTTP ${response.status}`);
  return response;
}

async function mountRequiredMedia(runtime, context) {
  for (const pack of context.manifest.deferredPacks || []) {
    await mountMediaResponse(
      runtime,
      context.manifest,
      pack,
      await requiredMediaResponse(context, pack),
    );
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

  const runtimeAssets = new Map(context.manifest.assets.map((asset) => [asset.url, asset]));
  const locateRuntimeFile = (filename) => {
    const logicalPath = filename.startsWith("/") ? filename : `/${filename}`;
    const asset = runtimeAssets.get(logicalPath);
    return asset ? revisionedAssetUrl(asset) : filename;
  };

  showStatus("正在启动 FreeKill……", "正在挂载完整扩展包（含图片和音频）。", null);
  await qtLoader({
    locateFile: locateRuntimeFile,
    print(text) {
      console.info(`[FreeKill] ${text}`);
    },
    printErr(text) {
      console.error(`[FreeKill] ${text}`);
    },
    qt: {
      entryFunction,
      containerElements: [screen],
      onLoaded() {
        fitQtCanvasesToWindows();
        document.body.dataset.state = "ready";
        loading.setAttribute("aria-hidden", "true");
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
      function mountCompletePackageMedia(module) {
        const runtime = module || this;
        if (!(context.manifest.deferredPacks || []).length) return;
        const dependency = "freekill-required-media";
        runtime.addRunDependency(dependency);
        void mountRequiredMedia(runtime, context).then(
          () => runtime.removeRunDependency(dependency),
          (error) => {
            console.error("Unable to mount required package media", error);
            mediaStatus(context.manifest, "error", null, error);
            document.body.dataset.state = "error";
            showStatus(
              "无法加载完整扩展包",
              error instanceof Error ? error.message : String(error),
              0,
            );
            retry.hidden = false;
          },
        );
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
    await loadQtRuntime(context.manifest);
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
