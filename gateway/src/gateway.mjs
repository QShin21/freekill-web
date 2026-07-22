import http from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

function requestPath(request) {
  try {
    return new URL(request.url, "http://gateway.invalid").pathname;
  } catch {
    return "";
  }
}

function rejectUpgrade(socket, status, reason) {
  if (!socket.writable) return;
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

function originAllowed(origin, allowedOrigins) {
  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) return true;
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

function defaultLogger() {
  return {
    info(event, detail = {}) {
      console.log(JSON.stringify({ level: "info", event, ...detail }));
    },
    warn(event, detail = {}) {
      console.warn(JSON.stringify({ level: "warn", event, ...detail }));
    },
    error(event, detail = {}) {
      console.error(JSON.stringify({ level: "error", event, ...detail }));
    },
  };
}

function safeClose(webSocket, code, reason) {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.close(code, reason);
  } else if (webSocket.readyState !== WebSocket.CLOSED) {
    webSocket.terminate();
  }
}

export function createGateway(options, dependencies = {}) {
  const logger = dependencies.logger || defaultLogger();
  const connect = dependencies.connect || ((connectOptions) => net.createConnection(connectOptions));
  const server = http.createServer((request, response) => {
    const path = requestPath(request);
    if (request.method === "GET" && (path === "/healthz" || path === "/readyz")) {
      response.writeHead(200, JSON_HEADERS);
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, JSON_HEADERS);
    response.end(JSON.stringify({ error: "not found" }));
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: options.maxPayloadBytes,
    perMessageDeflate: false,
  });

  server.on("upgrade", (request, socket, head) => {
    if (requestPath(request) !== options.webSocketPath) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!originAllowed(request.headers.origin, options.allowedOrigins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (webSocketServer.clients.size >= options.maxConnections) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (webSocket, request) => {
    const clientSocket = request.socket;
    const remoteAddress = clientSocket.remoteAddress || "unknown";
    webSocket.isAlive = true;
    webSocket.on("pong", () => {
      webSocket.isAlive = true;
    });

    // Do not let a browser fill memory while the game-server connection is pending.
    clientSocket.pause();
    const upstream = connect({
      host: options.upstreamHost,
      port: options.upstreamPort,
    });
    upstream.setNoDelay?.(true);
    upstream.setKeepAlive?.(true, options.heartbeatMs);

    let upstreamConnected = false;
    let finished = false;
    const connectTimer = setTimeout(() => {
      logger.warn("upstream_connect_timeout", { remoteAddress });
      upstream.destroy();
      clientSocket.resume();
      safeClose(webSocket, 1013, "Game server connection timed out");
    }, options.connectTimeoutMs);
    connectTimer.unref?.();

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      upstream.destroy();
    };

    upstream.once("connect", () => {
      upstreamConnected = true;
      clearTimeout(connectTimer);
      clientSocket.resume();
      logger.info("tunnel_open", { remoteAddress });
    });

    upstream.on("data", (chunk) => {
      if (webSocket.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }

      // One TCP chunk becomes one binary frame. FreeKill still treats the bytes as
      // a stream and reconstructs CBOR packets across arbitrary frame boundaries.
      upstream.pause();
      webSocket.send(chunk, { binary: true, compress: false }, (error) => {
        if (error) {
          logger.warn("websocket_write_error", { remoteAddress, message: error.message });
          finish();
          return;
        }
        upstream.resume();
      });
    });

    upstream.once("end", () => {
      safeClose(webSocket, 1001, "Game server closed the connection");
      finish();
    });
    upstream.once("error", (error) => {
      logger.warn("upstream_error", { remoteAddress, message: error.message });
      clientSocket.resume();
      safeClose(
        webSocket,
        upstreamConnected ? 1011 : 1013,
        upstreamConnected ? "Game server connection failed" : "Game server unavailable",
      );
      finish();
    });

    webSocket.on("message", (data, isBinary) => {
      if (!isBinary) {
        safeClose(webSocket, 1003, "FreeKill accepts binary CBOR only");
        finish();
        return;
      }
      if (!upstreamConnected || upstream.destroyed) {
        safeClose(webSocket, 1013, "Game server unavailable");
        finish();
        return;
      }

      if (!upstream.write(data)) {
        clientSocket.pause();
        upstream.once("drain", () => {
          if (!finished) clientSocket.resume();
        });
      }
    });
    webSocket.once("close", () => {
      logger.info("tunnel_close", { remoteAddress });
      finish();
    });
    webSocket.once("error", (error) => {
      logger.warn("websocket_error", { remoteAddress, message: error.message });
      finish();
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const webSocket of webSocketServer.clients) {
      if (!webSocket.isAlive) {
        webSocket.terminate();
        continue;
      }
      webSocket.isAlive = false;
      webSocket.ping();
    }
  }, options.heartbeatMs);
  heartbeatTimer.unref?.();

  return {
    server,
    webSocketServer,
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      });
      const address = server.address();
      logger.info("gateway_listening", {
        address: typeof address === "object" && address ? address.address : String(address),
        port: typeof address === "object" && address ? address.port : options.port,
        path: options.webSocketPath,
        upstream: `${options.upstreamHost}:${options.upstreamPort}`,
      });
      return address;
    },
    async close() {
      clearInterval(heartbeatTimer);
      for (const webSocket of webSocketServer.clients) webSocket.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}
