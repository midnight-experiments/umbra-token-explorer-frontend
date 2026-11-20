// Token metadata viewer (POC): serves index.html and forwards GET /api/<network>/tokens?<selector> to that network's UmbraDB
// token-metadata API. The API sends no CORS headers, so the page reaches it through this same-origin forwarder.
// No dependencies:  node server.mjs   then open http://127.0.0.1:10591
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 10591);
/** Each network's module API (UmbraDB's `listen.api`). */
const APIS = {
  preprod: process.env.PREPROD_API ?? "http://127.0.0.1:10540",
  preview: process.env.PREVIEW_API ?? "http://127.0.0.1:10550",
  // No local mainnet indexer by default: start the viewer with MAINNET_API=http://host:port to use one.
  mainnet: process.env.MAINNET_API ?? null,
};
const STATIC = { "/": ["index.html", "text/html; charset=utf-8"] };
/** The answer headers the page shows: the finalized block the answer was read at. */
const PASSED = ["content-type", "x-umbra-height", "x-umbra-hash", "x-umbra-view"];

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const file = STATIC[url.pathname];
  if (req.method === "GET" && file) {
    res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" });
    return res.end(await readFile(HERE + file[0]));
  }
  const match = /^\/api\/(\w+)\/tokens$/.exec(url.pathname);
  const api = match && APIS[match[1]];
  if (req.method === "GET" && match && match[1] in APIS && !api) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { code: "no-api", message: `no ${match[1]} indexer is configured for this viewer (start it with ${match[1].toUpperCase()}_API=http://host:port)` } }));
  }
  if (req.method !== "GET" || !api) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  // The selector is the query string, passed on as it came (the API checks it).
  const upstream = request(`${api}/token-metadata-api/v1/tokens${url.search}`, { method: "GET" }, (answer) => {
    const headers = Object.fromEntries(PASSED.filter((h) => answer.headers[h]).map((h) => [h, answer.headers[h]]));
    res.writeHead(answer.statusCode ?? 502, { ...headers, "cache-control": "no-store" });
    answer.pipe(res);
  });
  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "api-unreachable", message: `${match[1]} API at ${api}: ${error.message}` } }));
  });
  upstream.end();
}).listen(PORT, "127.0.0.1", () => console.log(`token metadata viewer on http://127.0.0.1:${PORT}`));
