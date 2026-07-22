// SPDX-License-Identifier: GPL-3.0-or-later

#include "core/packman.h"
#include "core/c-wrapper.h"
#include "ui/qmlbackend.h"
#include "web/web_platform.h"

PackMan *Pacman = nullptr;

namespace {

QString sqlQuoted(QString value) {
  return value.replace(''', "''");
}

} // namespace

PackMan::PackMan(QObject *parent) : QObject(parent) {
  QDir().mkpath(WebPlatform::persistentPath("packages"));
  db = std::make_unique<Sqlite3>(
      WebPlatform::persistentPath("packages/packages.db"),
      "./packages/init.sql");

  for (const auto &obj : db->select("SELECT name, enabled FROM packages;")) {
    if (obj["enabled"].toInt() != 1) disabled_packs << obj["name"];
  }
}

PackMan::~PackMan() { WebPlatform::syncPersistentFileSystem(); }

QStringList PackMan::getDisabledPacks() { return disabled_packs; }

QString PackMan::getPackSummary() {
  return db->selectJson("SELECT name, url, hash FROM packages WHERE enabled = 1;");
}

void PackMan::loadSummary(const QString &jsonData, bool) {
  const auto packages = QJsonDocument::fromJson(jsonData.toUtf8()).array();
  QStringList missing;

  for (const auto &entry : packages) {
    const auto object = entry.toObject();
    const auto name = object["name"].toString();
    const auto url = object["url"].toString();
    const auto hash = object["hash"].toString();
    if (name.isEmpty()) continue;

    if (!QDir(QStringLiteral("packages/") + name).exists()) {
      missing << name;
      continue;
    }

    const auto quotedName = sqlQuoted(name);
    db->exec(QString("DELETE FROM packages WHERE name = '%1';").arg(quotedName));
    db->exec(QString(
        "INSERT INTO packages (name,url,hash,enabled) VALUES ('%1','%2','%3',1);")
        .arg(quotedName, sqlQuoted(url), sqlQuoted(hash)));
    disabled_packs.removeAll(name);
  }

  if (!missing.isEmpty()) {
    Backend->notifyUI(
        "PackageDownloadError",
        tr("This web build does not contain the server packages: %1. Rebuild the web bundle with the same package set.")
            .arg(missing.join(", ")));
  }
  Backend->notifyUI("DownloadComplete", "");
  WebPlatform::syncPersistentFileSystem();
}

int PackMan::downloadNewPack(const QString &, bool) { return -1; }

void PackMan::enablePack(const QString &pack) {
  db->exec(QString("UPDATE packages SET enabled = 1 WHERE name = '%1';")
               .arg(sqlQuoted(pack)));
  disabled_packs.removeAll(pack);
  WebPlatform::syncPersistentFileSystem();
}

void PackMan::disablePack(const QString &pack) {
  if (pack == "freekill-core") return;
  db->exec(QString("UPDATE packages SET enabled = 0 WHERE name = '%1';")
               .arg(sqlQuoted(pack)));
  if (!disabled_packs.contains(pack)) disabled_packs << pack;
  WebPlatform::syncPersistentFileSystem();
}

int PackMan::updatePack(const QString &, const QString &) { return -1; }
int PackMan::upgradePack(const QString &) { return -1; }

void PackMan::removePack(const QString &pack) { disablePack(pack); }

QString PackMan::listPackages() { return db->selectJson("SELECT * FROM packages;"); }

void PackMan::forceCheckoutMaster(const QString &) {}
void PackMan::syncCommitHashToDatabase() {}

bool PackMan::shouldUseCore() {
  return QDir("packages/freekill-core").exists() &&
         !disabled_packs.contains("freekill-core");
}

int PackMan::clone(const QString &) { return -1; }
int PackMan::pull(const QString &) { return -1; }
int PackMan::hasCommit(const QString &, const QString &) { return -1; }
int PackMan::checkout(const QString &, const QString &) { return -1; }
int PackMan::checkout_branch(const QString &, const QString &) { return -1; }
int PackMan::status(const QString &) { return -1; }
QString PackMan::head(const QString &) { return {}; }
