import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
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
const webDirectory = join(repositoryRoot, "web");

const requiredBuildFiles = ["FreeKill.js", "FreeKill.wasm", "qtloader.js"];
const optionalBuildFiles = ["FreeKill.data", "FreeKill.worker.js"];
const shellFiles = [
  "index.html",
  "bootstrap.js",
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
  if (!new Set([".wasm", ".data", ".js", ".css", ".html", ".json", ".webmanifest"]).has(extname(path))) {
    return;
  }
  await Promise.all([
    writeFile(`${path}.gz`, gzipSync(contents, { level: 9 })),
    writeFile(
      `${path}.br`,
      brotliCompressSync(contents, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    ),
  ]);
}

if (outputDirectory === repositoryRoot || outputDirectory === resolve(outputDirectory, "..")) {
  throw new Error(`Unsafe OUTPUT_DIR: ${outputDirectory}`);
}
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyNamedFiles(buildDirectory, requiredBuildFiles, true);
await copyNamedFiles(buildDirectory, optionalBuildFiles, false);
await copyNamedFiles(webDirectory, shellFiles, true);

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
  assets.push({
    url: publicPath(path),
    size: info.size,
    revision: digest(contents).slice(0, 16),
  });
  await compress(path, contents);
}
assets.sort((left, right) => left.url.localeCompare(right.url));

const version = digest(Buffer.from(JSON.stringify(assets))).slice(0, 16);
const manifest = {
  cacheName: `freekill-web-${version}`,
  assets,
};
await writeFile(
  join(outputDirectory, "asset-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `Packaged ${assets.length} files (${assets.reduce((sum, asset) => sum + asset.size, 0)} bytes) in ${outputDirectory}`,
);
