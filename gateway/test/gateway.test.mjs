import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { createGateway } from "../src/gateway.mjs";

const silentLogger = { info() {}, warn() {}, error() {} };

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function fixture(overrides = {}) {
  const tcpServer = net.createServer((socket) => {
    socket.on("data", (data) => socket.write(data));
  });
  const upstreamPort = await listen(tcpServer);
  const gateway = createGateway(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort,
      webSocketPath: "/ws",
      allowedOrigins: [],
      connectTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      maxPayloadBytes: 1024 * 1024,
      maxConnections: 10,
      ...overrides,
    },
    { logger: silentLogger },
  );
  const address = await gateway.listen();
  return {
    gateway,
    tcpServer,
    port: address.port,
    async close() {
      await gateway.close();
      await closeServer(tcpServer);
    },
  };
}

function openWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, options);
    webSocket.binaryType = "nodebuffer";
    webSocket.once("open", () => resolve(webSocket));
    webSocket.once("error", reject);
  });
}

function nextMessage(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    webSocket.once("error", reject);
  });
}

test("health endpoint reports ready", async () => {
  const current = await fixture();
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${current.port}/healthz`, (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => resolve({ status: response.statusCode, data }));
      }).on("error", reject);
    });
    assert.equal(body.status, 200);
    assert.deepEqual(JSON.parse(body.data), { ok: true });
  } finally {
    await current.close();
  }
});

test("binary bytes make an exact round trip through TCP", async () => {
  const current = await fixture();
  try {
    const webSocket = await openWebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const expected = Buffer.from([0x84, 0x01, 0x18, 0x21, 0x43, 0x00, 0xff, 0x7f]);
    const received = nextMessage(webSocket);
    webSocket.send(expected);
    const message = await received;
    assert.equal(message.isBinary, true);
    assert.deepEqual(message.data, expected);
    webSocket.close();
  } finally {
    await current.close();
  }
});

test("text frames are rejected", async () => {
  const current = await fixture();
  try {
    const webSocket = await openWebSocket(`ws://127.0.0.1:${current.port}/ws`);
    const closed = new Promise((resolve) => webSocket.once("close", (code) => resolve(code)));
    webSocket.send("not cbor");
    assert.equal(await closed, 1003);
  } finally {
    await current.close();
  }
});

test("origin allow-list rejects an unrelated site", async () => {
  const current = await fixture({ allowedOrigins: ["https://play.example.com"] });
  try {
    const error = await new Promise((resolve) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${current.port}/ws`, {
        origin: "https://evil.example",
      });
      webSocket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
      webSocket.once("error", () => {});
    });
    assert.equal(error, 403);
  } finally {
    await current.close();
  }
});

test("unknown websocket paths are rejected", async () => {
  const current = await fixture();
  try {
    const status = await new Promise((resolve) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${current.port}/other`);
      webSocket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
      webSocket.once("error", () => {});
    });
    assert.equal(status, 404);
  } finally {
    await current.close();
  }
});

test("an unavailable game server closes with a retryable status", async () => {
  const reserved = net.createServer();
  const unavailablePort = await listen(reserved);
  await closeServer(reserved);
  const gateway = createGateway(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: unavailablePort,
      webSocketPath: "/ws",
      allowedOrigins: [],
      connectTimeoutMs: 500,
      heartbeatMs: 5_000,
      maxPayloadBytes: 1024 * 1024,
      maxConnections: 10,
    },
    { logger: silentLogger },
  );
  const address = await gateway.listen();
  try {
    const webSocket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const code = await new Promise((resolve) => webSocket.once("close", resolve));
    assert.equal(code, 1013);
  } finally {
    await gateway.close();
  }
});
