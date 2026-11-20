"use strict";
const KIND = { 1: ["Shielded", "k1"], 2: ["Unshielded", "k2"], 3: ["Contract token", "k3"] };
const COLUMNS = 6;
/** The block explorer of each network. */
const explorer = () => (network === "mainnet" ? "https://midnightexplorer.com" : `https://${network}.midnightexplorer.com`);
let network = "preprod";

/** Builds an element; strings become text nodes, never HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}
const short = (hex) => (hex ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : "");
const group3 = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const kindTag = (kind) => el("span", { class: `tag ${KIND[kind][1]}` }, KIND[kind][0]);
const copy = (text) => el("button", { class: "copy", type: "button", onclick: (e) => { e.stopPropagation(); navigator.clipboard?.writeText(text); } }, "copy");

/* ---------- API ---------- */

/**
 * One GET of the route through the local forwarder, the selector as query parameters (a list of colors as one
 * comma-separated value); gives the answer and shows the block it was read at.
 */
async function getTokens(selector) {
  const query = new URLSearchParams(Object.entries(selector).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]));
  const res = await fetch(`/api/${network}/tokens?${query}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ? `${json.error.code}: ${json.error.message}` : `HTTP ${res.status}`);
  showBlock(res.headers.get("x-umbra-height"), res.headers.get("x-umbra-hash"), res.headers.get("x-umbra-view"));
  return json;
}
/** Every described token of a contract, following the route's pages. */
async function contractTokens(address) {
  return allPages({ contract: address });
}
/** Every described token the API knows (no selector), page by page until `nextCursor` is null. */
async function everyToken() {
  return allPages({});
}
/** The most tokens one page of the API holds (it refuses a larger limit); the default page holds 20. */
const PAGE_LIMIT = 100;
/** Every page of one selector, the largest page each time, until `nextCursor` is null. */
async function allPages(selector) {
  const items = [];
  let cursor;
  do {
    const page = await getTokens({ ...selector, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
let highest = -1n;
function showBlock(height, hash, view) {
  if (!height || BigInt(height) < highest) return;
  highest = BigInt(height);
  document.getElementById("status").replaceChildren(`${view ?? "finalized"} block `, el("b", {}, group3(height)));
}

/* ---------- Values ---------- */

/** A domain separator as text when it is printable UTF-8 (zero padding removed), else null. */
function domainText(hex) {
  const bytes = hex.slice(2).match(/../g).map((b) => parseInt(b, 16));
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return text && !/[\p{Cc}\p{Cf}]/u.test(text) ? text : null;
  } catch { return null; }
}
function fieldValue(f) {
  if (f.value.integer !== undefined) return el("span", {}, f.value.integer);
  if (f.value.text !== undefined) return el("bdi", {}, f.value.text);
  return el("span", { class: "mono" }, f.value.hex);
}
function lastUpdate(t) {
  return t.fields.reduce((m, f) => (BigInt(f.updatedAt.height) > m ? BigInt(f.updatedAt.height) : m), 0n);
}

/** The image is the client's to check: fetch it (https only), hash it, and show it only when the hash matches. */
/** Puts an image in a row's image cell; the table shows its image column once any image has loaded. */
function showImage(avatar, src, onError) {
  const img = el("img", { src, alt: "", referrerpolicy: "no-referrer" });
  img.addEventListener("load", () => avatar.closest("table.tokens")?.classList.remove("noimg"));
  if (onError) img.addEventListener("error", onError);
  avatar.replaceChildren(img);
}

async function checkImage(common, avatar, line, token) {
  const uri = common.image;
  if (!uri) return;
  const say = (cls, text) => line.replaceChildren(el("span", { class: `tag ${cls}` }, text));
  let url;
  try { url = new URL(uri); } catch { return say("bad", "not a URL this page can fetch"); }
  if (url.protocol !== "https:") return say("warn", `${url.protocol} not fetched by this page`);
  if (!common.imageSha256) {
    // MIP-0018: without a usable image_sha256 the content cannot be checked, and it may be shown; this page marks it.
    // An <img> runs no script, even for an SVG.
    const published = token?.fields.some((f) => f.key.utf8 === "image_sha256");
    showImage(avatar, url.href, () => { avatar.replaceChildren(); say("bad", "could not load: not shown"); });
    return say("warn", published ? "published SHA-256 is not usable: shown unverified" : "no SHA-256 published: shown unverified");
  }
  say("plain", "fetching…");
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) return say("bad", `fetch failed: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (`0x${digest}` !== common.imageSha256) {
      say("bad", "SHA-256 differs: not shown");
      line.append(el("br"), el("span", { class: "mono muted hash" }, `file      0x${digest.slice(0, 8)}…${digest.slice(-4)}`),
        el("br"), el("span", { class: "mono muted hash" }, `published ${short(common.imageSha256)}`));
      return;
    }
    showImage(avatar, URL.createObjectURL(new Blob([bytes], { type: res.headers.get("content-type") ?? "" })));
    avatar.title = "SHA-256 matches the published hash";
    say("ok", "SHA-256 matches: shown");
  } catch (error) {
    say("bad", `could not fetch: not shown`);
    line.title = error.message;
  }
}

