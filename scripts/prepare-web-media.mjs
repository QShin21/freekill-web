import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PACK_MAGIC = Buffer.from("FKMEDIA1", "ascii");
const PACK_HEADER_BYTES = PACK_MAGIC.length + 4;

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--packages") options.packages = resolve(argv[++index]);
    else if (value === "--output") options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.packages) throw new Error("--packages is required");
  if (!options.output) throw new Error("--output is required");
  return options;
}

function posixPath(path) {
  return path.split(sep).join("/");
}

export function isDeferredMediaPath(path) {
  const parts = posixPath(path).split("/").filter(Boolean);
  if (parts.length < 3) return false;
  const packageName = parts[0];
  const packagePath = parts.slice(1);
  if (packagePath[0] === "audio") return true;
  if (packagePath[0] === "image" && packagePath[1] === "anim") return true;
  return packageName === "mobile_effect" && packagePath[0] === "image";
}

function assertSafeOutput(packagesRoot, outputRoot) {
  const source = resolve(packagesRoot);
  const output = resolve(outputRoot);
  const sourceFromOutput = relative(output, source);
  const outputFromSource = relative(source, output);
  const overlaps =
    source === output ||
    (!sourceFromOutput.startsWith("..") && sourceFromOutput !== "") ||
    (!outputFromSource.startsWith("..") && outputFromSource !== "");
  if (overlaps) throw new Error(`Output must not overlap package sources: ${output}`);
}

async function collectAndCopy(packagesRoot, coreRoot) {
  const deferred = new Map();

  async function visit(directory, relativeDirectory = "") {
    const targetDirectory = join(coreRoot, relativeDirectory);
    await mkdir(targetDirectory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported package entry: ${sourcePath}`);
      }
      if (isDeferredMediaPath(relativePath)) {
        const packageName = posixPath(relativePath).split("/", 1)[0];
        const files = deferred.get(packageName) || [];
        const information = await stat(sourcePath);
        files.push({
          sourcePath,
          size: information.size,
          virtualPath: `/packages/${posixPath(relativePath)}`,
        });
        deferred.set(packageName, files);
      } else {
        const targetPath = join(coreRoot, relativePath);
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      }
    }
  }

  await visit(packagesRoot);
  return deferred;
}

async function writeAll(handle, contents, position) {
  let offset = 0;
  while (offset < contents.length) {
    const { bytesWritten } = await handle.write(
      contents,
      offset,
      contents.length - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error("Unable to make progress while writing media pack");
    offset += bytesWritten;
  }
  return position + contents.length;
}

async function writePack(mediaRoot, packageName, files) {
  files.sort((left, right) => left.virtualPath.localeCompare(right.virtualPath));
  let offset = 0;
  const metadata = {
    version: 1,
    files: files.map((file) => {
      const entry = { path: file.virtualPath, offset, size: file.size };
      offset += file.size;
      return entry;
    }),
  };
  const metadataBuffer = Buffer.from(JSON.stringify(metadata), "utf8");
  const prefix = Buffer.alloc(PACK_HEADER_BYTES);
  PACK_MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(metadataBuffer.length, PACK_MAGIC.length);

  const safeName = packageName.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  const temporaryPath = join(mediaRoot, `.${safeName}.fkp.tmp`);
  const digest = createHash("sha256");
  const handle = await open(temporaryPath, "w");
  try {
    let position = 0;
    position = await writeAll(handle, prefix, position);
    position = await writeAll(handle, metadataBuffer, position);
    digest.update(prefix);
    digest.update(metadataBuffer);
    for (const file of files) {
      const contents = await readFile(file.sourcePath);
      position = await writeAll(handle, contents, position);
      digest.update(contents);
    }
  } finally {
    await handle.close();
  }

  const revision = digest.digest("hex").slice(0, 16);
  const filename = `${safeName}-${revision}.fkp`;
  const finalPath = join(mediaRoot, filename);
  await rename(temporaryPath, finalPath);
  const information = await stat(finalPath);
  return {
    id: packageName,
    url: `/media/${filename}`,
    revision,
    size: information.size,
    unpackedSize: offset,
    files: files.length,
  };
}

export async function prepareWebMedia({ packages, output }) {
  const packagesRoot = resolve(packages);
  const outputRoot = resolve(output);
  assertSafeOutput(packagesRoot, outputRoot);

  const coreRoot = join(outputRoot, "core-packages");
  const publicRoot = join(outputRoot, "public");
  const mediaRoot = join(publicRoot, "media");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(mediaRoot, { recursive: true });

  const deferred = await collectAndCopy(packagesRoot, coreRoot);
  const packs = [];
  for (const [packageName, files] of [...deferred.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    packs.push(await writePack(mediaRoot, packageName, files));
  }

  const manifest = { version: 1, packs };
  await writeFile(
    join(publicRoot, "media-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const manifest = await prepareWebMedia(options);
  const packedBytes = manifest.packs.reduce((sum, pack) => sum + pack.size, 0);
  const unpackedBytes = manifest.packs.reduce((sum, pack) => sum + pack.unpackedSize, 0);
  console.log(
    `Prepared ${manifest.packs.length} deferred media packs ` +
      `(${packedBytes} packed bytes, ${unpackedBytes} source bytes) in ${basename(options.output)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
