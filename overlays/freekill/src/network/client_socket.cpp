// SPDX-License-Identifier: GPL-3.0-or-later

#include "network/client_socket.h"

#ifdef Q_OS_WASM
#include "web/web_platform.h"
#endif

#include <cstring>
#include <openssl/aes.h>

ClientSocket::ClientSocket()
#ifdef Q_OS_WASM
    : socket(new QWebSocket(QString(), QWebSocketProtocol::VersionLatest, this))
#else
    : socket(new QTcpSocket(this))
#endif
{
  aes_ready = false;
  init();
}

#ifndef Q_OS_WASM
ClientSocket::ClientSocket(QTcpSocket *socket) {
  aes_ready = false;
  socket->setParent(this);
  this->socket = socket;
  timerSignup.setSingleShot(true);
  connect(&timerSignup, &QTimer::timeout, this, &ClientSocket::disconnectFromHost);
  connect(&timerSignup, &QTimer::timeout, this, &QObject::deleteLater);
  init();
}
#endif

void ClientSocket::init() {
#ifdef Q_OS_WASM
  connect(socket, &QWebSocket::connected, this, &ClientSocket::connected);
  connect(socket, &QWebSocket::disconnected, this, &ClientSocket::disconnected);
  connect(socket, &QWebSocket::disconnected, this, &ClientSocket::removeAESKey);
  connect(socket, &QWebSocket::binaryMessageReceived, this,
          &ClientSocket::consumeIncoming);
  connect(socket, &QWebSocket::errorOccurred, this, &ClientSocket::raiseError);
#else
  connect(socket, &QTcpSocket::connected, this, &ClientSocket::connected);
  connect(socket, &QTcpSocket::disconnected, this, &ClientSocket::disconnected);
  connect(socket, &QTcpSocket::disconnected, this, &ClientSocket::removeAESKey);
  connect(socket, &QTcpSocket::readyRead, this, &ClientSocket::getMessage);
  connect(socket, &QTcpSocket::errorOccurred, this, &ClientSocket::raiseError);
  socket->setSocketOption(QAbstractSocket::KeepAliveOption, 1);
#endif
}

void ClientSocket::connectToHost(const QString &address, ushort port) {
#ifdef Q_OS_WASM
  Q_UNUSED(port);
  requested_peer_address = address;
  socket->open(QUrl(WebPlatform::webSocketUrl()));
#else
  socket->connectToHost(address, port);
#endif
}

void ClientSocket::getMessage() {
#ifndef Q_OS_WASM
  consumeIncoming(socket->readAll());
#endif
}

void ClientSocket::consumeIncoming(const QByteArray &bytes) {
  cborBuffer += bytes;
  QCborError error;
  const auto arrays = readCborArrsFromBuffer(&error);
  if (error == QCborError::EndOfFile || error == QCborError::NoError) {
    for (const auto &array : arrays) emit message_got(array);
    return;
  }
  disconnectFromHost();
}

void ClientSocket::disconnectFromHost() {
  aes_ready = false;
#ifdef Q_OS_WASM
  socket->close(QWebSocketProtocol::CloseCodeNormal, QStringLiteral("client disconnect"));
#else
  socket->disconnectFromHost();
#endif
}

void ClientSocket::send(const QByteArray &msg) {
  if (socket->state() != QAbstractSocket::ConnectedState) {
    emit error_message("Cannot send messages if not connected");
    return;
  }
#ifdef Q_OS_WASM
  socket->sendBinaryMessage(msg);
#else
  socket->write(msg);
  socket->flush();
#endif
}

bool ClientSocket::isConnected() const {
  return socket->state() == QAbstractSocket::ConnectedState;
}

QString ClientSocket::peerName() const {
#ifdef Q_OS_WASM
  return requested_peer_address.isEmpty() ? socket->requestUrl().host()
                                           : requested_peer_address;
#else
  QString name = socket->peerName();
  if (name.isEmpty()) {
    name = QString("%1:%2")
               .arg(socket->peerAddress().toString())
               .arg(socket->peerPort());
  }
  return name;
#endif
}

QString ClientSocket::peerAddress() const {
#ifdef Q_OS_WASM
  return requested_peer_address.isEmpty() ? socket->requestUrl().host()
                                           : requested_peer_address;
#else
  return socket->peerAddress().toString();
#endif
}

