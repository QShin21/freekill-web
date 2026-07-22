import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".data", "application/octet-stream"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
]);

const NO_STORE = new Set([
  "asset-manifest.json",
  "config.json",
  "index.html",
  "service-worker.js",
]);

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; " +
    "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

async function regularFile(path) {
  try {
    const information = await stat(path);
    return information.isFile() ? information : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function acceptsEncoding(request, encoding) {
  const header = request.headers["accept-encoding"];
  return typeof header === "string" && new RegExp(`(?:^|,|\\s)${encoding}(?:\\s*(?:;|,|$))`, "i").test(header);
}

function requestFile(request, staticRoot) {
  const url = new URL(request.url, "http://static.invalid");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\0")) return null;
  if (pathname.endsWith("/")) pathname += "index.html";
  const candidate = resolve(staticRoot, pathname.replace(/^\/+/, ""));
  const fromRoot = relative(staticRoot, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return candidate;
}

export function createStaticHandler(root) {
  if (!root) return async () => false;
  const staticRoot = resolve(root);

  return async function serveStatic(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;

    let sourcePath;
    try {
      sourcePath = requestFile(request, staticRoot);
    } catch (error) {
      if (error instanceof URIError) return false;
      throw error;
    }
    if (!sourcePath) return false;

    const originalInformation = await regularFile(sourcePath);
    if (!originalInformation) return false;

    let transmittedPath = sourcePath;
    let transmittedInformation = originalInformation;
    let contentEncoding;
    if (acceptsEncoding(request, "br")) {
      const information = await regularFile(`${sourcePath}.br`);
      if (information) {
        transmittedPath = `${sourcePath}.br`;
        transmittedInformation = information;
        contentEncoding = "br";
      }
    }
    if (!contentEncoding && acceptsEncoding(request, "gzip")) {
      const information = await regularFile(`${sourcePath}.gz`);
      if (information) {
        transmittedPath = `${sourcePath}.gz`;
        transmittedInformation = information;
        contentEncoding = "gzip";
      }
    }

    const name = basename(sourcePath);
    const headers = {
      ...SECURITY_HEADERS,
      "cache-control": NO_STORE.has(name) ? "no-store" : "public, max-age=0, must-revalidate",
      "content-length": transmittedInformation.size,
      "content-type": CONTENT_TYPES.get(extname(sourcePath).toLowerCase()) || "application/octet-stream",
      "last-modified": originalInformation.mtime.toUTCString(),
    };
    if (contentEncoding) {
      headers["content-encoding"] = contentEncoding;
      headers.vary = "Accept-Encoding";
    }

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return true;
    }

    await new Promise((resolveStream, rejectStream) => {
      const stream = createReadStream(transmittedPath);
      stream.once("error", rejectStream);
      response.once("close", resolveStream);
      response.once("finish", resolveStream);
      stream.pipe(response);
    });
    return true;
  };
}
