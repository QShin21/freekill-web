function integer(name, value, fallback, min, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
function origins(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function configFromEnv(env = process.env) {
  const webSocketPath = env.WS_PATH || "/ws";
  if (!webSocketPath.startsWith("/") || webSocketPath.includes("?")) {
    throw new Error("WS_PATH must be an absolute URL path without a query string");
  }

  return {
    host: env.HOST || "0.0.0.0",
    port: integer("PORT", env.PORT, 9528, 0, 65535),
    upstreamHost: env.FREEKILL_HOST || "127.0.0.1",
    upstreamPort: integer("FREEKILL_PORT", env.FREEKILL_PORT, 9527, 1, 65535),
    webSocketPath,
    allowedOrigins: origins(env.ALLOWED_ORIGINS),
    connectTimeoutMs: integer(
      "CONNECT_TIMEOUT_MS",
      env.CONNECT_TIMEOUT_MS,
      10_000,
      100,
      120_000,
    ),
    heartbeatMs: integer("HEARTBEAT_MS", env.HEARTBEAT_MS, 30_000, 1_000, 300_000),
    maxPayloadBytes: integer(
      "MAX_PAYLOAD_BYTES",
      env.MAX_PAYLOAD_BYTES,
      32 * 1024 * 1024,
      1024,
      256 * 1024 * 1024,
    ),
    maxConnections: integer("MAX_CONNECTIONS", env.MAX_CONNECTIONS, 2_000, 1, 100_000),
  };
}
