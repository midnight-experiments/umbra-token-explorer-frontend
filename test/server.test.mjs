import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { configFromEnv, createExplorerServer } from "../src/server.mjs";

/** A stand-in for UmbraDB's API: it records each request and answers as `reply` says. */
const seen = [];
let reply = (req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-umbra-height": "42", "x-umbra-hash": "0xabc", "x-umbra-view": "finalized", "set-cookie": "a=b", "x-internal": "1" });
  res.end(JSON.stringify({ items: [], nextCursor: null }));
};
const upstream = createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); reply(req, res); });

/** A port nothing listens on. */
async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const errors = [];
let server, base;
before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const config = configFromEnv({
    PREPROD_API: `http://127.0.0.1:${upstream.address().port}/`,
    PREVIEW_API: `http://127.0.0.1:${await closedPort()}`,
    UPSTREAM_TIMEOUT_MS: "300",
  });
  server = await createExplorerServer(config, { log: { error: (e) => errors.push(String(e)) } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
});

/** A raw request (the path as given, not normalised the way fetch would). */
function raw(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path.startsWith("/") ? "" : "/"}`, { method, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("serves the page with its security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const html = await res.text();
  assert.match(html, /<script src="app.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>|<style>|style="/, "no inline script or style: the CSP refuses them");
});

test("serves the script, the styles and the icon, and answers 304 to a matching ETag", async () => {
  for (const [path, type] of [["/app.js", /javascript/], ["/styles.css", /text\/css/], ["/favicon.svg", /image\/svg\+xml/]]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), type, path);
    const again = await fetch(`${base}${path}`, { headers: { "if-none-match": res.headers.get("etag") } });
    assert.equal(again.status, 304, path);
  }
});

test("HEAD answers like GET without a body", async () => {
  const res = await raw("HEAD", "/");
  assert.equal(res.status, 200);
  assert.equal(res.body, "");
});

test("serves no other file", async () => {
  for (const path of ["/index.html", "/../src/server.mjs", "/%2e%2e/package.json", "/public/app.js"]) {
    assert.equal((await raw("GET", path)).status, 404, path);
  }
});

test("refuses other methods", async () => {
  const res = await fetch(`${base}/`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("health and config", async () => {
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok\n");
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), {
    networks: { mainnet: false, preview: true, preprod: true },
    defaultNetwork: "preprod",
  });
});

test("forwards the selector, and only the answer headers the page reads", async () => {
  seen.length = 0;
  const res = await fetch(`${base}/api/preprod/tokens?contract=0x${"ab".repeat(32)}&limit=2`, { headers: { cookie: "session=secret", authorization: "Bearer x" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items: [], nextCursor: null });
  assert.equal(seen[0].url, `/token-metadata-api/v1/tokens?contract=0x${"ab".repeat(32)}&limit=2`);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(res.headers.get("x-umbra-height"), "42");
  assert.equal(res.headers.get("x-umbra-view"), "finalized");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-internal"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("passes the API's own errors on", async () => {
  reply = (req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"code":"bad-selector","message":"no"}}'); };
  const res = await fetch(`${base}/api/preprod/tokens?limit=9999`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad-selector");
});

test("a path naming an Object property is not a network, and the server keeps running", async () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal((await raw("GET", `/api/${name}/tokens`)).status, 404, name);
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("a path that is not a URL gets 400, and the server keeps running", async () => {
  assert.equal((await raw("GET", "//%")).status, 400);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("a network with no indexer says so", async () => {
  const res = await fetch(`${base}/api/mainnet/tokens`);
  assert.equal(res.status, 503);
  const { error } = await res.json();
  assert.equal(error.code, "no-api");
  assert.doesNotMatch(error.message, /_API|http/, "no server setting in a visitor's answer");
});

test("an unreachable indexer is a 502 that does not show its address", async () => {
  errors.length = 0;
  const res = await fetch(`${base}/api/preview/tokens`);
  assert.equal(res.status, 502);
  const { error } = await res.json();
  assert.equal(error.code, "api-unreachable");
  assert.doesNotMatch(error.message, /127\.0\.0\.1|http/);
  assert.match(errors.join("\n"), /preview API at http:\/\/127\.0\.0\.1/, "the address is in the server's log");
});

test("a slow indexer is a 504", async () => {
  reply = () => {}; // never answers
  const res = await fetch(`${base}/api/preprod/tokens`);
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, "api-timeout");
});

test("configFromEnv: defaults, turning a network off, and refusals", () => {
  assert.deepEqual(configFromEnv({}), {
    host: "127.0.0.1", port: 10591, defaultNetwork: "preprod", upstreamTimeoutMs: 15000,
    apis: { mainnet: null, preview: "http://127.0.0.1:10550", preprod: "http://127.0.0.1:10540" },
  });
  const off = configFromEnv({ PREPROD_API: "", MAINNET_API: "https://indexer.example/umbra/" });
  assert.equal(off.apis.preprod, null);
  assert.equal(off.apis.mainnet, "https://indexer.example/umbra");
  assert.equal(off.defaultNetwork, "mainnet");
  assert.throws(() => configFromEnv({ PREPROD_API: "not a url" }), /PREPROD_API is not a URL/);
  assert.throws(() => configFromEnv({ PREPROD_API: "file:///etc/passwd" }), /http or https/);
  assert.throws(() => configFromEnv({ DEFAULT_NETWORK: "mainnet" }), /no API configured/);
  assert.throws(() => configFromEnv({ DEFAULT_NETWORK: "devnet" }), /must be one of/);
  assert.throws(() => configFromEnv({ PORT: "http" }), /PORT/);
});
