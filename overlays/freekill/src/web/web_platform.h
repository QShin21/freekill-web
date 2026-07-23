// SPDX-License-Identifier: GPL-3.0-or-later

#pragma once

#include <QString>

namespace WebPlatform {

QString webSocketUrl();
QString serverAddress();
int serverPort();
QString deviceUuid();
QString persistentPath(const QString &relativePath);
void syncPersistentFileSystem();

} // namespace WebPlatform