/* ---------- Group explanation (the question mark) ---------- */

const pop = document.getElementById("pop");
let popOwner = null;
function groupNote(t) {
  const g = t.group;
  const ownDomain = t.domainSep;
  const sameDomain = g.members.every((m) => m.domainSep === ownDomain);
  const symbol = g.symbol.utf8 ?? g.symbol.hex;
  return [
    el("h4", {}, `Why ${g.memberCount} tokens are grouped`),
    el("p", {}, "They come from the same contract and publish the same symbol, ", el("span", { class: "tag symbol" }, el("bdi", {}, symbol)),
      ". MIP-0018 asks indexers to group them so a wallet can show them together: one contract can represent an asset in several kinds, or under several domain separators."),
    el("p", {}, sameDomain
      ? "Here they share one domain separator: one token described in several kinds."
      : "Here they have different domain separators: separate tokens of this contract that publish the same symbol."),
    el("ul", {}, g.members.map((m) => {
      const d = domainText(m.domainSep);
      return el("li", {}, kindTag(m.kind), sameDomain ? null : el("span", { class: "mono" }, d ?? short(m.domainSep)),
        null);
    })),
    g.memberCount > g.members.length ? el("p", { class: "foot" }, `${g.members.length} of ${g.memberCount} listed.`) : null,
    el("p", { class: "foot" }, "Grouping is for display only: each token keeps its own fields, and being grouped does not prove they are interchangeable. A group never spans contracts, so another contract cannot join it by copying the symbol. UmbraDB compares the symbol's first 12 characters, byte for byte."),
  ];
}
function openPop(button, t) {
  popOwner?.setAttribute("aria-expanded", "false");
  popOwner = button;
  button.setAttribute("aria-expanded", "true");
  pop.replaceChildren(...groupNote(t).filter(Boolean));
  pop.classList.add("open");
  const r = button.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
  const top = r.bottom + 8 + h > innerHeight ? r.top - h - 8 : r.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}
