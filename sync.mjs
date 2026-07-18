// Sync do CÉREBRO — puxa REFS + LATEFEED + NOTION, aplica a taxonomia e grava
// nós + conceitos no brain.db. Reusa o padrão dos adapters do dash.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as brain from "./brain.mjs";
import { conceptsForRefsCat, conceptsForLateSlug, conceptsForText } from "./taxonomy.mjs";
import { embedMany, ollamaReady } from "./embed.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// carrega .env se rodar standalone (quando importado pelo server, já está carregado)
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

const clean = (u) => (u || "").replace(/\/+$/, "");
const REFS_URL = clean(process.env.REFS_URL);
const LATEFEED_URL = clean(process.env.LATEFEED_URL);
const PORTAL_SECRET = process.env.PORTAL_SECRET || "";
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_PAGE_ID = (process.env.NOTION_PARENT_PAGE_ID || "").replace(/-/g, "");
const NOTION_TODO_ID = (process.env.NOTION_TODO_PAGE_ID || "").replace(/-/g, "");

// une conceitos por categoria + por keyword no texto
const uniq = (a) => [...new Set(a)];
const tagsFor = (byCat, text) => uniq([...byCat, ...conceptsForText(text)]);

// ── REFS ─────────────────────────────────────────────────────────────────────
async function pullRefs() {
  const res = await fetch(`${REFS_URL}/refs-data.js`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`REFS HTTP ${res.status}`);
  const m = (await res.text()).match(/window\.REFS_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error("refs-data.js formato inesperado");
  const refs = JSON.parse(m[1]).refs || [];
  return refs.map((r, i) => ({
    node: { id: `refs-${i}`, source: "refs", src_id: r.url || r.title, url: r.url || "",
            title: r.title || "(sem título)", summary: r.desc || "", created_at: r.date || null },
    concepts: tagsFor(conceptsForRefsCat(r.cat), `${r.title} ${r.desc}`),
  }));
}

// ── LATEFEED ─────────────────────────────────────────────────────────────────
async function pullLatefeed() {
  if (!LATEFEED_URL || !PORTAL_SECRET) return [];
  const res = await fetch(`${LATEFEED_URL}/api/feed`, {
    headers: { cookie: `portal_auth=${PORTAL_SECRET}` }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`LATEFEED HTTP ${res.status}`);
  const data = await res.json();
  const items = data.items || data.inputs || (Array.isArray(data) ? data : []);
  return items.map((it, i) => ({
    node: { id: `latefeed-${i}`, source: "latefeed", src_id: it.id || String(i), url: `${LATEFEED_URL}/`,
            title: it.title || "(sem título)", summary: it.shortSummary || it.summary || "", created_at: it.createdAt || null },
    concepts: tagsFor(conceptsForLateSlug(it.categorySlug), `${it.title} ${it.shortSummary || it.summary || ""}`),
  }));
}

// ── NOTION ───────────────────────────────────────────────────────────────────
const notionUrl = (id) => `https://www.notion.so/${String(id).replace(/-/g, "")}`;
const rich = (rt) => (Array.isArray(rt) ? rt.map((s) => s.plain_text || "").join("") : "");
const NHEAD = { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const TEXT_BLOCKS = ["paragraph","heading_1","heading_2","heading_3","bulleted_list_item","numbered_list_item","quote","callout","to_do"];

async function notionChildren(id) {
  const out = []; let cursor;
  do {
    const u = new URL(`https://api.notion.com/v1/blocks/${id}/children`);
    u.searchParams.set("page_size", "100");
    if (cursor) u.searchParams.set("start_cursor", cursor);
    const res = await fetch(u, { headers: NHEAD, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`NOTION HTTP ${res.status}`);
    const d = await res.json();
    out.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}
// Notion RECURSIVO: pega TODAS as subpáginas em qualquer profundidade sob a IMPORT.
// Uma chamada por página já traz o texto (prévia) + os child_page (p/ recorrer).
async function pullNotion() {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) return [];
  const out = [];
  const seen = new Set([NOTION_TODO_ID]);   // exclui a subpágina de To-do
  let idx = 0;

  async function walk(pageId, title, parentNodeId, depth) {
    let blocks;
    try { blocks = await notionChildren(pageId); } catch { return; }
    let preview = "";
    const subs = [];
    for (const b of blocks) {
      if (b.type === "child_page") subs.push(b);
      else if (preview.length < 400 && TEXT_BLOCKS.includes(b.type)) {
        const s = rich(b[b.type]?.rich_text).trim();
        if (s) preview += " " + s;
      }
    }
    const myId = `notion-${idx++}`;   // a IMPORT vira a raiz da árvore
    out.push({
      node: { id: myId, source: "notion", src_id: pageId, url: notionUrl(pageId),
              title: title || "IMPORT", summary: preview.trim().slice(0, 240), created_at: null, parent: parentNodeId },
      concepts: conceptsForText(`${title} ${preview}`),
    });
    if (depth < 6) {
      for (const p of subs) {
        const clean = p.id.replace(/-/g, "");
        if (seen.has(clean)) continue;
        seen.add(clean);
        await walk(p.id, p.child_page?.title || "(sem título)", myId, depth + 1);
      }
    }
  }

  await walk(NOTION_PAGE_ID, "IMPORT", null, 0);
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────
// Prioridade: NOTION (todas as subpáginas) + LATENEWS sempre; REFS só sob demanda.
export async function run({ includeRefs = false } = {}) {
  const t0 = Date.now();
  const jobs = [["notion", pullNotion()], ["latefeed", pullLatefeed()]];
  if (includeRefs) jobs.push(["refs", pullRefs()]);
  const results = await Promise.allSettled(jobs.map((j) => j[1]));
  const items = [];
  const errors = {};
  results.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === "fulfilled") items.push(...r.value);
    else errors[name] = String(r.reason?.message || r.reason);
  });
  brain.reset();
  brain.insertMany(items);

  // Fase 2: embeddings locais → arestas semânticas
  let semantic = 0, embErr = null;
  if (await ollamaReady()) {
    try {
      const texts = items.map((it) => `${it.node.title}. ${it.node.summary || ""}`);
      const vecs = await embedMany(texts, 6);
      for (let i = 0; i < items.length; i++) if (vecs[i]) brain.storeEmbedding(items[i].node.id, vecs[i]);
      semantic = brain.rebuildSemanticEdges({ k: 6, threshold: 0.6 });
      brain.attachNonNotionToNotion();   // latenews/refs viram folhas sob a página Notion mais parecida
    } catch (e) { embErr = String(e.message || e); }
  } else {
    embErr = "ollama/nomic-embed-text indisponível — só arestas por tag";
  }

  const g = brain.graph();
  return { nodes: g.nodes.length, links: g.links.length, concepts: g.concepts.length,
           semantic, embErr, bySource: brain.stats().bySource, errors, ms: Date.now() - t0 };
}

// rodar standalone: `node sync.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
       .catch((e) => { console.error(e); process.exit(1); });
}
