# CÉREBRO — camada de relações REFS × LATEFEED × NOTION

Segundo cérebro como **camada de arestas** sobre as 3 fontes (nada migra; cada item
é referenciado por `{source, src_id, url}`). Mora **dentro do dash** (Node +
better-sqlite3 + sqlite-vec), nova aba **CÉREBRO**.

## Decisões (2026-07-18)
- **Automático-primeiro**: tags + semântica geram as arestas; pin manual é bônus.
- **Embeddings locais** (Fase 2): nomic-embed (Ollama) ou micro-serviço Python + sqlite-vec. Offline, sem custo por uso.
- **Casa**: no próprio dash.

## Modelo de dados (SQLite: `brain.db`)
```
nodes(id, source, src_id, url, title, summary, created_at, embedding BLOB?)
concepts(id, label, kind)                 -- kind: category | entity
node_concepts(node_id, concept_id, weight)
edges(src, dst, type, weight, origin)     -- origin: tag | semantic | manual
                                          -- type: mesmo-tema | cita | desdobramento | contradiz | inspirado | manual
sync_state(source, last_run, cursor)
```
sqlite-vec indexa `embedding` → vizinhos = arestas semânticas (Fase 2).

## De onde vem cada item (o sync precisa de MAIS que os adapters atuais)
| Fonte | Puxa | Como |
|---|---|---|
| **REFS** | todos os refs (title, url, **cat**, types, date, desc) | já baixa `refs-data.js` — usar o array inteiro, não top-3 |
| **LATEFEED** | todos os inputs (title, **categoria**, summary, createdAt) | `/api/feed` (existe, 200 via proxy) ou novo `/api/summary?full` |
| **NOTION** | páginas da IMPORT + conteúdo p/ extrair tema | API de blocks (já usada); título + prévia |

## Sync job (reusa adapters, roda agendado — padrão launchd/cron)
1. puxa itens das 3 fontes → **upsert nodes**
2. **concepts**: normaliza as categorias que já existem (REFS.cat, categoria LATEFEED)
   num vocabulário comum via tabela de mapeamento; p/ Notion (sem tag), extrai
   1-3 tags via LLM (Gemini/Claude que você já usa)
3. reconstrói **edges origin=tag** (itens que compartilham conceito)
4. (Fase 2) calcula embeddings → **edges origin=semantic** (vizinhos > limiar)

## UX da aba CÉREBRO
- **Graph view** force-directed (lib vanilla `force-graph`, canvas, sem build):
  cor por fonte, tamanho por grau, aresta por tipo.
- **Foco/backlinks**: clica no nó → vizinhos agrupados por relação, link p/ o app de origem.
- **MOCs por conceito**: "tipografia" → refs + inputs + páginas do tema.
- **Filtros**: fonte, tag, tempo, busca. **Serendipidade**: 3 conexões inesperadas do dia.

## Fases
- **F1** (sem ML): brain.db + sync + grafo de **tags** + aba com graph view + MOCs. ← começar aqui
- **F2**: embeddings locais → arestas semânticas + painel "relacionados".
- **F3**: pins manuais + arestas tipadas + serendipidade.

## Stack
better-sqlite3 · sqlite-vec (F2) · force-graph (vasturiano, vendorizado local) ·
Node http do dash · LLM p/ tags do Notion (F1) e opcional resumos.