function closePop() {
  popOwner?.setAttribute("aria-expanded", "false");
  popOwner = null;
  pop.classList.remove("open");
}
function helpButton(t) {
  let pinned = false;
  const b = el("button", { class: "help", type: "button", "aria-label": "Why these tokens are grouped", "aria-expanded": "false" }, "?");
  b.addEventListener("mouseenter", () => openPop(b, t));
  b.addEventListener("mouseleave", () => { if (!pinned) closePop(); });
  b.addEventListener("focus", () => openPop(b, t));
  b.addEventListener("blur", () => { pinned = false; closePop(); });
  b.addEventListener("click", (e) => { e.stopPropagation(); pinned = !pinned; pinned ? openPop(b, t) : closePop(); });
  return b;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
addEventListener("scroll", closePop, { passive: true });

/* ---------- Rows: one per symbol group ---------- */

/** A link that opens in a new tab and does not open or close the row it sits in. */
function outLink(href, text, attrs = {}) {
  return el("a", { href, target: "_blank", rel: "noopener noreferrer", ...attrs, onclick: (e) => e.stopPropagation() }, text);
}
const contractLink = (address) => outLink(`${explorer()}/contracts/${address}`, short(address), { class: "mono", title: address });
const blockLink = (height) => outLink(`${explorer()}/blocks/${height}`, group3(String(height)), { class: "num" });

/**
 * The API's tokens as rows: tokens of one contract in one symbol group (the API's `group`) share a row; a token with no
 * group has its own. A group never spans contracts, so the key is the contract and the group's symbol bytes.
 */
function groupsOf(tokens) {
  const groups = new Map();
  for (const t of tokens) {
    const key = t.group ? `${t.contractAddress}/g/${t.group.symbol.hex}` : `${t.contractAddress}/t/${t.domainSep}/${t.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const symbolOf = (members) => members[0].common.symbol;
  return [...groups.values()]
    .map((members) => members.sort((x, y) => (x.domainSep < y.domainSep ? -1 : x.domainSep > y.domainSep ? 1 : x.kind - y.kind)))
    .sort((x, y) => {
      const a = symbolOf(x), b = symbolOf(y);
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
      return a.localeCompare(b) || (x[0].contractAddress < y[0].contractAddress ? -1 : 1);
    });
}

/** One member token in the expanded row: its kind, its identity and its fields. */
function memberDetail(t, imageLine) {
  const c = t.common;
  const domain = domainText(t.domainSep);
  const unit = c.decimals !== null && BigInt(c.decimals) <= 30n ? `1 ${c.symbol ?? "token"} = ${group3((10n ** BigInt(c.decimals)).toString())} base units` : null;
  /** Extra text after a field's value: the decimals example, the image check. */
  const after = (f) => (f.key.utf8 === "decimals" && f.usable && unit ? el("div", { class: "muted small" }, unit)
    : f.key.utf8 === "image" && imageLine ? el("div", {}, imageLine) : null);
  return el("div", { class: "member" },
    el("div", { class: "memberhead" }, kindTag(t.kind), c.name ? el("bdi", { class: "membername" }, c.name) : el("span", { class: "muted" }, "no name")),
    el("div", { class: "detailstack" },
      el("table", { class: "fields ident" },
        el("thead", {}, el("tr", {}, el("th", { class: "f-key" }, "Identity"), el("th", {}, "Value"))),
        el("tbody", {},
          el("tr", {}, el("td", { class: "f-key" }, "Contract"), el("td", {}, outLink(`${explorer()}/contracts/${t.contractAddress}`, t.contractAddress, { class: "mono" }))),
          el("tr", {}, el("td", { class: "f-key" }, "Domain"), el("td", {}, domain ? [el("bdi", {}, domain), el("br")] : null, el("span", { class: "mono muted" }, t.domainSep))),
          el("tr", {}, el("td", { class: "f-key" }, "Color"), el("td", {}, t.color ? [el("span", { class: "mono" }, t.color), copy(t.color)] : el("span", { class: "muted" }, "none"))))),
      el("table", { class: "fields" },
        el("thead", {}, el("tr", {}, el("th", { class: "f-key" }, "Key"), el("th", {}, "Value"), el("th", { class: "f-fit" }, "Usable"), el("th", { class: "f-fit" }, "Block"))),
        el("tbody", {}, t.fields.map((f) => el("tr", {},
          el("td", { class: `f-key${f.usable === false ? " dead" : ""}` }, f.key.utf8 ?? f.key.hex),
          el("td", { title: f.valTypeName }, el("span", { class: f.usable === false ? "dead" : "" }, fieldValue(f)), after(f)),
          el("td", { class: "f-fit" }, f.usable === true ? el("span", { class: "tag ok" }, "yes") : f.usable === false ? el("span", { class: "tag bad", title: "Published, but fails the MIP's rule for this key" }, "no") : el("span", { class: "muted" }, "—")),
          el("td", { class: "f-fit" }, blockLink(f.updatedAt.height))))))));
}

/** Copies text: the Clipboard API, else a hidden text area and the copy command. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = el("textarea", { readonly: "", style: "position:fixed;opacity:0;top:0;left:0" });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  area.remove();
  return ok;
}

/** A color as its first and last characters; a click copies the whole color. */
function colorChip(color) {
  const text = `${color.slice(0, 6)}…${color.slice(-4)}`;
  const b = el("button", { class: "colorchip mono", type: "button", title: `${color}\nClick to copy` }, text);
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.textContent = (await copyText(color)) ? "copied" : "copy failed";
    setTimeout(() => { b.textContent = text; }, 1200);
  });
  return b;
}

/** A symbol group's row: image, symbol, name, contract, last update; it opens to show each member token. */
function groupRows(members) {
  const first = members[0];
  const symbol = first.common.symbol;
  const names = [...new Set(members.map((t) => t.common.name).filter((n) => n !== null))];
  const withImage = members.find((t) => t.common.image);
  const avatar = el("div", { class: "avatar" }); // empty unless a published image's hash checks out
  const imageLine = withImage ? el("span") : null;
  const updated = members.reduce((m, t) => (lastUpdate(t) > m ? lastUpdate(t) : m), 0n);

  const row = el("tr", { class: "token", "aria-expanded": "false", tabindex: "0" },
    el("td", { class: "chev" }, el("span", {}, "›")),
    el("td", { class: "c-token" }, el("div", { class: "coin" }, avatar,
      // Name in bold, then the symbol in grey: as a wallet or market list shows a coin
      names.length ? el("bdi", { class: "name", title: names.join("\n") }, names[0]) : null,
      symbol !== null ? el("bdi", { class: names.length ? "sym" : "name", title: symbol }, symbol) : null,
      !names.length && symbol === null ? el("span", { class: "name none" }, "no name or symbol") : null,
      names.length > 1 ? el("span", { class: "muted small", title: names.join("\n") }, `+${names.length - 1} name${names.length > 2 ? "s" : ""}`) : null)),
    el("td", { class: "c-kind" }, groupTag(members)),
    el("td", { class: "c-color", "data-label": "Color" }, colorCell(members)),
    el("td", { class: "c-contract", "data-label": "Contract" }, contractLink(first.contractAddress)),
    el("td", { class: "c-updated", "data-label": "Updated" }, blockLink(updated)),
  );
  const detail = el("tr", { class: "detail", hidden: "" }, el("td", { colspan: COLUMNS },
    el("div", { class: "detailwrap" }, members.map((t) => memberDetail(t, t === withImage ? imageLine : null)))));
  const toggle = () => {
    const open = row.getAttribute("aria-expanded") !== "true";
    row.setAttribute("aria-expanded", String(open));
    detail.hidden = !open;
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } });
  if (withImage) checkImage(withImage.common, avatar, imageLine, withImage);
  return [row, detail];
}

/** A row's color (kinds 1 and 2 have one; a contract token has none); its tokens' own colors are in the details. */
function colorCell(members) {
  const colors = [...new Set(members.map((t) => t.color).filter((c) => c !== null))];
  if (!colors.length) return el("span", { class: "muted" }, "—");
  if (colors.length > 1) return el("span", { class: "muted small", title: "Each token's color is in the row's details" }, "(multiple colors)");
  return colorChip(colors[0]);
}

/**
 * A row's kind, or its group's size: the API's group counts every member, while a page may hold only some of them
 * (the rest are on another page).
 */
function groupTag(members) {
  const first = members[0];
  const total = first.group?.memberCount ?? 1;
  if (total <= 1) return kindTag(first.kind);
  const label = members.length < total ? `${members.length} of ${total} tokens` : `${total} tokens`;
  return el("span", { class: "kindcell" }, el("span", { class: "tag group", title: members.length < total ? "The other tokens of this group are on another page" : null }, label), helpButton(first));
}

/** A message in place of the table's rows. */
const messageRow = (text, cls = "empty") => el("tr", {}, el("td", { colspan: COLUMNS, class: cls }, text));

function tokenTable(rows) {
  return el("table", { class: "tokens noimg" },
    el("thead", {}, el("tr", {},
      el("th", { class: "chev" }), el("th", { class: "c-token" }, "Token"),
      el("th", { class: "c-kind" }, "Kind"), el("th", { class: "c-color" }, "Color"), el("th", { class: "c-contract" }, "Contract"), el("th", { class: "c-updated" }, "Last updated"))),
    el("tbody", {}, rows));
}

/* ---------- Loading ---------- */

/** Paging of the list of every token: the page size, and the cursor that opens each page seen so far. */
const paging = { size: 20, cursors: [null], index: 0, next: null };
/**
 * The API selector the table shows: {} (every token), { contract }, { contract, domainSep[, kind] } or { colors }.
 * The API pages the first two; the others answer in one go.
 */
let filter = {};
const pageable = () => !filter.domainSep && !filter.colors;

function resetPaging() {
  paging.cursors = [null];
  paging.index = 0;
  paging.next = null;
}

/** The pager under the table: page size, previous, page number, next. */
function pager() {
  const size = el("select", { "aria-label": "Tokens per page" }, [2, 20, 100].map((n) => el("option", { value: n, selected: n === paging.size ? "" : null }, n)));
  size.addEventListener("change", () => { paging.size = Number(size.value); resetPaging(); loadKnown(); });
  const prev = el("button", { class: "btn", type: "button", disabled: paging.index === 0 ? "" : null }, "‹ Previous");
  prev.addEventListener("click", () => { paging.index -= 1; loadKnown(); });
  const next = el("button", { class: "btn", type: "button", disabled: paging.next ? null : "" }, "Next ›");
  next.addEventListener("click", () => {
    paging.cursors[paging.index + 1] = paging.next;
    paging.index += 1;
    loadKnown();
  });
  return el("div", { class: "pager" },
    el("label", { class: "muted small" }, "Per page ", size),
    el("div", { class: "pagenav" }, prev, el("span", { class: "pageno" }, `Page ${paging.index + 1}`), next));
}

/** The tokens the current filter selects: a page of them when the API pages that selector. */
async function loadKnown() {
  highest = -1n;
  closePop();
  const box = document.getElementById("known");
  box.replaceChildren(tokenTable(messageRow("Loading…")));
  const empty = Object.keys(filter).length ? "No described token matches this filter." : "No described tokens.";
  try {
    let items;
    if (pageable()) {
      const cursor = paging.cursors[paging.index];
      const page = await getTokens({ ...filter, limit: paging.size, ...(cursor ? { cursor } : {}) });
      paging.next = page.nextCursor;
      items = page.items;
    } else {
      items = (await getTokens(filter)).items;
    }
    const rows = groupsOf(items).flatMap(groupRows);
    box.replaceChildren(tokenTable(rows.length ? rows : [messageRow(empty)]), pageable() ? pager() : "");
  } catch (error) {
    document.getElementById("status").textContent = "";
    box.replaceChildren(tokenTable(messageRow(error.message, "error")), pageable() ? pager() : "");
  }
}

/* ---------- Filter: the API's selectors ---------- */

const form = document.getElementById("filter");
const $ = (id) => document.getElementById(id);
let mode = "contract";

/** 32 bytes as `0x` and 64 lowercase hex digits (the 0x is optional when typing), else null. */
function hex32(text) {
  const hex = text.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : null;
}
/** A domain separator: 32 bytes of hex, or text of at most 32 UTF-8 bytes padded with zeros (as contracts write it). */
function domainSepOf(text) {
  const asHex = hex32(text);
  if (asHex) return asHex;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) return null;
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return `0x${[...padded].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function showFilterError(text) {
  form.querySelector(".ferror")?.remove();
  if (text) form.append(el("div", { class: "ferror", role: "alert" }, text));
}

/** The selector the form describes, or an error to show. */
function readFilter() {
  if (mode === "colors") {
    const parts = $("f-colors").value.split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return { error: "Give at least one color." };
    if (parts.length > 100) return { error: "At most 100 colors." };
    const colors = parts.map(hex32);
    const bad = parts.find((_, i) => !colors[i]);
    if (bad) return { error: `Not a color (64 hex digits): ${bad}` };
    return { selector: { colors: [...new Set(colors)] } };
  }
  const contractText = $("f-contract").value;
  const domainText = $("f-domain").value;
  if (!contractText.trim()) return domainText.trim() ? { error: "A domain separator needs a contract address." } : { selector: {} };
  const contract = hex32(contractText);
  if (!contract) return { error: "The contract address is 32 bytes: 64 hex digits, with or without 0x." };
  if (!domainText.length) return { selector: { contract } };
  const domainSep = domainSepOf(domainText);
  if (!domainSep) return { error: "The domain separator is 32 bytes: text of at most 32 bytes, or 64 hex digits." };
  const kind = $("f-kind").value;
  return { selector: kind ? { contract, domainSep, kind: Number(kind) } : { contract, domainSep } };
}

function setMode(next) {
  mode = next;
  form.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === next)));
  form.querySelectorAll(".fgroup").forEach((g) => { g.hidden = g.dataset.for !== next; });
  showFilterError("");
}
form.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
// The API takes a kind only with a domain separator.
$("f-domain").addEventListener("input", () => {
  $("f-kind").disabled = !$("f-domain").value.length;
  if ($("f-kind").disabled) $("f-kind").value = "";
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const read = readFilter();
  showFilterError(read.error);
  if (read.error) return;
  filter = read.selector;
  resetPaging();
  loadKnown();
});
function clearFilter() {
  form.reset();
  $("f-kind").disabled = true;
  setMode("contract");
  filter = {};
  resetPaging();
}
function showSearch(open) {
  form.hidden = !open;
  $("open-search").hidden = open;
  $("open-search").setAttribute("aria-expanded", String(open));
  if (open) $(mode === "colors" ? "f-colors" : "f-contract").focus();
}
$("open-search").addEventListener("click", () => showSearch(true));
$("f-clear").addEventListener("click", () => {
  const wasFiltered = Object.keys(filter).length > 0;
  clearFilter();
  showSearch(false);
  if (wasFiltered) loadKnown();
});

document.querySelectorAll("header .seg button").forEach((b) => b.addEventListener("click", () => {
  network = b.dataset.net;
  document.querySelectorAll("header .seg button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
  document.getElementById("status").textContent = "connecting…";
  clearFilter();
  showSearch(false);
  loadKnown();
}));

const footer = document.getElementById("footer");
new ResizeObserver(() => { document.body.style.paddingBottom = `${footer.offsetHeight}px`; }).observe(footer);
loadKnown();
