// Sync do CÉREBRO — puxa REFS + LATEFEED + NOTION, aplica a taxonomia e grava
// nós + conceitos no brain.db. Reusa o padrão dos adapters do dash.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as brain from "./brain.mjs";
import { conceptsForRefsCat, conceptsForLateSlug, conceptsForText } from "./taxonomy.mjs";

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
async function pagePreview(pageId) {
  try {
    const blocks = await notionChildren(pageId);
    let t = "";
    for (const b of blocks) {
      if (t.length > 300) break;
      if (TEXT_BLOCKS.includes(b.type)) { const s = rich(b[b.type]?.rich_text).trim(); if (s) t += " " + s; }
    }
    return t.trim();
  } catch { return ""; }
}
async function pullNotion() {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) return [];
  const top = await notionChildren(NOTION_PAGE_ID);
  const pages = top.filter((b) => b.type === "child_page" && b.id.replace(/-/g, "") !== NOTION_TODO_ID);
  const previews = await Promise.all(pages.map((p) => pagePreview(p.id)));
  return pages.map((p, i) => {
    const title = p.child_page?.title || "(sem título)";
    const preview = previews[i] || "";
    return {
      node: { id: `notion-${i}`, source: "notion", src_id: p.id, url: notionUrl(p.id),
              title, summary: preview.slice(0, 200), created_at: p.last_edited_time || null },
      concepts: conceptsForText(`${title} ${preview}`),
    };
  });
}

// ── run ──────────────────────────────────────────────────────────────────────
export async function run() {
  const t0 = Date.now();
  const results = await Promise.allSettled([pullRefs(), pullLatefeed(), pullNotion()]);
  const items = [];
  const errors = {};
  const names = ["refs", "latefeed", "notion"];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors[names[i]] = String(r.reason?.message || r.reason);
  });
  brain.reset();
  brain.insertMany(items);
  const g = brain.graph();
  return { nodes: g.nodes.length, links: g.links.length, concepts: g.concepts.length,
           bySource: brain.stats().bySource, errors, ms: Date.now() - t0 };
}

// rodar standalone: `node sync.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
       .catch((e) => { console.error(e); process.exit(1); });
}
