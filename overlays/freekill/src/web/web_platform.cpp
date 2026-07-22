// SPDX-License-Identifier: GPL-3.0-or-later

#include "web/web_platform.h"

#include <cstdlib>
#include <emscripten.h>

namespace {

EM_JS(char *, duplicateWebSocketUrl, (), {
  const config = globalThis.FREEKILL_WEB_CONFIG || {};
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const path = config.webSocketPath || "/ws";
  const value = config.webSocketUrl || `${scheme}//${location.host}${path}`;
  const size = lengthBytesUTF8(value) + 1;
  const result = _malloc(size);
  stringToUTF8(value, result, size);
  return result;
});

EM_JS(char *, duplicateDeviceUuid, (), {
  const key = "freekill.deviceUuid";
  let value = "";
  try {
    value = localStorage.getItem(key) || "";
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() ||
        `web-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(key, value);
    }
  } catch (_) {
    value = `web-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }
  const size = lengthBytesUTF8(value) + 1;
  const result = _malloc(size);
  stringToUTF8(value, result, size);
  return result;
});

QString takeString(char *value) {
  const auto result = QString::fromUtf8(value);
  std::free(value);
  return result;
}

} // namespace

namespace WebPlatform {

QString webSocketUrl() { return takeString(duplicateWebSocketUrl()); }

QString deviceUuid() { return takeString(duplicateDeviceUuid()); }

QString persistentPath(const QString &relativePath) {
  auto clean = relativePath;
  while (clean.startsWith('/')) clean.removeFirst();
  return QStringLiteral("/persistent/") + clean;
}

void syncPersistentFileSystem() {
  EM_ASM({
    if (typeof FS !== "undefined") {
      FS.syncfs(false, (error) => {
        if (error) console.warn("Unable to persist FreeKill data", error);
      });
    }
  });
}

} // namespace WebPlatform
