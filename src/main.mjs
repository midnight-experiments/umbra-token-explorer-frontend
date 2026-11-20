#!/usr/bin/env node
// Starts the token explorer with the settings in the environment (see README.md and .env.example).
import { configFromEnv, createExplorerServer, NETWORKS } from "./server.mjs";

let config;
try { config = configFromEnv(); } catch (error) {
  console.error(`token explorer: ${error.message}`);
  process.exit(1);
}
const server = await createExplorerServer(config);
server.listen(config.port, config.host, () => {
  const { port } = server.address();
  const networks = NETWORKS.map((n) => `${n}=${config.apis[n] ? "on" : "off"}`).join(" ");
  console.log(`token explorer on http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port} (${networks}; default ${config.defaultNetwork})`);
});

// Stop taking connections, let answers in flight finish, and leave within 10 s at the latest.
function stop(signal) {
  console.log(`token explorer: ${signal}, stopping`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
