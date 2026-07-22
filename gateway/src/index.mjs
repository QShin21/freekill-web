import { configFromEnv } from "./config.mjs";
import { createGateway } from "./gateway.mjs";

const config = configFromEnv();
const gateway = createGateway(config);

async function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", event: "shutdown", signal }));
  try {
    await gateway.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "shutdown_failed", message: error.message }));
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await gateway.listen();
} catch (error) {
  console.error(JSON.stringify({ level: "error", event: "startup_failed", message: error.message }));
  process.exitCode = 1;
}
