import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareWebMedia } from "../scripts/prepare-web-media.mjs";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

async function fixtureFile(root, path, contents) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test("web packaging makes every package media pack a startup requirement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "freekill-web-package-"));
  const build = join(temporary, "build");
  const packages = join(temporary, "packages");
  const media = join(temporary, "web-media");
  const output = join(temporary, "dist");
  try {
    await mkdir(build);
    await writeFile(join(build, "FreeKill.js"), "globalThis.FreeKill = true;");
    await writeFile(join(build, "FreeKill.wasm"), Buffer.from([0, 97, 115, 109]));
    await writeFile(join(build, "qtloader.js"), "globalThis.qtLoad = true;");
    await fixtureFile(packages, "standard/lua/init.lua", "return true");
    await fixtureFile(packages, "standard/audio/skill/a.ogg", "voice data");
    const mediaManifest = await prepareWebMedia({ packages, output: media });

    await exec(process.execPath, [join(repositoryRoot, "scripts", "package-web.mjs")], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        BUILD_DIR: build,
        OUTPUT_DIR: output,
        WEB_MEDIA_DIR: join(media, "public"),
      },
    });

    const manifest = JSON.parse(await readFile(join(output, "asset-manifest.json"), "utf8"));
    assert.equal(manifest.deferredPacks.length, 1);
    assert.equal(manifest.deferredPacks[0].revision, mediaManifest.packs[0].revision);
    const mediaAsset = manifest.assets.find((asset) => asset.url.endsWith(".fkp"));
    assert.ok(mediaAsset);
    assert.equal(mediaAsset.startup, true);
    assert.ok(mediaAsset.downloadSize > 0);
    assert.equal(
      manifest.assets.find((asset) => asset.url === "/FreeKill.wasm").startup,
      true,
    );
    const wasmAsset = manifest.assets.find((asset) => asset.url === "/FreeKill.wasm");
    assert.deepEqual(
      await readFile(
        join(output, ".freekill-assets", wasmAsset.revision, "FreeKill.wasm"),
      ),
      await readFile(join(output, "FreeKill.wasm")),
    );
    assert.deepEqual(
      await readFile(
        join(output, ".freekill-assets", wasmAsset.revision, "FreeKill.wasm.br"),
      ),
      await readFile(join(output, "FreeKill.wasm.br")),
    );
    assert.ok(await readFile(join(output, `${mediaAsset.url.slice(1)}.br`)));
    assert.deepEqual(
      await readFile(
        join(
          output,
          ".freekill-assets",
          mediaAsset.revision,
          mediaAsset.url.slice(1),
        ),
      ),
      await readFile(join(output, mediaAsset.url.slice(1))),
    );

    const bootstrap = await readFile(join(output, "bootstrap.js"), "utf8");
    assert.match(bootstrap, /`\/\.freekill-assets\/\$\{asset\.revision\}\/\$\{path\}`/);
    assert.match(bootstrap, /asset\.startup === false \? "" : "v2\/"/);
    assert.match(
      bootstrap,
      /fetch\(revisionedAssetUrl\(asset\), \{ cache: "no-store" \}\)/,
    );
    assert.match(bootstrap, /const MAX_ASSET_ATTEMPTS = 4/);
    assert.match(bootstrap, /const payload = await response\.blob\(\)/);
    assert.match(bootstrap, /payload\.size !== asset\.size/);
    assert.match(bootstrap, /failed after \$\{MAX_ASSET_ATTEMPTS\} attempts/);
    assert.match(bootstrap, /await cache\.put\(requestUrl, response\);\s*await cache\.put\(markerUrl/s);
    assert.match(bootstrap, /Math\.min\(2, queue\.length\)/);
    assert.match(bootstrap, /loadScriptAsset\(manifest, "\/qtloader\.js"\)/);
    assert.match(bootstrap, /loadScriptAsset\(manifest, "\/FreeKill\.js"\)/);
    assert.match(bootstrap, /locateFile: locateRuntimeFile/);
    assert.match(bootstrap, /console\.info\(`\[FreeKill\] \$\{text\}`\)/);
    assert.match(bootstrap, /console\.error\(`\[FreeKill\] \$\{text\}`\)/);
    assert.match(bootstrap, /function fitQtCanvasesToWindows\(\)/);
    assert.match(bootstrap, /screen\.querySelector\("#qt-shadow-container"\)\?\.shadowRoot/);
    assert.match(bootstrap, /canvas\.qt-window-content/);
    assert.match(bootstrap, /min-width: 0;\s*min-height: 0;/s);
    assert.match(bootstrap, /new MutationObserver/);
    assert.match(bootstrap, /observer\.observe\(screen, \{ childList: true, subtree: true \}\)/);
    assert.match(bootstrap, /fitQtCanvasesToWindows\(\);\s*document\.body\.dataset\.state/s);
    assert.match(bootstrap, /const requiredAssets = manifest\.assets/);
    assert.match(bootstrap, /function mountRequiredMedia\(runtime, context\)/);
    assert.match(bootstrap, /const dependency = "freekill-required-media"/);
    assert.doesNotMatch(bootstrap, /downloadDeferredMedia/);

    const index = await readFile(join(output, "index.html"), "utf8");
    assert.doesNotMatch(index, /<script src="(?:qtloader|FreeKill)/);
    assert.match(index, /<script type="module" src="bootstrap\.js\?v=2"><\/script>/);

    const serviceWorker = await readFile(join(output, "service-worker.js"), "utf8");
    assert.doesNotMatch(serviceWorker, /"\/FreeKill(?:\.worker)?\.js"/);
    assert.doesNotMatch(serviceWorker, /"\/qtloader\.js"/);

  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
