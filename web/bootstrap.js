const loading = document.querySelector("#loading");
const message = document.querySelector("#loading-message");
const detail = document.querySelector("#loading-detail");
const progress = document.querySelector("#loading-progress");
const retry = document.querySelector("#retry");
const screen = document.querySelector("#screen");

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

async function fetchAndCache(cache, asset, onBytes) {
  const cached = await cache.match(asset.url);
  if (cached) {
    onBytes(asset.size);
    return;
  }

  const response = await fetch(asset.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${asset.url}: HTTP ${response.status}`);
  await cache.put(asset.url, response.clone());
  onBytes(asset.size);
}

async function warmApplicationCache() {
  if (!("caches" in window)) {
    showStatus("正在加载游戏资源……", "当前浏览器不支持离线缓存。", null);
    return;
  }

  const response = await fetch("asset-manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`asset-manifest.json: HTTP ${response.status}`);
  const manifest = await response.json();
  const cache = await caches.open(manifest.cacheName);
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.size, 0);
  let completedBytes = 0;
  const queue = [...manifest.assets];

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
      await fetchAndCache(cache, asset, onBytes);
    }
  });
  await Promise.all(workers);

  const existing = await caches.keys();
  await Promise.all(
    existing
      .filter((name) => name.startsWith("freekill-web-") && name !== manifest.cacheName)
      .map((name) => caches.delete(name)),
  );
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("service-worker.js", { scope: "./" });
  await navigator.serviceWorker.ready;
}

async function loadQtApplication() {
  if (typeof window.qtLoad !== "function" || typeof window.createQtAppInstance !== "function") {
    throw new Error("Qt WebAssembly loader is missing");
  }

  showStatus("正在启动 FreeKill……", "正在初始化 WebAssembly 和游戏脚本。", null);
  await window.qtLoad({
    qt: {
      entryFunction: window.createQtAppInstance,
      containerElements: [screen],
      onLoaded() {
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
        const { FS, IDBFS, addRunDependency, removeRunDependency } = runtime;
        if (!FS || !IDBFS) return;
        if (!FS.analyzePath("/persistent").exists) FS.mkdir("/persistent");
        FS.mount(IDBFS, {}, "/persistent");
        addRunDependency("freekill-idbfs");
        FS.syncfs(true, (error) => {
          if (error) console.warn("Unable to restore FreeKill persistent data", error);
          removeRunDependency("freekill-idbfs");
        });
      },
    ],
  });
}

async function start() {
  retry.hidden = true;
  document.body.dataset.state = "loading";
  try {
    await Promise.all([loadConfiguration(), registerServiceWorker()]);
    await warmApplicationCache();
    await loadQtApplication();
  } catch (error) {
    console.error(error);
    document.body.dataset.state = "error";
    showStatus("无法启动 FreeKill", error instanceof Error ? error.message : String(error), 0);
    retry.hidden = false;
  }
}

retry.addEventListener("click", () => location.reload());
void start();
