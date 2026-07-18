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
`);

// ── escrita (usada pelo sync) ────────────────────────────────────────────────
export function reset() {
  db.exec("DELETE FROM node_concepts; DELETE FROM nodes;");
}
const insNode = db.prepare(
  "INSERT OR REPLACE INTO nodes (id, source, src_id, url, title, summary, created_at) VALUES (@id,@source,@src_id,@url,@title,@summary,@created_at)"
);
const insTag = db.prepare("INSERT OR IGNORE INTO node_concepts (node_id, label) VALUES (?,?)");
export function addNode(n, concepts = []) {
  insNode.run(n);
  for (const c of concepts) insTag.run(n.id, c);
}
export const insertMany = db.transaction((items) => {
  for (const { node, concepts } of items) addNode(node, concepts);
});

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
  const nodes = db.prepare("SELECT id, source, url, title FROM nodes").all();
  const all = linkRows.all();
  // k-NN: cada nó mantém suas K arestas mais fortes; une o conjunto.
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const linkOf = new Map();
  const byNode = {};
  for (const l of all) {
    linkOf.set(key(l.source, l.target), l);
    (byNode[l.source] ||= []).push(l);
    (byNode[l.target] ||= []).push(l);
  }
  const keep = new Set();
  for (const id in byNode) {
    byNode[id].sort((a, b) => b.weight - a.weight);
    for (const l of byNode[id].slice(0, K_NEIGHBORS)) keep.add(key(l.source, l.target));
  }
  const links = [...keep].map((k) => {
    const l = linkOf.get(k);
    return { source: l.source, target: l.target, weight: l.weight,
             concepts: l.concepts ? l.concepts.split(",") : [] };
  });
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
  const neighbors = rows.map((r) => ({
    id: r.id, source: r.source, url: r.url, title: r.title,
    weight: r.weight, shared: r.shared ? r.shared.split(",") : [],
  }));
  return { node, concepts, neighbors };
}

export function stats() {
  const bySource = db.prepare("SELECT source, COUNT(*) AS n FROM nodes GROUP BY source").all();
  const total = db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n;
  return { total, bySource };
}
