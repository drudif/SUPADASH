// Dash — hub/launcher dos projetos (REFS, LATEFEED, NOTION).
// Faz fetch server-side das 3 fontes, cacheia e serve a página com os cards.
// Padrão espelhado do refs-catalog/server.mjs (Node http puro, sem framework).
//
// Fontes:
// - REFS (refs-catalog): lê refs-data.js estático e conta refs.length. Não exige token.
// - LATEFEED (portal-inputs): GET /api/summary protegido por SUMMARY_TOKEN.
// - NOTION (notion-clone):    GET /api/summary protegido por SUMMARY_TOKEN.
//
// Cada card é resiliente: se uma fonte cair, as outras seguem aparecendo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as brain from "./brain.mjs";
import * as brainSync from "./sync.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// carrega .env local (se existir) — mesmo esquema do refs-catalog, sem flag do Node.
try {
  const envPath = path.join(DIR, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch { /* ignore */ }

const PORT = process.env.PORT || 4200;
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 60_000);
const SUMMARY_TOKEN = process.env.SUMMARY_TOKEN || "";
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_PAGE_ID = (process.env.NOTION_PARENT_PAGE_ID || "").replace(/-/g, "");
const NOTION_TODO_ID = (process.env.NOTION_TODO_PAGE_ID || "").replace(/-/g, "");

// ── Auth do dash ──────────────────────────────────────────────────────────────
// Se DASH_PASSWORD estiver definido, todo o dash exige login (cookie httpOnly).
// Sem DASH_PASSWORD (ex.: dev local sem PORT) o dash fica aberto.
const DASH_PASSWORD = process.env.DASH_PASSWORD || "";
const AUTH_COOKIE = "dash_auth";
const IS_PROD = !!process.env.PORT;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isAuthed = (req) => !DASH_PASSWORD || parseCookies(req)[AUTH_COOKIE] === DASH_PASSWORD;
function authCookieHeader() {
  return `${AUTH_COOKIE}=${encodeURIComponent(DASH_PASSWORD)}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${IS_PROD ? "; Secure" : ""}`;
}

function loginPage(error) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>Dash · entrar</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap');
@import url('https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap');
:root{--paper:#f4efe6;--ink:#191512;--ink-3:#8a8272;--line:#191512;--design:#e8551e;
--serif:"DM Serif Display",Georgia,serif;--sans:"Satoshi",system-ui,Arial,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);min-height:100vh;
display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:100%;max-width:360px}
h1{font-family:var(--serif);font-weight:400;font-size:72px;line-height:.86;letter-spacing:-.02em;margin-bottom:6px}
h1 .dot{color:var(--design)}
.sub{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);font-weight:700;margin-bottom:26px}
form{display:flex;flex-direction:column;gap:10px}
input{border:1.5px solid var(--line);border-radius:999px;padding:13px 20px;background:transparent;
font-family:var(--sans);font-weight:500;font-size:14px;color:var(--ink);outline:none}
input::placeholder{color:var(--ink-3);text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:700}
button{border:1.5px solid var(--line);background:var(--ink);color:var(--paper);border-radius:999px;padding:13px 20px;
font-family:var(--sans);font-weight:700;font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
button:hover{background:transparent;color:var(--ink)}
.err{color:#d61f2b;font-size:12px;font-weight:700;letter-spacing:.04em;margin-top:4px;min-height:16px}
</style></head><body><div class="box">
<h1>Dash<span class="dot">.</span></h1><div class="sub">acesso restrito</div>
<form method="POST" action="/login">
<input type="password" name="password" placeholder="senha" autofocus autocomplete="current-password"/>
<button type="submit">entrar</button>
<div class="err">${error ? "senha incorreta" : ""}</div>
</form></div></body></html>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on("end", () => resolve(b));
  });
}

// URLs públicas das fontes (sem barra no fim). Preencha no .env.
const clean = (u) => (u || "").replace(/\/+$/, "");

