// Token images, fetched by this server instead of the visitor's browser: most image hosts send no CORS headers, so the
// page cannot read an image's bytes to check its SHA-256 itself. Only an image the indexer says a token published, and
// only when its bytes match the published hash, is served. Untrusted URLs (they come from the chain) are fetched over
// https on port 443 only, from public addresses only, checked at connect time so DNS rebinding cannot get around it.
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { createHash } from "node:crypto";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const CACHE_BYTES = 64 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"]);

/** Every address that is not on the public internet. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) BLOCKED.addSubnet(net, prefix, "ipv4");
// No ::ffff:0:0/96: BlockList checks IPv4-mapped addresses against the IPv4 rules, and that rule would match every IPv4.
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) BLOCKED.addSubnet(net, prefix, "ipv6");

export const blocked = (address) => BLOCKED.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

/** A `lookup` for https.request that refuses a name if any of its addresses is not public, and connects to the one checked. */
function publicLookup(hostname, options, callback) {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const refused = addresses.find((a) => blocked(a.address));
    if (refused || addresses.length === 0) return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "ENOTPUBLIC" }));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

class ImageError extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}

/** GETs `url` (https, port 443, public addresses), following up to MAX_REDIRECTS; resolves { bytes, type }. */
function fetchImage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || (target.port !== "" && target.port !== "443") || target.username || target.password) {
      return reject(new ImageError(422, "image-url-refused", "only https URLs on port 443 are fetched"));
    }
    if (isIP(target.hostname.replace(/^\[|\]$/g, "")) && blocked(target.hostname.replace(/^\[|\]$/g, ""))) {
      return reject(new ImageError(422, "image-url-refused", "the image's host is not a public address"));
    }
    const req = httpsRequest(target, {
      method: "GET",
      lookup: publicLookup,
      headers: { accept: [...TYPES].join(", "), "user-agent": "umbra-token-explorer (image check)" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new ImageError(502, "image-fetch-failed", "too many redirects"));
        return resolve(fetchImage(new URL(res.headers.location, target).href, redirects + 1));
      }
      if (status !== 200) { res.resume(); return reject(new ImageError(502, "image-fetch-failed", `the image's host answered HTTP ${status}`)); }
      const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (!TYPES.has(type)) { res.resume(); return reject(new ImageError(502, "image-fetch-failed", `not an image type this page shows: ${type || "none"}`)); }
      if (Number(res.headers["content-length"] ?? 0) > MAX_BYTES) { res.destroy(); return reject(new ImageError(502, "image-too-large", "the image is too large")); }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(); reject(new ImageError(502, "image-too-large", "the image is too large")); }
        else chunks.push(chunk);
      });
      res.on("end", () => resolve({ bytes: Buffer.concat(chunks), type }));
      res.on("error", reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new ImageError(504, "image-timeout", "the image's host did not answer in time")));
    req.on("error", (error) => reject(error instanceof ImageError ? error
      : new ImageError(error.code === "ENOTPUBLIC" ? 422 : 502, error.code === "ENOTPUBLIC" ? "image-url-refused" : "image-fetch-failed",
        error.code === "ENOTPUBLIC" ? "the image's host is not a public address" : "the image could not be fetched")));
    req.end();
  });
}

/**
 * The image route: `handle(res, network, search)` answers GET /api/<network>/image?contract=…&domainSep=…&kind=…
 * `readToken(network, search)` resolves the indexer's answer for that one-token selector (its first item, or null).
 */
export function createImageRoute({ readToken, log = console }) {
  const cache = new Map(); // published hash → { bytes, type }, oldest first
  let cached = 0;
  const inFlight = new Map(); // published hash → Promise<{ bytes, type }>

  function remember(hash, image) {
    if (image.bytes.length > CACHE_BYTES / 8) return;
    cache.set(hash, image);
    cached += image.bytes.length;
    for (const [key, old] of cache) {
      if (cached <= CACHE_BYTES) break;
      cache.delete(key);
      cached -= old.bytes.length;
    }
  }

  async function verified(url, hash) {
    if (cache.has(hash)) return cache.get(hash);
    if (!inFlight.has(hash)) {
      inFlight.set(hash, fetchImage(url).then((image) => {
        const digest = `0x${createHash("sha256").update(image.bytes).digest("hex")}`;
        if (digest !== hash) throw new ImageError(422, "hash-mismatch", "the image's SHA-256 differs from the published one", { digest });
        remember(hash, image);
        return image;
      }).finally(() => inFlight.delete(hash)));
    }
    return inFlight.get(hash);
  }

  return async function handle(res, network, search, send) {
    const params = new URLSearchParams(search);
    if (![...params.keys()].every((k) => ["contract", "domainSep", "kind"].includes(k)) || !params.get("kind")) {
      return send.error(res, 400, "bad-request", "name one token: contract, domainSep and kind");
    }
    try {
      const token = await readToken(network, `?${params}`);
      const { image, imageSha256 } = token?.common ?? {};
      if (!image || !imageSha256) return send.error(res, 404, "no-image", "this token publishes no image with a usable SHA-256");
      const { bytes, type } = await verified(image, imageSha256);
      res.writeHead(200, {
        ...send.securityHeaders,
        // A publisher's SVG is theirs: opened directly on this site, it must run nothing.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "content-disposition": "attachment",
        "content-type": type,
        "content-length": bytes.length,
        "cache-control": "public, max-age=86400, immutable",
        "x-image-sha256": imageSha256,
      });
      res.end(bytes);
    } catch (error) {
      if (!(error instanceof ImageError)) {
        log.error(`${network} image: ${error.message}`);
        return send.error(res, 502, "image-fetch-failed", "the image could not be fetched");
      }
      send.json(res, error.status, { error: { code: error.code, message: error.message, ...error.extra } });
    }
  };
}
