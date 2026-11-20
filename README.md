# Umbra token explorer

A web page that lists the tokens Midnight contracts describe with
[MIP-0018 on-chain token metadata](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0018-on-chain-token-metadata.md),
as an [UmbraDB](https://github.com/midnightntwrk/umbradb) indexer reports them, on Mainnet, Preview and Preprod.

For each token it shows the name, symbol, kind (shielded, unshielded or contract token), color, contract and the
block of its last update; a row opens to show every published field, whether the MIP considers it usable, and the
block it was written in. Tokens of one contract that publish the same symbol are shown together, as MIP-0018 asks.
You can search by contract address (optionally with a domain separator and kind) or by up to 100 colors.

Token images with a published `image_sha256` are checked twice: this server fetches the image (https only), and
serves it only when its hash matches, and the page hashes it again before showing it. An image with no published hash
is shown directly from its host and marked unverified.

## How it works

```
browser ──► this server ──► UmbraDB token-metadata API (one per network)
            │  /                    the page (public/)
            │  /api/config          which networks this server has an indexer for
            │  /api/<net>/tokens    forwarded to <NET>_API/token-metadata-api/v1/tokens
            │  /api/<net>/image     one token's image, fetched from its host and checked against its hash
            └  /healthz             liveness
```

UmbraDB's API sends no CORS headers, so the page reaches it through this same-origin forwarder. The forwarder passes
on the query string and nothing else of the visitor's request (no cookies or headers), and returns only the answer's
body, status and the headers the page reads (`content-type`, `x-umbra-height`, `x-umbra-hash`, `x-umbra-view`).

Most image hosts send no CORS headers either, so the page could not read an image's bytes to check its hash. The
image route (`src/images.mjs`) takes a token's contract, domain separator and kind, asks the indexer for that token,
and fetches the image it publishes: https on port 443 only, from public addresses only (checked when connecting, so
DNS rebinding cannot get around it), at most 3 redirects, 2 MiB and 10 seconds, and only PNG, JPEG, GIF, WebP, AVIF
or SVG. It answers with the image only when its SHA-256 matches the published one, and keeps matching images in
memory (64 MiB). An image is sent as an attachment with a sandboxing Content-Security-Policy, so an SVG opened
directly on this site runs nothing.

There are no dependencies: the server uses Node's standard library only, and the page is plain HTML, CSS and
JavaScript with no build step.

## Run it

Node.js 22 or newer.

```sh
npm start
```

Then open <http://127.0.0.1:10591>. By default the server expects a Preprod indexer at `127.0.0.1:10540` and a
Preview indexer at `127.0.0.1:10550`, and has no Mainnet indexer.

To use other indexers:

```sh
PREPROD_API=http://indexer-host:10540 MAINNET_API=https://mainnet-indexer.example npm start
```

or copy `.env.example` to `.env` and run `node --env-file=.env src/main.mjs`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the Docker image) | Address to listen on. |
| `PORT` | `10591` | Port to listen on. |
| `PREPROD_API` | `http://127.0.0.1:10540` | Preprod UmbraDB module API (its `listen.api`). Empty turns Preprod off. |
| `PREVIEW_API` | `http://127.0.0.1:10550` | Preview UmbraDB module API. Empty turns Preview off. |
| `MAINNET_API` | none | Mainnet UmbraDB module API. Unset or empty, Mainnet is off. |
| `DEFAULT_NETWORK` | `preprod` if configured, else the first configured | The network the page opens on. |
| `UPSTREAM_TIMEOUT_MS` | `15000` | How long to wait for an indexer before answering 504. |

The page disables the buttons of networks this server has no indexer for. A link can name the network to open:
`/?network=preview`. The server refuses to start on a setting that cannot work (a variable that is not an http(s)
URL, a default network with no indexer).

## Deploy

### Docker

```sh
docker build -t umbra-token-explorer-frontend .
docker run -d --name token-explorer -p 10591:10591 \
  -e PREPROD_API=http://preprod-indexer:10540 \
  -e PREVIEW_API=http://preview-indexer:10550 \
  -e MAINNET_API=http://mainnet-indexer:10560 \
  umbra-token-explorer-frontend
```

The image runs as the unprivileged `node` user, listens on `0.0.0.0:10591`, and has a `HEALTHCHECK` on `/healthz`. It
stops cleanly on `SIGTERM`.

Indexer addresses are seen from inside the container: an indexer on the Docker host is
`http://host.docker.internal:<port>` (add `--add-host=host.docker.internal:host-gateway` on Linux), or put both on
one Docker network and use the indexer's container name.

### Behind a reverse proxy

Put the server behind a proxy that terminates TLS (nginx, Caddy, a load balancer) and keep it listening on a private
address. The page uses relative paths, so it also works under a path prefix as long as the prefix ends with a slash
and the proxy strips it, for example with nginx:

```nginx
location /token-explorer/ {
    proxy_pass http://127.0.0.1:10591/;
}
```

The indexers need not be reachable from the internet: only this server calls them.

### What the server sends

Every answer carries a Content-Security-Policy that allows only the page's own script and style, images from https
and `blob:` URLs, and `fetch` to this site only, plus `nosniff`, `no-referrer` and
framing refused. The page's files are sent with an ETag and `cache-control: no-cache`; API answers with
`no-store`. When an indexer cannot be reached or times out the visitor gets a 502 or 504 that names the network but
not the indexer's address; the address goes to the server's log.

### Privacy

An image with a published hash is fetched by this server, so its host sees the server's address, not the visitor's.
An image with no published hash is loaded by the visitor's browser from the host the token's publisher chose, with no
referrer, and that host sees the visitor's IP address. Images over `http:` or other schemes are never fetched.

## Develop

```sh
npm test        # the server's tests (Node's test runner, a stand-in indexer)
npm run check   # syntax check of the server and the page's script
```

The page is `public/index.html`, `public/styles.css` and `public/app.js`; the server is `src/server.mjs`, started by
`src/main.mjs`, with the image route in `src/images.mjs`. Edit and reload: the server reads the page's files when it starts, so restart it after a change.

## Links

- Run your own token indexer: [UmbraDB](https://github.com/midnightntwrk/umbradb)
- Add metadata to your token: [MIP-0018](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0018-on-chain-token-metadata.md),
  [examples and tools](https://github.com/midnight-experiments/mip-0018)

## License

[Apache-2.0](LICENSE)
