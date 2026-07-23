import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";

const repositoryRoot = resolve(import.meta.dirname, "..");
const buildDirectory = resolve(process.env.BUILD_DIR || join(repositoryRoot, "build", "wasm"));
const outputDirectory = resolve(process.env.OUTPUT_DIR || join(repositoryRoot, "dist"));
const webMediaDirectory = process.env.WEB_MEDIA_DIR
  ? resolve(process.env.WEB_MEDIA_DIR)
  : null;
const reuseDirectory = process.env.REUSE_OUTPUT_DIR
  ? resolve(process.env.REUSE_OUTPUT_DIR)
  : null;
const webDirectory = join(repositoryRoot, "web");

const requiredBuildFiles = ["FreeKill.js", "FreeKill.wasm", "qtloader.js"];
const optionalBuildFiles = ["FreeKill.data", "FreeKill.worker.js"];
const shellFiles = [
  "index.html",
  "bootstrap.js",
  "media-pack.js",
  "styles.css",
  "config.json",
  "manifest.webmanifest",
  "service-worker.js",
];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copyNamedFiles(source, names, required) {
  for (const name of names) {
    const from = join(source, name);
    if (!(await exists(from))) {
      if (required) throw new Error(`Missing build artifact: ${from}`);
      continue;
    }
    await cp(from, join(outputDirectory, name));
  }
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function publicPath(path) {
  return `/${relative(outputDirectory, path).split(sep).join("/")}`;
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function compress(path, contents) {
  const extension = extname(path);
  if (!new Set([".wasm", ".data", ".fkp", ".js", ".css", ".html", ".json", ".webmanifest"]).has(extension)) {
    return;
  }
  // Media packs are already mostly OGG/WebP/PNG. A lower level is effectively
  // the same download size and avoids spending minutes recompressing them.
  const mediaPack = extension === ".fkp";
  if (reuseDirectory && reuseDirectory !== outputDirectory) {
    const previousPath = join(reuseDirectory, relative(outputDirectory, path));
    if (
      (await exists(previousPath)) &&
      (await exists(`${previousPath}.gz`)) &&
      (await exists(`${previousPath}.br`))
    ) {
      const previous = await readFile(previousPath);
      if (previous.length === contents.length && digest(previous) === digest(contents)) {
        await Promise.all([
          cp(`${previousPath}.gz`, `${path}.gz`),
          cp(`${previousPath}.br`, `${path}.br`),
        ]);
        return;
      }
    }
  }
  await Promise.all([
    writeFile(`${path}.gz`, gzipSync(contents, { level: mediaPack ? 6 : 9 })),
    writeFile(
      `${path}.br`,
      brotliCompressSync(contents, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: mediaPack ? 5 : 11 },
      }),
    ),
  ]);
}

async function linkOrCopy(source, destination) {
  await mkdir(resolve(destination, ".."), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    if (!["EACCES", "ENOTSUP", "EPERM", "EXDEV"].includes(error?.code)) throw error;
    await cp(source, destination);
  }
}

if (outputDirectory === repositoryRoot || outputDirectory === resolve(outputDirectory, "..")) {
  throw new Error(`Unsafe OUTPUT_DIR: ${outputDirectory}`);
}
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyNamedFiles(buildDirectory, requiredBuildFiles, true);
await copyNamedFiles(buildDirectory, optionalBuildFiles, false);
await copyNamedFiles(webDirectory, shellFiles, true);

let deferredPacks = [];
if (webMediaDirectory) {
  const mediaManifestPath = join(webMediaDirectory, "media-manifest.json");
  if (!(await exists(mediaManifestPath))) {
    throw new Error(`Missing deferred media manifest: ${mediaManifestPath}`);
  }
  const mediaManifest = JSON.parse(await readFile(mediaManifestPath, "utf8"));
  if (mediaManifest.version !== 1 || !Array.isArray(mediaManifest.packs)) {
    throw new Error(`Unsupported deferred media manifest: ${mediaManifestPath}`);
  }
  deferredPacks = mediaManifest.packs;
  await cp(mediaManifestPath, join(outputDirectory, "media-manifest.json"));
  if (deferredPacks.length > 0) {
    await cp(join(webMediaDirectory, "media"), join(outputDirectory, "media"), {
      recursive: true,
    });
  }
}

const deferredUrls = new Set(deferredPacks.map((pack) => pack.url));

const candidates = (await listFiles(outputDirectory)).filter(
  (path) =>
    basename(path) !== "asset-manifest.json" &&
    !path.endsWith(".gz") &&
    !path.endsWith(".br") &&
    basename(path) !== "config.json",
);

const assets = [];
for (const path of candidates) {
  const contents = await readFile(path);
  const info = await stat(path);
  await compress(path, contents);
  const compressedPath = `${path}.br`;
  assets.push({
    url: publicPath(path),
    size: info.size,
    downloadSize: (await exists(compressedPath)) ? (await stat(compressedPath)).size : info.size,
    revision: digest(contents).slice(0, 16),
    startup: !deferredUrls.has(publicPath(path)),
  });
}
assets.sort((left, right) => left.url.localeCompare(right.url));

// CDN configurations often ignore query parameters when constructing their
// cache key. Publish startup artifacts under revision-specific paths so two
// releases can never be mixed even when different edge nodes retain old data.
for (const asset of assets.filter((candidate) => candidate.startup !== false)) {
  const source = join(outputDirectory, asset.url.replace(/^\/+/, ""));
  const destination = join(
    outputDirectory,
    ".freekill-assets",
    asset.revision,
    asset.url.replace(/^\/+/, ""),
  );
  await linkOrCopy(source, destination);
  for (const suffix of [".br", ".gz"]) {
    if (await exists(`${source}${suffix}`)) {
      await linkOrCopy(`${source}${suffix}`, `${destination}${suffix}`);
    }
  }
}

const version = digest(Buffer.from(JSON.stringify(assets))).slice(0, 16);
const manifest = {
  cacheName: `freekill-web-${version}`,
  assets,
  deferredPacks,
};
await writeFile(
  join(outputDirectory, "asset-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const startupBytes = assets
  .filter((asset) => asset.startup)
  .reduce((sum, asset) => sum + asset.downloadSize, 0);
const deferredBytes = assets
  .filter((asset) => !asset.startup)
  .reduce((sum, asset) => sum + asset.downloadSize, 0);
console.log(
  `Packaged ${assets.length} files (${startupBytes} startup bytes, ` +
    `${deferredBytes} deferred bytes) in ${outputDirectory}`,
);
