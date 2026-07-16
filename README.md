# Dash

Hub/launcher dos três projetos (**REFS**, **LATEFEED**, **NOTION**). Faz fetch
server-side de cada fonte, cacheia ~60s e serve uma página com um card por
projeto: número ao vivo + link pra abrir o app. Não migra nada — cada projeto
segue independente.

## Arquitetura

```
        ┌──────────── DASH (server.mjs) ────────────┐
        │  refs        latefeed        notion        │
        └───┬────────────┬───────────────┬───────────┘
   /refs-data.js   /api/summary    /api/summary
   (estático)      (token)         (token)
```

- **REFS** — nenhuma mudança. O dash lê `refs-data.js` e conta `refs.length`.
- **LATEFEED** e **NOTION** — cada um ganha um `GET /api/summary` read-only
  (código pronto em `snippets/`).

Cada card mostra o **número** + os **3 itens mais recentes** (clicáveis). Todas
as fontes falam o mesmo shape de item, então virar um "feed unificado" depois é
só um `concat` + `sort` — sem refazer nada:

```js
{ count, label, updatedAt, recent: [ { title, url, createdAt, source } ] }
```

## Setup

1. `cp .env.example .env` e preencha as 3 URLs + um `SUMMARY_TOKEN` forte.
2. Cole os endpoints:
   - `snippets/latefeed-api-summary-route.ts` → `portal-inputs/src/app/api/summary/route.ts`
   - `snippets/notion-api-summary-route.ts`   → `notion-clone/src/app/api/summary/route.ts`
3. Adicione `SUMMARY_TOKEN=<mesmo valor>` no `.env` (e nas vars do Railway) do
   portal-inputs **e** do notion-clone.
4. Local: `npm start` → http://127.0.0.1:4200

## Deploy (Railway)

Mesmo padrão do refs-catalog: novo serviço apontando pra esta pasta,
`startCommand: node server.mjs`. Configure as env vars (`REFS_URL`,
`LATEFEED_URL`, `NOTION_URL`, `SUMMARY_TOKEN`) no painel.

## Notas

- Cada card é resiliente: se uma fonte cair, as outras seguem aparecendo (o card
  da que falhou mostra o erro).
- Token opcional em dev: se `SUMMARY_TOKEN` estiver vazio nos dois lados, o
  `/api/summary` fica aberto (só faça isso local).
- Ajuste o stat de cada fonte editando os adapters em `server.mjs` (REFS) ou os
  snippets (LATEFEED/NOTION) — ex.: trocar "pendentes" por "total".
