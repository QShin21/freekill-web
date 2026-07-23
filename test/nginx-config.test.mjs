import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const securityHeaders = [
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Embedder-Policy",
  "Cross-Origin-Resource-Policy",
  "Content-Security-Policy",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the standalone reverse proxy emits one copy of each security header", async () => {
  const config = await readFile(
    resolve(repositoryRoot, "deployment", "nginx-freekill.conf"),
    "utf8",
  );

  for (const header of securityHeaders) {
    const escaped = escapeRegExp(header);
    assert.match(config, new RegExp(`\\bproxy_hide_header\\s+${escaped};`, "i"));
    assert.equal(
      [...config.matchAll(new RegExp(`\\badd_header\\s+${escaped}\\b`, "gi"))].length,
      1,
      `${header} must be added exactly once`,
    );
  }
});