// ── Reverse-proxy local do LATEFEED ───────────────────────────────────────────
// O portal é privado (auth por cookie). Em iframe cross-domain o cookie de
// terceiros é frágil. Solução: o dash roda um proxy local que injeta a auth
// server-side; o iframe aponta pro proxy → navegador nunca lida com 3rd-party
// cookie e a senha nunca vai pro DOM. Só em dev (Railway expõe 1 porta só).
const PORTAL_SECRET = process.env.PORTAL_SECRET || "";
const LATEFEED_URL = clean(process.env.LATEFEED_URL);
const LATE_PROXY_PORT = Number(process.env.LATE_PROXY_PORT || Number(PORT) + 1);
const LATE_PROXY_ENABLED = !!(PORTAL_SECRET && LATEFEED_URL && !IS_PROD);
const LATE_IFRAME_URL = LATE_PROXY_ENABLED ? `http://localhost:${LATE_PROXY_PORT}` : "";

const SOURCES = {
  refs: {
    label: "REFS",
    desc: "Catálogo de referências",
    url: clean(process.env.REFS_URL),
  },
  latefeed: {
    label: "LATEFEED",
    desc: "Portal de inputs",
    url: clean(process.env.LATEFEED_URL),
    iframeUrl: LATE_IFRAME_URL,   // proxy local p/ embedar autenticado (dev)
  },
  notion: {
    label: "NOTION",
    desc: "Página IMPORT",
    // No modo API oficial, o "abrir" leva à própria página IMPORT.
    url: NOTION_TOKEN && NOTION_PAGE_ID
      ? `https://www.notion.so/${NOTION_PAGE_ID}`
      : clean(process.env.NOTION_URL),
  },
};

// ── Adapters ────────────────────────────────────────────────────────────────

