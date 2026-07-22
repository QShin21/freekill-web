import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const expectedFreeKill = "37f8c1248d491f5fbc7a07f1bc53724191e44497";
const expectedCore = "c19441690711b73ffb427b3e7974ec7e92e33bea";

function argumentsFrom(argv) {
  const result = {
    freeKill: join(repositoryRoot, "upstream", "FreeKill"),
    core: join(repositoryRoot, "upstream", "freekill-core"),
    syncCore: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--free-kill") result.freeKill = resolve(argv[++index]);
    else if (value === "--core") result.core = resolve(argv[++index]);
    else if (value === "--skip-core-sync") result.syncCore = false;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

async function gitHead(directory) {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: directory });
  return stdout.trim();
}

async function assertHead(directory, expected, name) {
  const actual = await gitHead(directory);
  if (actual !== expected) {
    throw new Error(
      `${name} must be at ${expected}, but ${directory} is at ${actual}. ` +
        "Update the overlay deliberately before changing the pinned revision.",
    );
  }
}

async function transform(path, callback) {
  const before = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  const after = callback(before);
  if (before === after) throw new Error(`Patch made no change: ${path}`);
  await writeFile(path, after);
}

function replaceOnce(contents, search, replacement, label) {
  const first = contents.indexOf(search);
  if (first < 0) throw new Error(`Cannot find patch anchor: ${label}`);
  if (contents.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return contents.slice(0, first) + replacement + contents.slice(first + search.length);
}

function replaceAllChecked(contents, search, replacement, expectedCount, label) {
  const count = contents.split(search).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Expected ${expectedCount} occurrences for ${label}, found ${count}`);
  }
  return contents.split(search).join(replacement);
}

async function syncCore(core, freeKill) {
  const temporary = await mkdtemp(join(tmpdir(), "freekill-web-core-"));
  const archive = join(temporary, "core.tar");
  const exported = join(temporary, "export");
  await mkdir(exported);
  try {
    await exec("git", ["archive", "--format=tar", "--output", archive, "HEAD"], { cwd: core });
    await exec("tar", ["-xf", archive, "-C", exported]);

    await Promise.all([
      rm(join(freeKill, "Fk"), { recursive: true, force: true }),
      rm(join(freeKill, "lua"), { recursive: true, force: true }),
      rm(join(freeKill, "packages", "freekill-core"), { recursive: true, force: true }),
    ]);
    await cp(join(exported, "Fk"), join(freeKill, "Fk"), { recursive: true });
    await cp(join(exported, "lua"), join(freeKill, "lua"), { recursive: true });
    await cp(exported, join(freeKill, "packages", "freekill-core"), { recursive: true });
    for (const name of ["standard", "standard_cards", "maneuvering", "test"]) {
      await cp(join(exported, name), join(freeKill, "packages", name), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function patchRootCMake(freeKill) {
  await transform(join(freeKill, "CMakeLists.txt"), (source) => {
    let output = replaceOnce(
      source,
      "find_package(Qt6 REQUIRED COMPONENTS\n  Network\n)\n",
      "find_package(Qt6 REQUIRED COMPONENTS\n  Network\n)\n\nif (EMSCRIPTEN)\n  find_package(Qt6 REQUIRED COMPONENTS WebSockets)\nendif()\n",
      "Qt WebSockets dependency",
    );
    output = replaceOnce(
      output,
      "find_package(OpenSSL)\nfind_package(Lua)\nfind_package(SQLite3)\n",
      "if (EMSCRIPTEN)\n  find_package(OpenSSL REQUIRED)\n  find_package(Lua REQUIRED)\n  find_package(SQLite3 REQUIRED)\nelse()\n  find_package(OpenSSL)\n  find_package(Lua)\n  find_package(SQLite3)\nendif()\n",
      "Wasm native dependencies",
    );
    output = replaceOnce(
      output,
      "include_directories(include/libgit2)\n",
      "include_directories(include/libgit2)\n\nif (EMSCRIPTEN)\n  include_directories(${LUA_INCLUDE_DIR})\nendif()\n",
      "Wasm Lua headers",
    );
    return output;
  });
}

async function patchSourceCMake(freeKill) {
  await transform(join(freeKill, "src", "CMakeLists.txt"), (source) => {
    let output = replaceOnce(
      source,
      "set(SWIG_SOURCE ${PROJECT_SOURCE_DIR}/src/swig/freekill.i)\n",
      "if (EMSCRIPTEN)\n  set(SWIG_SOURCE ${PROJECT_SOURCE_DIR}/src/swig/freekill_web.i)\nelse()\n  set(SWIG_SOURCE ${PROJECT_SOURCE_DIR}/src/swig/freekill.i)\nendif()\n",
      "client-only SWIG module",
    );
    output = replaceOnce(
      output,
      "  \"swig/freekill-wrap.cxx\"\n)\nset_source_files_properties(",
      "  \"swig/freekill-wrap.cxx\"\n)\n\nif (EMSCRIPTEN)\n  list(REMOVE_ITEM freekill_SRCS\n    \"core/packman.cpp\"\n    \"network/server_socket.cpp\"\n    \"server/server.cpp\"\n    \"server/user/auth.cpp\"\n    \"server/user/serverplayer.cpp\"\n    \"server/room/roombase.cpp\"\n    \"server/room/lobby.cpp\"\n    \"server/room/room.cpp\"\n    \"server/task/task_manager.cpp\"\n    \"server/task/task.cpp\"\n    \"server/gamelogic/roomthread.cpp\"\n    \"server/cli/shell.cpp\"\n  )\n  list(APPEND freekill_SRCS\n    \"core/packman_wasm.cpp\"\n    \"web/web_platform.cpp\"\n  )\nendif()\n\nset_source_files_properties(",
      "Wasm client source selection",
    );
    output = replaceOnce(
      output,
      '  list(APPEND freekill_SRCS\n    "core/packman_wasm.cpp"\n',
      '  list(APPEND freekill_SRCS\n    "core/packman.h"\n    "core/packman_wasm.cpp"\n',
      "Wasm PackMan moc header",
    );
    output = replaceOnce(
      output,
      "set(QT_LIB Qt6::Network)\n",
      "set(QT_LIB Qt6::Network)\nif (EMSCRIPTEN)\n  list(APPEND QT_LIB Qt6::WebSockets)\nendif()\n",
      "Qt WebSockets link library",
    );
    output = replaceOnce(
      output,
      "if (WIN32)\n  set(LUA_LIB",
      "if (EMSCRIPTEN)\n  set(LUA_LIB ${LUA_LIBRARIES})\n  set(SQLITE3_LIB SQLite::SQLite3)\n  set(CRYPTO_LIB OpenSSL::Crypto)\nelseif (WIN32)\n  set(LUA_LIB",
      "Wasm library selection",
    );
    output = replaceOnce(
      output,
      "target_link_libraries(FreeKill PRIVATE\n  libFreeKill\n)\n",
      "target_link_libraries(FreeKill PRIVATE\n  libFreeKill\n)\n\nif (EMSCRIPTEN)\n  set_target_properties(FreeKill PROPERTIES QT_WASM_MAXIMUM_MEMORY 2147483648)\n  target_link_options(FreeKill PRIVATE\n    \"SHELL:-s ALLOW_MEMORY_GROWTH=1\"\n    \"SHELL:-s FORCE_FILESYSTEM=1\"\n    \"SHELL:-s EXPORTED_RUNTIME_METHODS=FS,IDBFS,addRunDependency,removeRunDependency\"\n  )\n  foreach(resource_dir IN ITEMS audio fonts image lua Fk client packages)\n    target_link_options(FreeKill PRIVATE\n      \"SHELL:--preload-file \\\"${PROJECT_SOURCE_DIR}/${resource_dir}@/${resource_dir}\\\"\")\n  endforeach()\n  foreach(resource_file IN ITEMS waiting_tips.txt)\n    target_link_options(FreeKill PRIVATE\n      \"SHELL:--preload-file \\\"${PROJECT_SOURCE_DIR}/${resource_file}@/${resource_file}\\\"\")\n  endforeach()\nendif()\n",
      "Wasm preload resources",
    );
    return output;
  });
}

async function patchFreekillEntry(freeKill) {
  await transform(join(freeKill, "src", "freekill.cpp"), (source) => {
    let output = replaceOnce(
      source,
      "#include \"core/packman.h\"\n#include \"server/server.h\"\n#include \"server/cli/shell.h\"\n",
      "#include \"core/packman.h\"\n#ifdef Q_OS_WASM\n#include \"web/web_platform.h\"\n#else\n#include \"server/server.h\"\n#include \"server/cli/shell.h\"\n#endif\n",
      "server-only entry includes",
    );
    output = replaceOnce(
      output,
      "  if (ShellInstance) delete ShellInstance;\n",
      "#ifndef Q_OS_WASM\n  if (ShellInstance) delete ShellInstance;\n#endif\n",
      "shell cleanup",
    );
    output = replaceAllChecked(
      output,
      "log_file.reset(new QFile(\"freekill.server.log\"));",
      "#ifdef Q_OS_WASM\n    QDir().mkpath(WebPlatform::persistentPath(\"logs\"));\n    log_file.reset(new QFile(WebPlatform::persistentPath(\"logs/freekill.log\")));\n#else\n    log_file.reset(new QFile(\"freekill.server.log\"));\n#endif",
      2,
      "persistent web log",
    );
    output = replaceOnce(
      output,
      "  if (startServer) {\n",
      "#ifndef Q_OS_WASM\n  if (startServer) {\n",
      "server mode guard start",
    );
    output = replaceOnce(
      output,
      "    return app->exec();\n  }\n\n#ifdef FK_SERVER_ONLY",
      "    return app->exec();\n  }\n#else\n  if (startServer) {\n    qWarning(\"The WebAssembly build cannot host a local server.\");\n  }\n#endif\n\n#ifdef FK_SERVER_ONLY",
      "server mode guard end",
    );
    output = replaceOnce(
      output,
      "  QString system;\n#if defined(Q_OS_ANDROID)",
      "  QString system;\n#if defined(Q_OS_WASM)\n  system = QStringLiteral(\"Web\");\n#elif defined(Q_OS_ANDROID)",
      "Web OS name",
    );
    return output;
  });
}

async function patchClient(freeKill) {
  await transform(join(freeKill, "src", "client", "client.cpp"), (source) => {
    let output = replaceOnce(
      source,
      "#include \"core/packman.h\"\n#include \"server/server.h\"\n#include \"network/client_socket.h\"",
      "#include \"core/packman.h\"\n#ifndef Q_OS_WASM\n#include \"server/server.h\"\n#else\n#include \"web/web_platform.h\"\n#endif\n#include \"network/client_socket.h\"",
      "client server include",
    );
    output = replaceOnce(
      output,
      "  db = std::make_unique<Sqlite3>(\"./client/client.db\", \"./client/init.sql\");",
      "#ifdef Q_OS_WASM\n  QDir().mkpath(WebPlatform::persistentPath(\"client\"));\n  db = std::make_unique<Sqlite3>(WebPlatform::persistentPath(\"client/client.db\"),\n                                 \"./client/init.sql\");\n#else\n  db = std::make_unique<Sqlite3>(\"./client/client.db\", \"./client/init.sql\");\n#endif",
      "persistent client database",
    );
    output = replaceOnce(
      output,
      "  if (!QDir(\"recording\").exists()) {\n    QDir(\".\").mkdir(\"recording\");\n  }\n  QFile c(\"recording/\" + fname + \".fk.rep\");",
      "#ifdef Q_OS_WASM\n  const auto recordingDir = WebPlatform::persistentPath(\"recording\");\n  QDir().mkpath(recordingDir);\n  QFile c(recordingDir + \"/\" + fname + \".fk.rep\");\n#else\n  if (!QDir(\"recording\").exists()) {\n    QDir(\".\").mkdir(\"recording\");\n  }\n  QFile c(\"recording/\" + fname + \".fk.rep\");\n#endif",
      "persistent recordings",
    );
    output = replaceOnce(
      output,
      "  c.write(qCompress(json));\n  c.close();\n}",
      "  c.write(qCompress(json));\n  c.close();\n#ifdef Q_OS_WASM\n  WebPlatform::syncPersistentFileSystem();\n#endif\n}",
      "recording flush",
    );
    output = replaceOnce(
      output,
      "  db->exec(sqlSaveRecord.arg(id).arg(record_blob));\n",
      "  db->exec(sqlSaveRecord.arg(id).arg(record_blob));\n#ifdef Q_OS_WASM\n  WebPlatform::syncPersistentFileSystem();\n#endif\n",
      "game database flush",
    );
    return output;
  });
}

async function patchUtilities(freeKill) {
  await transform(join(freeKill, "src", "core", "util.cpp"), (source) => {
    let output = replaceOnce(
      source,
      "#include \"core/util.h\"\n",
      "#include \"core/util.h\"\n#ifdef Q_OS_WASM\n#include \"web/web_platform.h\"\n#endif\n",
      "web utility include",
    );
    output = replaceOnce(
      output,
      "#include <git2.h>\n",
      "#ifndef Q_OS_WASM\n#include <git2.h>\n#endif\n",
      "browser libgit2 exclusion",
    );
    output = replaceOnce(
      output,
      "QString GetDeviceUuid() {\n  QString ret;\n#ifdef Q_OS_ANDROID",
      "QString GetDeviceUuid() {\n  QString ret;\n#ifdef Q_OS_WASM\n  ret = WebPlatform::deviceUuid();\n#elif defined(Q_OS_ANDROID)",
      "persistent browser device id",
    );
    return output;
  });
}

async function patchQmlBackend(freeKill) {
  await transform(join(freeKill, "src", "ui", "qmlbackend.cpp"), (source) => {
    let output = replaceOnce(
      source,
      "#include <cstdlib>\n#include \"server/server.h\"\n#include \"client/client.h\"",
      "#include <cstdlib>\n#ifndef Q_OS_WASM\n#include \"server/server.h\"\n#else\n#include \"web/web_platform.h\"\n#endif\n#include \"client/client.h\"",
      "QML backend server include",
    );
    output = replaceOnce(
      output,
      "  udpSocket = new QUdpSocket(this);\n  udpSocket->bind(0);\n  connect(udpSocket, &QUdpSocket::readyRead,\n          this, &QmlBackend::readPendingDatagrams);",
      "#ifdef Q_OS_WASM\n  udpSocket = nullptr;\n#else\n  udpSocket = new QUdpSocket(this);\n  udpSocket->bind(0);\n  connect(udpSocket, &QUdpSocket::readyRead,\n          this, &QmlBackend::readPendingDatagrams);\n#endif",
      "disable browser UDP",
    );
    output = replaceOnce(
      output,
      "void QmlBackend::startServer(ushort port) {\n  if (!ServerInstance)",
      "void QmlBackend::startServer(ushort port) {\n#ifdef Q_OS_WASM\n  Q_UNUSED(port);\n  emit notifyUI(\"ErrorMsg\", tr(\"The web client cannot host a local server.\"));\n  return;\n#else\n  if (!ServerInstance)",
      "disable browser local server start",
    );
    output = replaceOnce(
      output,
      "    }\n  }\n}\n\nstatic ClientPlayer dummyPlayer",
      "    }\n  }\n#endif\n}\n\nstatic ClientPlayer dummyPlayer",
      "close local server guard",
    );
    const threadedClient = "  auto future = QtConcurrent::run([] {\n    QThread::currentThread()->setObjectName(\"Pool\");\n\n    auto ret = new Client;\n    ret->moveToThread(qApp->thread());\n    return ret;\n  });\n  QFutureWatcher<Client *> watcher;\n  watcher.setFuture(future);\n\n  QEventLoop loop;\n  connect(&watcher, &QFutureWatcher<Client *>::finished, &loop, &QEventLoop::quit);\n  loop.exec();\n\n  auto client = future.result();";
    output = replaceOnce(
      output,
      threadedClient,
      "#ifdef Q_OS_WASM\n  auto client = new Client;\n#else\n" + threadedClient + "\n#endif",
      "non-blocking browser client creation",
    );
    output = replaceOnce(
      output,
      "QString QmlBackend::loadConf() {\n  return touchAndRead(\"freekill.client.config.json\", \"{}\");\n}",
      "QString QmlBackend::loadConf() {\n#ifdef Q_OS_WASM\n  return touchAndRead(WebPlatform::persistentPath(\"freekill.client.config.json\"), \"{}\");\n#else\n  return touchAndRead(\"freekill.client.config.json\", \"{}\");\n#endif\n}",
      "persistent client config read",
    );
    output = replaceOnce(
      output,
      "void QmlBackend::saveConf(const QString &conf) {\n  QFile c(\"freekill.client.config.json\");",
      "void QmlBackend::saveConf(const QString &conf) {\n#ifdef Q_OS_WASM\n  QFile c(WebPlatform::persistentPath(\"freekill.client.config.json\"));\n#else\n  QFile c(\"freekill.client.config.json\");\n#endif",
      "persistent client config write",
    );
    output = replaceOnce(
      output,
      "  c.write(conf.toUtf8());\n  c.close();\n}\n\nvoid QmlBackend::playSound",
      "  c.write(conf.toUtf8());\n  c.close();\n#ifdef Q_OS_WASM\n  WebPlatform::syncPersistentFileSystem();\n#endif\n}\n\nvoid QmlBackend::playSound",
      "client config flush",
    );
    const threadedAudio = "  auto future = QtConcurrent::run([=, this] {\n    player->setAudioOutput(output);\n    player->setSource(QUrl::fromLocalFile(fname));\n    output->setVolume(m_volume / 100);\n\n    connect(player, &QMediaPlayer::playbackStateChanged, this, [=, this] {\n      auto state = player->playbackState();\n      if (state != QMediaPlayer::PlayingState) {\n        player->deleteLater();\n        output->deleteLater();\n        maxConcurrentPlayback++;\n      }\n    });\n\n    player->play();\n  });\n  Q_UNUSED(future)";
    const directAudio = "  player->setAudioOutput(output);\n  player->setSource(QUrl::fromLocalFile(fname));\n  output->setVolume(m_volume / 100);\n  connect(player, &QMediaPlayer::playbackStateChanged, this, [=, this] {\n    if (player->playbackState() != QMediaPlayer::PlayingState) {\n      player->deleteLater();\n      output->deleteLater();\n      maxConcurrentPlayback++;\n    }\n  });\n  player->play();";
    output = replaceOnce(
      output,
      threadedAudio,
      "#ifdef Q_OS_WASM\n" + directAudio + "\n#else\n" + threadedAudio + "\n#endif",
      "main-thread browser audio",
    );
    output = replaceOnce(
      output,
      "void QmlBackend::detectServer() {\n  static const char *ask_str",
      "void QmlBackend::detectServer() {\n#ifdef Q_OS_WASM\n  emit notifyUI(\"ErrorMsg\", tr(\"LAN discovery is unavailable in a browser.\"));\n  return;\n#endif\n  static const char *ask_str",
      "disable browser LAN detection",
    );
    output = replaceOnce(
      output,
      "void QmlBackend::getServerInfo(const QString &address, ushort port) {\n  QString addr",
      "void QmlBackend::getServerInfo(const QString &address, ushort port) {\n#ifdef Q_OS_WASM\n  Q_UNUSED(address);\n  Q_UNUSED(port);\n  return;\n#endif\n  QString addr",
      "disable browser UDP server info",
    );
    output = replaceOnce(
      output,
      "void QmlBackend::readPendingDatagrams() {\n  while (udpSocket->hasPendingDatagrams())",
      "void QmlBackend::readPendingDatagrams() {\n#ifdef Q_OS_WASM\n  return;\n#endif\n  while (udpSocket->hasPendingDatagrams())",
      "disable browser UDP reads",
    );
    output = replaceOnce(
      output,
      "void QmlBackend::removeRecord(const QString &fname) {\n  QFile::remove(\"recording/\" + fname);\n}",
      "void QmlBackend::removeRecord(const QString &fname) {\n#ifdef Q_OS_WASM\n  QFile::remove(WebPlatform::persistentPath(\"recording/\") + fname);\n  WebPlatform::syncPersistentFileSystem();\n#else\n  QFile::remove(\"recording/\" + fname);\n#endif\n}",
      "persistent recording removal",
    );
    return output;
  });
}

async function patchPch(freeKill) {
  await transform(join(freeKill, "src", "pch.h"), (source) =>
    replaceOnce(
      source,
      "#if !defined (Q_OS_ANDROID)\n#define DESKTOP_BUILD\n#endif",
      "#if !defined(Q_OS_ANDROID) && !defined(Q_OS_WASM)\n#define DESKTOP_BUILD\n#endif",
      "browser desktop feature guard",
    ),
  );
}

async function patchClientSocket(freeKill) {
  await transform(join(freeKill, "src", "network", "client_socket.cpp"), (source) =>
    replaceAllChecked(
      source,
      "*error = QCborError::",
      "error->c = QCborError::",
      3,
      "Qt 6.8 QCborError assignments",
    ),
  );
}

async function patchSwigForWeb(freeKill) {
  await transform(join(freeKill, "src", "swig", "naturalvar.i"), (source) => {
    let output = replaceOnce(
      source,
      '#include "server/gamelogic/roomthread.h"\n',
      "",
      "browser server type include",
    );
    output = replaceOnce(
      output,
      "    } else if (typeId == QMetaType::fromType<RoomThread *>().id()) {\n" +
        "      SWIG_NewPointerObj(L, v.value<RoomThread *>(), SWIGTYPE_p_RoomThread, 0);\n" +
        "    } else if (typeId == QMetaType::fromType<Server *>().id()) {\n" +
        "      SWIG_NewPointerObj(L, v.value<Server *>(), SWIGTYPE_p_Server, 0);\n",
      "",
      "browser server QVariant bindings",
    );
    return output;
  });

  await transform(join(freeKill, "src", "swig", "qt.i"), (source) =>
    replaceOnce(
      source,
      "%template(SPlayerList) QList<ServerPlayer *>;\n",
      "",
      "browser server player list binding",
    ),
  );
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  await assertHead(options.freeKill, expectedFreeKill, "FreeKill");
  if (options.syncCore) {
    await assertHead(options.core, expectedCore, "freekill-core");
    await syncCore(options.core, options.freeKill);
  }

  await cp(join(repositoryRoot, "overlays", "freekill", "src"), join(options.freeKill, "src"), {
    recursive: true,
    force: true,
  });
  await patchRootCMake(options.freeKill);
  await patchSourceCMake(options.freeKill);
  await patchFreekillEntry(options.freeKill);
  await patchClient(options.freeKill);
  await patchUtilities(options.freeKill);
  await patchQmlBackend(options.freeKill);
  await patchPch(options.freeKill);
  await patchClientSocket(options.freeKill);
  await patchSwigForWeb(options.freeKill);

  await writeFile(
    join(options.freeKill, "freekill-web-build.json"),
    `${JSON.stringify(
      { freeKill: expectedFreeKill, core: options.syncCore ? expectedCore : null },
      null,
      2,
    )}\n`,
  );
  console.log(`Prepared ${basename(options.freeKill)} for Qt WebAssembly.`);
}

await main();
