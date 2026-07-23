import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isDeferredMediaPath, prepareWebMedia } from "../scripts/prepare-web-media.mjs";
import { unpackMediaPack } from "../web/media-pack.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

async function fixtureFile(root, path, contents) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function memoryFileSystem() {
  const files = new Map();
  return {
    files,
    mkdirTree() {},
    writeFile(path, contents) {
      files.set(path, Buffer.from(contents));
    },
  };
}

test("deferred media is split per package and can be mounted", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "freekill-web-media-"));
  const packages = join(temporary, "packages");
  const output = join(temporary, "output");
  try {
    await fixtureFile(packages, "standard/lua/init.lua", "return true");
    await fixtureFile(packages, "standard/image/general/caocao.jpg", "portrait");
    await fixtureFile(packages, "standard/audio/skill/wei.ogg", "voice");
    await fixtureFile(packages, "standard/image/anim/wei.webp", "animation");
    await fixtureFile(packages, "mobile_effect/image/card/slash.webp", "effect");
    await fixtureFile(packages, "mobile_effect/lua/init.lua", "return false");

    const manifest = await prepareWebMedia({ packages, output });
    assert.deepEqual(
      manifest.packs.map((pack) => pack.id),
      ["mobile_effect", "standard"],
    );
    assert.equal(
      await readFile(join(output, "core-packages", "standard", "lua", "init.lua"), "utf8"),
      "return true",
    );
    assert.equal(
      await readFile(
        join(output, "core-packages", "standard", "image", "general", "caocao.jpg"),
        "utf8",
      ),
      "portrait",
    );
    assert.equal(
      await exists(join(output, "core-packages", "standard", "audio", "skill", "wei.ogg")),
      false,
    );

    const fileSystem = memoryFileSystem();
    for (const pack of manifest.packs) {
      const bytes = await readFile(join(output, "public", pack.url.replace(/^\//, "")));
      assert.equal(unpackMediaPack(fileSystem, bytes), pack.files);
    }
    assert.equal(fileSystem.files.get("/packages/standard/audio/skill/wei.ogg").toString(), "voice");
    assert.equal(
      fileSystem.files.get("/packages/standard/image/anim/wei.webp").toString(),
      "animation",
    );
    assert.equal(
      fileSystem.files.get("/packages/mobile_effect/image/card/slash.webp").toString(),
      "effect",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("media path policy and pack validation reject unsafe input", () => {
  assert.equal(isDeferredMediaPath("standard/audio/skill/a.ogg"), true);
  assert.equal(isDeferredMediaPath("standard/image/anim/a.webp"), true);
  assert.equal(isDeferredMediaPath("standard/image/general/a.webp"), false);
  assert.equal(isDeferredMediaPath("mobile_effect/image/a.webp"), true);

  const fileSystem = memoryFileSystem();
  assert.throws(() => unpackMediaPack(fileSystem, Buffer.from("short")), /truncated/);
  assert.throws(
    () => unpackMediaPack(fileSystem, Buffer.concat([Buffer.from("BADMAGIC"), Buffer.alloc(4)])),
    /signature/,
  );
});

test("prepared sources migrate to split packages and merged Qt runtime exports", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "freekill-web-source-"));
  const sourceDirectory = join(temporary, "FreeKill");
  const cmakePath = join(sourceDirectory, "src", "CMakeLists.txt");
  const legacy = `if (EMSCRIPTEN)
  set_target_properties(FreeKill PROPERTIES QT_WASM_MAXIMUM_MEMORY 2147483648)
  target_link_options(FreeKill PRIVATE
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s FORCE_FILESYSTEM=1"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=FS,IDBFS,addRunDependency,removeRunDependency"
  )
  foreach(resource_dir IN ITEMS audio fonts image lua Fk client packages)
    target_link_options(FreeKill PRIVATE
      "SHELL:--preload-file \\"\${PROJECT_SOURCE_DIR}/\${resource_dir}@/\${resource_dir}\\"")
  endforeach()
endif()
`;
  try {
    await mkdir(dirname(cmakePath), { recursive: true });
    await writeFile(cmakePath, legacy);
    const script = join(repositoryRoot, "scripts", "update-prepared-source.mjs");
    await exec(process.execPath, [script, "--free-kill", sourceDirectory]);
    await exec(process.execPath, [script, "--free-kill", sourceDirectory]);
    const migrated = await readFile(cmakePath, "utf8");
    assert.match(migrated, /QT_WASM_EXTRA_EXPORTED_METHODS "addRunDependency,removeRunDependency"/);
    assert.match(migrated, /-lidbfs\.js/);
    assert.match(migrated, /set\(FK_WEB_PACKAGES_DIR/);
    assert.doesNotMatch(migrated, /client packages/);
    assert.equal((migrated.match(/EXPORTED_RUNTIME_METHODS/g) || []).length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
