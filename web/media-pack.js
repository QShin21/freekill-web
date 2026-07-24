const MAGIC = "FKMEDIA1";
const PREFIX_BYTES = MAGIC.length + 4;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function ensureDirectory(FS, path) {
  const directory = path.slice(0, path.lastIndexOf("/")) || "/";
  if (typeof FS.mkdirTree === "function") {
    FS.mkdirTree(directory);
    return;
  }
  let current = "";
  for (const part of directory.split("/").filter(Boolean)) {
    current += `/${part}`;
    if (!FS.analyzePath(current).exists) FS.mkdir(current);
  }
}

function safeMediaPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/packages/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}

export function unpackMediaPack(FS, buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < PREFIX_BYTES) throw new Error("Media pack is truncated");
  const decoder = new TextDecoder();
  const magic = decoder.decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error("Invalid media pack signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint32(MAGIC.length, true);
  if (metadataLength > MAX_METADATA_BYTES || PREFIX_BYTES + metadataLength > bytes.byteLength) {
    throw new Error("Invalid media pack metadata length");
  }
  const metadata = JSON.parse(
    decoder.decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength)),
  );
  if (metadata.version !== 1 || !Array.isArray(metadata.files)) {
    throw new Error("Unsupported media pack version");
  }

  const dataOffset = PREFIX_BYTES + metadataLength;
  const files = metadata.files.map((file) => {
    if (!safeMediaPath(file.path)) throw new Error(`Unsafe media path: ${file.path}`);
    if (!Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.size)) {
      throw new Error(`Invalid media entry: ${file.path}`);
    }
    const start = dataOffset + file.offset;
    const end = start + file.size;
    if (file.offset < 0 || file.size < 0 || start < dataOffset || end > bytes.byteLength) {
      throw new Error(`Truncated media entry: ${file.path}`);
    }
    return { ...file, start, end };
  });
  for (const file of files) {
    ensureDirectory(FS, file.path);
    FS.writeFile(file.path, bytes.subarray(file.start, file.end));
  }
  return files.length;
}
