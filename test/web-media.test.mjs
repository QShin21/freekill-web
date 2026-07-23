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

test("required media is split per package and can be mounted before startup", async () => {
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

test("the Wasm build reapplies web overlays after extra packages", async () => {
  const buildScript = await readFile(
    join(repositoryRoot, "scripts", "build-wasm.sh"),
    "utf8",
  );
  const extraPackages = buildScript.indexOf('if [[ -n "${EXTRA_PACKAGES_DIR:-}" ]]');
  const updatePreparedSource = buildScript.indexOf(
    'node "${repo_root}/scripts/update-prepared-source.mjs"',
  );
  const reapplySourceOverlays = buildScript.indexOf(
    'cp -R "${repo_root}/overlays/freekill/src/." "${free_kill_source}/src/"',
  );
  const reapplyQmlOverlays = buildScript.indexOf(
    'cp -R "${repo_root}/overlays/freekill/Fk/." "${free_kill_source}/Fk/"',
  );
  const prepareWebMedia = buildScript.indexOf(
    'node "${repo_root}/scripts/prepare-web-media.mjs"',
  );

  assert.ok(extraPackages >= 0);
  assert.match(
    buildScript,
    /rm -rf "\$\{free_kill_source:\?\}\/packages"[\s\S]*tar --exclude='\.git'/,
  );
  assert.ok(reapplySourceOverlays > extraPackages);
  assert.ok(reapplyQmlOverlays > extraPackages);
  assert.ok(updatePreparedSource > reapplySourceOverlays);
  assert.ok(updatePreparedSource > reapplyQmlOverlays);
  assert.ok(updatePreparedSource > extraPackages);
  assert.ok(prepareWebMedia > updatePreparedSource);
  assert.match(
    buildScript,
    /for core_directory in Fk LunarLtk lua ltk; do/,
  );
});

test("the browser package manager seeds the exact bundled server database", async () => {
  const source = await readFile(
    join(repositoryRoot, "overlays", "freekill", "src", "core", "packman_wasm.cpp"),
    "utf8",
  );
  assert.match(source, /QFile::remove\(persistentDatabase\)/);
  assert.match(source, /QFile::copy\("\.\/packages\/packages\.db", persistentDatabase\)/);
  assert.match(source, /std::make_unique<Sqlite3>\(persistentDatabase/);
  assert.match(source, /bool PackMan::shouldUseCore\(\) \{[\s\S]*return false;/);
});

test("the WebSocket overlay constructs Qt 6.8 CBOR errors explicitly", async () => {
  const source = await readFile(
    join(repositoryRoot, "overlays", "freekill", "src", "network", "client_socket.cpp"),
    "utf8",
  );
  assert.doesNotMatch(source, /\*error = QCborError::/);
  assert.match(source, /QCborError\{QCborError::IllegalType\}/);
  assert.match(source, /QCborError\{QCborError::UnknownError\}/);
  assert.match(source, /QCborError\{QCborError::NoError\}/);
});

test("the browser opens a deployment-configured username and password login", async () => {
  const login = await readFile(
    join(repositoryRoot, "overlays", "freekill", "Fk", "Pages", "Common", "Init.qml"),
    "utf8",
  );
  const platform = await readFile(
    join(repositoryRoot, "overlays", "freekill", "src", "web", "web_platform.cpp"),
    "utf8",
  );
  const config = JSON.parse(await readFile(join(repositoryRoot, "web", "config.json"), "utf8"));

  assert.equal(config.serverAddress, "123.57.220.25");
  assert.equal(config.serverPort, 9527);
  assert.match(platform, /config\.serverAddress/);
  assert.match(platform, /config\.serverPort/);
  assert.match(login, /Backend\.configuredServerAddress\(\)/);
  assert.match(login, /Backend\.configuredServerPort\(\)/);
  assert.match(login, /Backend\.joinServer\(configuredAddress, configuredPort\)/);
  assert.match(login, /placeholderText: qsTr\("Username"\)/);
  assert.match(login, /placeholderText: qsTr\("Password"\)/);
  assert.doesNotMatch(login, /Server Address|Join Server|PackageManage/);
});

test("prepared sources migrate to split packages and merged Qt runtime exports", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "freekill-web-source-"));
  const sourceDirectory = join(temporary, "FreeKill");
  const cmakePath = join(sourceDirectory, "src", "CMakeLists.txt");
  const entryPath = join(sourceDirectory, "src", "freekill.cpp");
  const rootPagePath = join(sourceDirectory, "Fk", "Base", "RootPage.qml");
  const packagedRootPagePath = join(
    sourceDirectory,
    "packages",
    "freekill-core",
    "Fk",
    "Base",
    "RootPage.qml",
  );
  const qmlBackendHeaderPath = join(sourceDirectory, "src", "ui", "qmlbackend.h");
  const qmlBackendPath = join(sourceDirectory, "src", "ui", "qmlbackend.cpp");
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
  const legacyRootPage = `Item {
  Component.onCompleted: {
    mainStack.push(Qt.createComponent("Fk.Pages.Common", "Init"));
    if (Config.firstRun) {
      Config.firstRun = false;
      mainStack.push(Qt.createComponent("Tutorial.qml").createObject());
    }
    if (!Cpp.debug) {
      splashLoader.source = "Splash.qml";
      splashLoader.item.disappeared.connect(() => {
        splashLoader.source = "";
      });
    }
  }
}
`;
  const legacyQmlBackendHeader = `class QmlBackend {
  Q_INVOKABLE QString loadTips();
};
`;
  const legacyQmlBackend = `QString QmlBackend::loadTips() {
  return "tips";
}

void QmlBackend::saveConf(const QString &conf) {
}
`;
  const legacyEntry = `#define SHOW_SPLASH_MSG(msg)                                                   \\
  splash.showMessage(msg, Qt::AlignHCenter | Qt::AlignBottom);

void startClient() {
  QSplashScreen splash(QPixmap("image/splash.jpg"));
  splash.show();
  splash.close();
  int ret = app->exec();
}
`;
  try {
    await mkdir(dirname(cmakePath), { recursive: true });
    await mkdir(dirname(rootPagePath), { recursive: true });
    await mkdir(dirname(packagedRootPagePath), { recursive: true });
    await mkdir(dirname(qmlBackendHeaderPath), { recursive: true });
    await writeFile(cmakePath, legacy);
    await writeFile(entryPath, legacyEntry);
    await writeFile(rootPagePath, legacyRootPage);
    await writeFile(packagedRootPagePath, legacyRootPage);
    await writeFile(qmlBackendHeaderPath, legacyQmlBackendHeader);
    await writeFile(qmlBackendPath, legacyQmlBackend);
    const script = join(repositoryRoot, "scripts", "update-prepared-source.mjs");
    await exec(process.execPath, [script, "--free-kill", sourceDirectory]);
    await exec(process.execPath, [script, "--free-kill", sourceDirectory]);
    const migrated = await readFile(cmakePath, "utf8");
    const migratedEntry = await readFile(entryPath, "utf8");
    const migratedRootPage = await readFile(rootPagePath, "utf8");
    const migratedPackagedRootPage = await readFile(packagedRootPagePath, "utf8");
    const migratedQmlBackendHeader = await readFile(qmlBackendHeaderPath, "utf8");
    const migratedQmlBackend = await readFile(qmlBackendPath, "utf8");
    assert.match(migrated, /QT_WASM_EXTRA_EXPORTED_METHODS "addRunDependency,removeRunDependency"/);
    assert.match(migrated, /-lidbfs\.js/);
    assert.match(migrated, /set\(FK_WEB_PACKAGES_DIR/);
    assert.match(migrated, /file\(GLOB_RECURSE FK_WEB_PRELOAD_FILES CONFIGURE_DEPENDS/);
    assert.match(migrated, /LINK_DEPENDS \$\{FK_WEB_PRELOAD_FILES\}/);
    assert.doesNotMatch(migrated, /client packages/);
    assert.equal((migrated.match(/EXPORTED_RUNTIME_METHODS/g) || []).length, 0);
    assert.match(migratedEntry, /#ifdef Q_OS_WASM\n#define SHOW_SPLASH_MSG/);
    assert.match(migratedEntry, /#ifndef Q_OS_WASM\n  QSplashScreen splash/);
    assert.match(migratedEntry, /#ifndef Q_OS_WASM\n  splash\.close\(\);/);
    assert.equal((migratedEntry.match(/QSplashScreen splash/g) || []).length, 1);
    assert.match(migratedRootPage, /function pushLoadedComponent\(component, label, onReady\)/);
    assert.match(migratedRootPage, /function loadInitialPage\(\)/);
    assert.match(migratedRootPage, /component\.status === Component\.Loading/);
    assert.match(migratedRootPage, /Component\.Asynchronous, root/);
    assert.match(migratedRootPage, /component\.createObject\(mainStack\)/);
    assert.match(migratedRootPage, /pushLoadedComponent\(component, "the web login"/);
    assert.doesNotMatch(migratedRootPage, /Tutorial/);
    assert.doesNotMatch(migratedRootPage, /splashLoader\.source = "Splash\.qml"/);
    assert.match(migratedRootPage, /component\.errorString\(\)/);
    assert.equal((migratedRootPage.match(/loadInitialPage\(\)/g) || []).length, 2);
    assert.doesNotMatch(
      migratedRootPage,
      /mainStack\.push\(Qt\.createComponent\("Fk\.Pages\.Common", "Init"\)\)/,
    );
    assert.equal(migratedPackagedRootPage, legacyRootPage);
    assert.match(migratedQmlBackendHeader, /configuredServerAddress\(\) const/);
    assert.match(migratedQmlBackendHeader, /configuredServerPort\(\) const/);
    assert.match(migratedQmlBackend, /WebPlatform::serverAddress\(\)/);
    assert.match(migratedQmlBackend, /WebPlatform::serverPort\(\)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
