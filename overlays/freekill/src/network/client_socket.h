// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef _CLIENT_SOCKET_H
#define _CLIENT_SOCKET_H

#include <openssl/aes.h>

#ifdef Q_OS_WASM
#include <QWebSocket>
#endif

class ClientSocket : public QObject {
  Q_OBJECT

public:
  ClientSocket();
#ifndef Q_OS_WASM
  ClientSocket(QTcpSocket *socket);
#endif

  void connectToHost(const QString &address = QStringLiteral("127.0.0.1"),
                     ushort port = 9527u);
  void disconnectFromHost();
  void installAESKey(const QByteArray &key);
  void removeAESKey();
  bool aesReady() const { return aes_ready; }
  void send(const QByteArray &msg);
  bool isConnected() const;
  QString peerName() const;
  QString peerAddress() const;
  QTimer timerSignup;

signals:
  void message_got(const QCborArray &msg);
  void error_message(const QString &msg);
  void disconnected();
  void connected();

private slots:
  void getMessage();
  void raiseError(QAbstractSocket::SocketError error);

private:
  QByteArray aesEnc(const QByteArray &in);
  QByteArray aesDec(const QByteArray &out);
  void init();
  void consumeIncoming(const QByteArray &bytes);

  AES_KEY aes_key;
  bool aes_ready;
#ifdef Q_OS_WASM
  QWebSocket *socket;
  QString requested_peer_address;
#else
  QTcpSocket *socket;
#endif
  QByteArray cborBuffer;
  QList<QCborArray> readCborArrsFromBuffer(QCborError *err);
};

#endif // _CLIENT_SOCKET_H