// REFS: baixa o refs-data.js estático e conta os itens. Zero mudança no projeto.
async function fetchRefs({ url }) {
  const res = await fetch(`${url}/refs-data.js`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const js = await res.text();
  // extrai o objeto de "window.REFS_DATA = { ... };"
  const m = js.match(/window\.REFS_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error("formato inesperado do refs-data.js");
  const data = JSON.parse(m[1]);
  const refs = Array.isArray(data.refs) ? data.refs : [];
  const recent = [...refs]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 3)
    .map((r) => ({ title: r.title, url: r.url, createdAt: r.date || null, source: "refs" }));
  return {
    count: refs.length,
    label: "refs",
    updatedAt: data.scanDate || data.generated || null,
    recent,
  };
}

// LATEFEED / NOTION: endpoint /api/summary read-only protegido por token.
// Espera JSON: { count: number, label?: string, updatedAt?: string }
async function fetchSummary({ url }) {
  const res = await fetch(`${url}/api/summary`, {
    headers: SUMMARY_TOKEN ? { "x-summary-token": SUMMARY_TOKEN } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    count: Number(data.count ?? 0),
    label: data.label || "itens",
    updatedAt: data.updatedAt || null,
    recent: Array.isArray(data.recent) ? data.recent.slice(0, 3) : [],
  };
}

// NOTION (opção C): API oficial da página IMPORT.
// Traz: contagem + recentes (com prévia de conteúdo + subpáginas) + to-dos.
const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};
const notionUrl = (id) => `https://www.notion.so/${String(id).replace(/-/g, "")}`;
const richText = (rt) => (Array.isArray(rt) ? rt.map((s) => s.plain_text || "").join("") : "");

// blocos com texto que servem de prévia
const TEXT_BLOCKS = ["paragraph", "heading_1", "heading_2", "heading_3",
  "bulleted_list_item", "numbered_list_item", "quote", "callout", "to_do"];

// baixa (com paginação) os blocos-filhos de um bloco/página
async function notionChildren(id) {
  const out = [];
  let cursor;
  do {
    const u = new URL(`https://api.notion.com/v1/blocks/${id}/children`);
    u.searchParams.set("page_size", "100");
    if (cursor) u.searchParams.set("start_cursor", cursor);
    const res = await fetch(u, { headers: NOTION_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Notion HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

// para uma página: prévia (~160 chars) + subpáginas diretas
async function notionPageDetail(pageId) {
  try {
    const blocks = await notionChildren(pageId);
    let preview = "";
    const subpages = [];
    for (const b of blocks) {
      if (b.type === "child_page") {
        subpages.push({ title: b.child_page?.title || "(sem título)", url: notionUrl(b.id) });
      } else if (preview.length < 160 && TEXT_BLOCKS.includes(b.type)) {
        const t = richText(b[b.type]?.rich_text).trim();
        if (t) preview += (preview ? " · " : "") + t;
      }
    }
    return { preview: preview.slice(0, 160), subpages: subpages.slice(0, 6) };
  } catch {
    return { preview: "", subpages: [] };
  }
}

// to-dos da subpágina dedicada
async function notionTodos() {
  if (!NOTION_TODO_ID) return [];
  try {
    const blocks = await notionChildren(NOTION_TODO_ID);
    return blocks
      .filter((b) => b.type === "to_do")
      .map((b) => ({ id: b.id, text: richText(b.to_do?.rich_text), checked: !!b.to_do?.checked }));
  } catch {
    return [];
  }
}

// ── escrita de to-dos (o dash atua server-side; token nunca vai ao browser) ────
async function notionWrite(url, method, body) {
  const res = await fetch(url, {
    method, headers: NOTION_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Notion HTTP ${res.status}`);
  return res.json();
}
const toggleTodo = (id, checked) =>
  notionWrite(`https://api.notion.com/v1/blocks/${id}`, "PATCH", { to_do: { checked: !!checked } });
const addTodo = (text) =>
  notionWrite(`https://api.notion.com/v1/blocks/${NOTION_TODO_ID}/children`, "PATCH", {
    children: [{ object: "block", type: "to_do", to_do: { rich_text: [{ text: { content: text } }], checked: false } }],
  });
const deleteTodo = (id) =>
  notionWrite(`https://api.notion.com/v1/blocks/${id}`, "DELETE");

async function fetchNotion() {
  const top = await notionChildren(NOTION_PAGE_ID);
  // páginas de conteúdo = child_page, exceto a subpágina de to-do
  const pages = top.filter((b) => b.type === "child_page" && b.id.replace(/-/g, "") !== NOTION_TODO_ID);

  const sorted = [...pages].sort((a, b) =>
    String(b.last_edited_time).localeCompare(String(a.last_edited_time)));
  const top3 = sorted.slice(0, 3);

  // detalhes das 3 recentes + to-dos, em paralelo
  const [details, todos] = await Promise.all([
    Promise.all(top3.map((b) => notionPageDetail(b.id))),
    notionTodos(),
  ]);

  const recent = top3.map((b, i) => ({
    title: b.child_page?.title || "(sem título)",
    url: notionUrl(b.id),
    createdAt: b.last_edited_time || null,
    source: "notion",
    preview: details[i].preview,
    subpages: details[i].subpages,
  }));

  // lista completa de subpáginas diretas da IMPORT (todas), ordenadas por edição
  const allpages = sorted.map((b) => ({
    title: b.child_page?.title || "(sem título)",
    url: notionUrl(b.id),
  }));

  return {
    count: pages.length,
    label: "páginas",
    updatedAt: recent[0]?.createdAt || null,
    recent,
    allpages,
    todos,
  };
}

const ADAPTERS = {
  refs: fetchRefs,
  latefeed: fetchSummary,
  // usa a API oficial se houver token+page; senão cai no /api/summary do notion-clone.
  notion: (src) => (NOTION_TOKEN && NOTION_PAGE_ID ? fetchNotion() : fetchSummary(src)),
};

// ── Cache + agregação ────────────────────────────────────────────────────────
let cache = { at: 0, data: null };

async function collect() {
  const entries = await Promise.all(
    Object.entries(SOURCES).map(async ([key, src]) => {
      const base = { key, label: src.label, desc: src.desc, url: src.url, iframeUrl: src.iframeUrl || "" };
      if (!src.url) return { ...base, ok: false, error: "URL não configurada" };
      try {
        const stat = await ADAPTERS[key](src);
        return { ...base, ok: true, ...stat };
      } catch (e) {
        return { ...base, ok: false, error: String(e.message || e) };
      }
    })
  );
  return { cards: entries, fetchedAt: new Date().toISOString() };
}

async function getStats() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL) return cache.data;
  const data = await collect();
  cache = { at: now, data };
  return data;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    const pathname = u.pathname;

    // login: POST /login (form) e atalho ?k=<senha>
    if (req.method === "POST" && pathname === "/login") {
      const body = await readBody(req);
      const pass = new URLSearchParams(body).get("password") || "";
      if (DASH_PASSWORD && pass === DASH_PASSWORD) {
        res.writeHead(302, { "Set-Cookie": authCookieHeader(), Location: "/" });
        res.end();
      } else {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end(loginPage(true));
      }
      return;
    }
    if (DASH_PASSWORD && u.searchParams.get("k") === DASH_PASSWORD) {
      res.writeHead(302, { "Set-Cookie": authCookieHeader(), Location: pathname });
      res.end();
      return;
    }

    // gate: sem sessão válida, nada além da tela de login
    if (!isAuthed(req)) {
      if (pathname.startsWith("/api/")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":"unauthorized"}');
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(loginPage(false));
      }
      return;
    }

    // ── to-do interativo (POST) ──────────────────────────────────────────────
    if (req.method === "POST" && pathname.startsWith("/api/notion/todo/")) {
      if (!NOTION_TOKEN || !NOTION_TODO_ID) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"notion todo não configurado"}');
        return;
      }
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* ignore */ }
      const action = pathname.slice("/api/notion/todo/".length);
      try {
        if (action === "toggle") await toggleTodo(body.id, body.checked);
        else if (action === "add") {
          const t = String(body.text || "").trim();
          if (!t) throw new Error("texto vazio");
          await addTodo(t);
        } else if (action === "delete") await deleteTodo(body.id);
        else { res.writeHead(404).end('{"error":"ação inválida"}'); return; }
        cache = { at: 0, data: null };           // invalida cache p/ refletir
        const todos = await notionTodos();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ todos }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }

    // ── CÉREBRO (aba /brain) ──────────────────────────────────────────────────
    if (pathname === "/brain" || pathname === "/brain.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(DIR, "brain.html"), "utf8"));
      return;
    }
    if (pathname.startsWith("/vendor/")) {
      const f = path.join(DIR, "vendor", path.basename(pathname));   // basename evita traversal
      if (fs.existsSync(f)) {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        res.end(fs.readFileSync(f));
        return;
      }
    }
    if (pathname === "/api/brain/graph") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(brain.graph()));
      return;
    }
    if (pathname.startsWith("/api/brain/node/")) {
      const id = decodeURIComponent(pathname.slice("/api/brain/node/".length));
      const data = brain.focus(id);
      res.writeHead(data ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data || { error: "not found" }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/brain/sync") {
      try {
        const includeRefs = u.searchParams.get("refs") === "1";
        const r = await brainSync.run({ includeRefs });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }

    if (pathname === "/api/stats") {
      const data = await getStats();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e.message || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`dash em http://${HOST}:${PORT}`);
});

// ── Reverse-proxy do LATEFEED (dev) ───────────────────────────────────────────
// Encaminha tudo pro portal injetando o cookie de auth; remove headers que
// atrapalham o embed (set-cookie do portal, XFO/CSP, encoding). Assets e /api
// do portal são relativos, então funcionam via proxy sem reescrita.
if (LATE_PROXY_ENABLED) {
  const DROP_REQ = new Set(["host", "cookie", "accept-encoding", "connection", "content-length"]);
  const DROP_RES = new Set(["set-cookie", "content-encoding", "content-length",
    "transfer-encoding", "x-frame-options", "content-security-policy", "connection"]);
  const proxy = http.createServer(async (req, res) => {
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const headers = { cookie: `portal_auth=${PORTAL_SECRET}` };
      for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k)) headers[k] = v;
      const upstream = await fetch(LATEFEED_URL + req.url, {
        method: req.method,
        headers,
        body: hasBody ? req : undefined,
        duplex: hasBody ? "half" : undefined,
        redirect: "manual",
      });
      const out = {};
      upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k)) out[k] = v; });
      const loc = upstream.headers.get("location");
      if (loc) out["location"] = loc.replace(LATEFEED_URL, "");   // redirects relativos ao proxy
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, out);
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("late-proxy: " + String(e.message || e));
    }
  });
  proxy.listen(LATE_PROXY_PORT, "127.0.0.1", () => {
    console.log(`late-proxy em http://127.0.0.1:${LATE_PROXY_PORT} → ${LATEFEED_URL}`);
  });
}