void ClientSocket::raiseError(QAbstractSocket::SocketError socket_error) {
  QString reason;
  switch (socket_error) {
  case QAbstractSocket::ConnectionRefusedError:
    reason = tr("Connection was refused or timeout");
    break;
  case QAbstractSocket::RemoteHostClosedError:
    reason = tr("Remote host close this connection");
    break;
  case QAbstractSocket::HostNotFoundError:
    reason = tr("Host not found");
    break;
  case QAbstractSocket::SocketAccessError:
    reason = tr("Socket access error");
    break;
  case QAbstractSocket::SocketResourceError:
    reason = tr("Socket resource error");
    break;
  case QAbstractSocket::SocketTimeoutError:
    reason = tr("Socket timeout error");
    break;
  case QAbstractSocket::DatagramTooLargeError:
    reason = tr("Datagram too large error");
    break;
  case QAbstractSocket::NetworkError:
    reason = tr("Network error");
    break;
  case QAbstractSocket::UnsupportedSocketOperationError:
    reason = tr("Unsupported socket operation");
    break;
  case QAbstractSocket::UnfinishedSocketOperationError:
    reason = tr("Unfinished socket operation");
    break;
  case QAbstractSocket::ProxyAuthenticationRequiredError:
    reason = tr("Proxy auth error");
    break;
  case QAbstractSocket::ProxyConnectionRefusedError:
    reason = tr("Proxy refused");
    break;
  case QAbstractSocket::ProxyConnectionClosedError:
    reason = tr("Proxy closed");
    break;
  case QAbstractSocket::ProxyConnectionTimeoutError:
    reason = tr("Proxy timeout error");
    break;
  case QAbstractSocket::ProxyProtocolError:
    reason = tr("Proxy protocol error");
    break;
  case QAbstractSocket::OperationError:
    reason = tr("Operation error");
    break;
  case QAbstractSocket::TemporaryError:
    reason = tr("Temporary error");
    break;
  default:
    reason = tr("Unknown error");
    break;
  }

  emit error_message(tr("Connection failed, error code = %1\n reason: %2")
                         .arg(socket_error)
                         .arg(reason));
}

void ClientSocket::installAESKey(const QByteArray &key) {
  if (key.length() != 32) return;
  const auto decoded = QByteArray::fromHex(key);
  if (decoded.length() != 16) return;
  AES_set_encrypt_key(reinterpret_cast<const unsigned char *>(decoded.data()),
                      16 * 8, &aes_key);
  aes_ready = true;
}

void ClientSocket::removeAESKey() { aes_ready = false; }

QByteArray ClientSocket::aesEnc(const QByteArray &in) {
  if (!aes_ready) return in;

  int num = 0;
  QByteArray out(in.length(), Qt::Uninitialized);
  static auto random = QRandomGenerator::securelySeeded();
  QByteArray iv(16, Qt::Uninitialized);
  random.fillRange(reinterpret_cast<quint32 *>(iv.data()), 4);
  unsigned char temporaryIv[16];
  std::memcpy(temporaryIv, iv.constData(), 16);
  AES_cfb128_encrypt(reinterpret_cast<const unsigned char *>(in.constData()),
                     reinterpret_cast<unsigned char *>(out.data()), in.length(),
                     &aes_key, temporaryIv, &num, AES_ENCRYPT);
  return iv.toHex() + out.toBase64();
}

QByteArray ClientSocket::aesDec(const QByteArray &in) {
  if (!aes_ready) return in;

  int num = 0;
  const auto iv = QByteArray::fromHex(in.first(32));
  const auto encrypted = QByteArray::fromBase64(in.sliced(32));
  QByteArray out(encrypted.length(), Qt::Uninitialized);
  unsigned char temporaryIv[16];
  std::memcpy(temporaryIv, iv.constData(), 16);
  AES_cfb128_encrypt(
      reinterpret_cast<const unsigned char *>(encrypted.constData()),
      reinterpret_cast<unsigned char *>(out.data()), encrypted.length(), &aes_key,
      temporaryIv, &num, AES_DECRYPT);
  return out;
}

static QCborValue readItem(QCborStreamReader &reader) {
  switch (reader.type()) {
  case QCborStreamReader::UnsignedInteger:
  case QCborStreamReader::NegativeInteger: {
    const auto value = reader.toInteger();
    reader.next();
    return value;
  }
  case QCborStreamReader::ByteArray: {
    QByteArray result;
    auto part = reader.readByteArray();
    while (part.status == QCborStreamReader::Ok) {
      result += part.data;
      part = reader.readByteArray();
    }
    if (part.status == QCborStreamReader::Error) result.clear();
    return result;
  }
  case QCborStreamReader::Array: {
    QCborArray result;
    reader.enterContainer();
    while (reader.lastError() == QCborError::NoError && reader.hasNext()) {
      const auto item = readItem(reader);
      if (item.isUndefined()) break;
      result << item;
    }
    if (reader.lastError() == QCborError::NoError) reader.leaveContainer();
    return result;
  }
  default:
    return {};
  }
}

QList<QCborArray> ClientSocket::readCborArrsFromBuffer(QCborError *error) {
  auto cursor = cborBuffer.constData();
  auto remaining = cborBuffer.size();
  QList<QCborArray> result;

  while (remaining > 0) {
    QCborStreamReader reader(cursor, remaining);
    const auto item = readItem(reader);
    if (reader.lastError() != QCborError::NoError) {
      *error = reader.lastError();
      break;
    }
    if (!item.isArray()) {
      *error = QCborError{QCborError::IllegalType};
      break;
    }
    result << item.toArray();
    const auto consumed = reader.currentOffset();
    if (consumed <= 0) {
      *error = QCborError{QCborError::UnknownError};
      break;
    }
    cursor += consumed;
    remaining -= consumed;
    *error = QCborError{QCborError::NoError};
  }

  cborBuffer = QByteArray(cursor, remaining);
  return result;
}
