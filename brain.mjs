// Camada de dados do CÉREBRO — grafo em SQLite (Fase 1: arestas por tag).
// Nós = itens das 3 fontes; conceitos = tags compartilhadas. As arestas
// item↔item são derivadas em query (nós que compartilham conceito).
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(DIR, "brain.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    src_id     TEXT NOT NULL,
    url        TEXT,
    title      TEXT,
    summary    TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS node_concepts (
    node_id TEXT NOT NULL,
    label   TEXT NOT NULL,
    PRIMARY KEY (node_id, label)
  );
  CREATE INDEX IF NOT EXISTS idx_nc_label ON node_concepts(label);
  CREATE TABLE IF NOT EXISTS edges (
    src TEXT NOT NULL, dst TEXT NOT NULL, origin TEXT NOT NULL, weight REAL,
    PRIMARY KEY (src, dst, origin)
  );
`);
try { db.exec("ALTER TABLE nodes ADD COLUMN embedding BLOB"); } catch { /* já existe */ }
try { db.exec("ALTER TABLE nodes ADD COLUMN parent TEXT"); } catch { /* já existe */ }

// ── escrita (usada pelo sync) ────────────────────────────────────────────────
export function reset() {
  db.exec("DELETE FROM node_concepts; DELETE FROM nodes;");
}
const insNode = db.prepare(
  "INSERT OR REPLACE INTO nodes (id, source, src_id, url, title, summary, created_at, parent) VALUES (@id,@source,@src_id,@url,@title,@summary,@created_at,@parent)"
);
const insTag = db.prepare("INSERT OR IGNORE INTO node_concepts (node_id, label) VALUES (?,?)");
export function addNode(n, concepts = []) {
  insNode.run({ parent: null, created_at: null, url: "", summary: "", ...n });
  for (const c of concepts) insTag.run(n.id, c);
}
const setParent = db.prepare("UPDATE nodes SET parent=? WHERE id=?");
export function setNodeParent(id, parent) { setParent.run(parent, id); }

// anexa cada nó não-Notion à página Notion mais parecida (embedding). Isso põe
// latenews/refs como FOLHAS embaixo da hierarquia do Notion.
export function attachNonNotionToNotion() {
  const notion = db.prepare("SELECT id, embedding FROM nodes WHERE source='notion' AND embedding IS NOT NULL")
    .all().map((r) => ({ id: r.id, v: loadVec(r.embedding) }));
  if (!notion.length) return 0;
  const others = db.prepare("SELECT id, embedding FROM nodes WHERE source<>'notion' AND embedding IS NOT NULL").all();
  const run = db.transaction(() => {
    for (const o of others) {
      const v = loadVec(o.embedding);
      let best = null, bs = -2;
      for (const n of notion) {
        let dot = 0; for (let d = 0; d < v.length; d++) dot += v[d] * n.v[d];
        if (dot > bs) { bs = dot; best = n.id; }
      }
      if (best) setParent.run(best, o.id);
    }
  });
  run();
  return others.length;
}
export const insertMany = db.transaction((items) => {
  for (const { node, concepts } of items) addNode(node, concepts);
});

// ── embeddings + arestas semânticas (Fase 2) ─────────────────────────────────
const setEmb = db.prepare("UPDATE nodes SET embedding=? WHERE id=?");
export function storeEmbedding(id, vec) {
  setEmb.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), id);
}
function loadVec(buf) {
  // copia p/ garantir alinhamento de 4 bytes antes de virar Float32Array
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
// cosseno k-NN (vetores já normalizados → produto escalar). Reconstrói edges 'semantic'.
export function rebuildSemanticEdges({ k = 6, threshold = 0.6 } = {}) {
  db.exec("DELETE FROM edges WHERE origin='semantic'");
  const rows = db.prepare("SELECT id, embedding FROM nodes WHERE embedding IS NOT NULL").all();
  const vecs = rows.map((r) => ({ id: r.id, v: loadVec(r.embedding) }));
  const ins = db.prepare("INSERT OR REPLACE INTO edges (src, dst, origin, weight) VALUES (?,?,?,?)");
  const run = db.transaction(() => {
    for (let i = 0; i < vecs.length; i++) {
      const a = vecs[i].v, sims = [];
      for (let j = 0; j < vecs.length; j++) {
        if (i === j) continue;
        const b = vecs[j].v;
        let dot = 0;
        for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
        if (dot >= threshold) sims.push({ id: vecs[j].id, sim: dot });
      }
      sims.sort((x, y) => y.sim - x.sim);
      for (const s of sims.slice(0, k)) {
        const [src, dst] = vecs[i].id < s.id ? [vecs[i].id, s.id] : [s.id, vecs[i].id];
        ins.run(src, dst, "semantic", s.sim);
      }
    }
  });
  run();
  return db.prepare("SELECT COUNT(*) n FROM edges WHERE origin='semantic'").get().n;
}

// ── leitura (usada pelas rotas) ──────────────────────────────────────────────
// arestas item↔item: pares que compartilham conceito, peso = nº de conceitos
const linkRows = db.prepare(`
  SELECT a.node_id AS source, b.node_id AS target,
         COUNT(*) AS weight, GROUP_CONCAT(a.label) AS concepts
  FROM node_concepts a
  JOIN node_concepts b ON a.label = b.label AND a.node_id < b.node_id
  GROUP BY a.node_id, b.node_id
`);

const K_NEIGHBORS = 8;   // cap de arestas por nó no grafo (evita hairball)

export function graph() {
  const nodes = db.prepare("SELECT id, source, url, title, parent FROM nodes").all();
  // O grafo REFLETE A HIERARQUIA: arestas = pai→filho.
  // Notion forma a árvore; latenews/refs ficam como folhas (parent = página Notion mais parecida).
  const idset = new Set(nodes.map((n) => n.id));
  const links = [];
  for (const n of nodes) {
    if (n.parent && idset.has(n.parent)) links.push({ source: n.parent, target: n.id, weight: 1, origin: "hierarchy" });
  }
  const degree = {};
  for (const l of links) { degree[l.source] = (degree[l.source] || 0) + 1; degree[l.target] = (degree[l.target] || 0) + 1; }
  for (const n of nodes) n.degree = degree[n.id] || 0;
  const concepts = db.prepare(
    "SELECT label, COUNT(*) AS count FROM node_concepts GROUP BY label ORDER BY count DESC"
  ).all();
  return { nodes, links, concepts };
}

export function focus(id) {
  const node = db.prepare("SELECT id, source, src_id, url, title, summary, created_at AS createdAt FROM nodes WHERE id=?").get(id);
  if (!node) return null;
  const concepts = db.prepare("SELECT label FROM node_concepts WHERE node_id=?").all(id).map((r) => r.label);
  // vizinhos = nós que compartilham ≥1 conceito
  const rows = db.prepare(`
    SELECT n.id, n.source, n.url, n.title,
           COUNT(*) AS weight, GROUP_CONCAT(nc.label) AS shared
    FROM node_concepts me
    JOIN node_concepts nc ON nc.label = me.label AND nc.node_id <> me.node_id
    JOIN nodes n ON n.id = nc.node_id
    WHERE me.node_id = ?
    GROUP BY n.id
    ORDER BY weight DESC, n.title
  `).all(id);
  const byId = new Map();
  for (const r of rows) {
    byId.set(r.id, { id: r.id, source: r.source, url: r.url, title: r.title,
      origin: "tag", weight: r.weight, shared: r.shared ? r.shared.split(",") : [], sim: null });
  }
  // vizinhos semânticos (tabela edges)
  const sem = db.prepare(`
    SELECT CASE WHEN e.src=? THEN e.dst ELSE e.src END AS id, e.weight AS sim
    FROM edges e WHERE e.origin='semantic' AND (e.src=? OR e.dst=?)
  `).all(id, id, id);
  const getN = db.prepare("SELECT id, source, url, title FROM nodes WHERE id=?");
  for (const s of sem) {
    if (byId.has(s.id)) { const n = byId.get(s.id); n.origin = "both"; n.sim = s.sim; }
    else {
      const n = getN.get(s.id);
      if (n) byId.set(s.id, { ...n, origin: "semantic", weight: 0, shared: [], sim: s.sim });
    }
  }
  const neighbors = [...byId.values()].sort((a, b) =>
    (b.weight + (b.sim || 0)) - (a.weight + (a.sim || 0)));
  return { node, concepts, neighbors };
}

export function stats() {
  const bySource = db.prepare("SELECT source, COUNT(*) AS n FROM nodes GROUP BY source").all();
  const total = db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n;
  return { total, bySource };
}
