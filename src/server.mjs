// The token explorer's server: it serves the page in `public/` and forwards GET /api/<network>/tokens?<selector> to
// that network's UmbraDB token-metadata API. The API sends no CORS headers, so the page reaches it through this
// same-origin forwarder. No dependencies: Node's standard library only.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/** The networks the page offers, in the order of its buttons. */
export const NETWORKS = ["mainnet", "preview", "preprod"];

/** The files of the page: path → [file in public/, content type]. Nothing else is served from disk. */
const ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const PUBLIC = new URL("../public/", import.meta.url);

/** The API's answer headers the page reads: the finalized block the answer was read at. */
const PASSED = ["content-type", "x-umbra-height", "x-umbra-hash", "x-umbra-view"];

/**
 * The page's own script and style only. Token images come from any https host the publisher chose: the page fetches
 * them to check their SHA-256 (connect-src) and shows them from a blob: URL, or directly when no hash is published.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: blob:",
  "connect-src 'self' https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

const DEFAULT_APIS = { preprod: "http://127.0.0.1:10540", preview: "http://127.0.0.1:10550", mainnet: null };

/**
 * The server's settings from the environment. A network's API variable unset takes its default, set to an empty
 * value turns the network off; mainnet has no default. Throws on a value that cannot work.
 */
export function configFromEnv(env = process.env) {
  const apis = {};
  for (const network of NETWORKS) {
    const name = `${network.toUpperCase()}_API`;
    const raw = env[name] === undefined ? DEFAULT_APIS[network] : env[name].trim() || null;
    if (raw === null) { apis[network] = null; continue; }
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${name} is not a URL: ${raw}`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http or https URL: ${raw}`);
    apis[network] = url.href.replace(/\/+$/, "");
  }
  const configured = NETWORKS.filter((n) => apis[n]);
  const defaultNetwork = env.DEFAULT_NETWORK?.trim() || (apis.preprod ? "preprod" : configured[0] ?? "preprod");
  if (!NETWORKS.includes(defaultNetwork)) throw new Error(`DEFAULT_NETWORK must be one of ${NETWORKS.join(", ")}: ${defaultNetwork}`);
  if (configured.length && !apis[defaultNetwork]) throw new Error(`DEFAULT_NETWORK is ${defaultNetwork}, which has no API configured`);
  const port = Number(env.PORT ?? 10591);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a port number: ${env.PORT}`);
  const upstreamTimeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? 15000);
  if (!(upstreamTimeoutMs > 0)) throw new Error(`UPSTREAM_TIMEOUT_MS must be a positive number: ${env.UPSTREAM_TIMEOUT_MS}`);
  return { host: env.HOST?.trim() || "127.0.0.1", port, apis, defaultNetwork, upstreamTimeoutMs };
}

/** Reads the page's files once: their bytes and an ETag each. */
async function loadAssets() {
  const assets = {};
  for (const [path, [file, type]] of Object.entries(ASSETS)) {
    const body = await readFile(new URL(file, PUBLIC));
    assets[path] = { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
  }
  return assets;
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}
const sendError = (res, status, code, message, headers) => sendJson(res, status, { error: { code, message } }, headers);

/**
 * The server, not yet listening. `config` is what `configFromEnv` gives; `log` takes the errors (an upstream's
 * address appears there, never in an answer to a visitor).
 */
export async function createExplorerServer(config, { log = console } = {}) {
  const assets = await loadAssets();
  const publicConfig = JSON.stringify({
    networks: Object.fromEntries(NETWORKS.map((n) => [n, Boolean(config.apis[n])])),
    defaultNetwork: config.defaultNetwork,
  });

  function forward(req, res, network, search) {
    const api = config.apis[network];
    const target = new URL(`${api}/token-metadata-api/v1/tokens`);
    target.search = search; // the selector, passed on as it came: the API checks it
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    // Nothing of the visitor's request is passed on (no cookies, no headers): only the selector.
    const upstream = request(target, { method: "GET", headers: { accept: "application/json" } }, (answer) => {
      const headers = Object.fromEntries(PASSED.filter((h) => answer.headers[h]).map((h) => [h, answer.headers[h]]));
      res.writeHead(answer.statusCode ?? 502, { ...SECURITY_HEADERS, ...headers, "cache-control": "no-store" });
      answer.on("error", () => res.destroy());
      answer.pipe(res);
    });
    upstream.setTimeout(config.upstreamTimeoutMs, () => upstream.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    upstream.on("error", (error) => {
      if (res.destroyed) return; // the visitor left first
      log.error(`${network} API at ${api}: ${error.message}`);
      if (res.headersSent) return res.destroy();
      if (error.code === "ETIMEDOUT") sendError(res, 504, "api-timeout", `the ${network} indexer did not answer in time`);
      else sendError(res, 502, "api-unreachable", `the ${network} indexer is not reachable`);
    });
    // A visitor who leaves before the answer is complete stops the request upstream.
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.end();
  }

  function handle(req, res) {
    let url;
    try { url = new URL(req.url ?? "/", "http://local"); } catch { return sendError(res, 400, "bad-request", "not a valid request path"); }
    if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "method-not-allowed", "only GET and HEAD", { allow: "GET, HEAD" });

    const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : null;
    if (asset) {
      const headers = { ...SECURITY_HEADERS, "content-type": asset.type, "cache-control": "no-cache", etag: asset.etag };
      if (req.headers["if-none-match"] === asset.etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { ...headers, "content-length": asset.body.length });
      return res.end(asset.body);
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("ok\n");
    }
    if (url.pathname === "/api/config") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(publicConfig);
    }
    const match = /^\/api\/([a-z]+)\/tokens$/.exec(url.pathname);
    // Own keys only: a path naming `constructor` or `toString` is not a network.
    if (match && Object.hasOwn(config.apis, match[1])) {
      if (!config.apis[match[1]]) return sendError(res, 503, "no-api", `no ${match[1]} indexer is configured on this server`);
      return forward(req, res, match[1], url.search);
    }
    return sendError(res, 404, "not-found", "not found");
  }

  return createServer((req, res) => {
    try { handle(req, res); } catch (error) {
      log.error(error);
      if (!res.headersSent) sendError(res, 500, "internal", "internal error");
      else res.destroy();
    }
  });
}
