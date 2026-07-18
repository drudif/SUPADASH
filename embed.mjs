// Embeddings locais via Ollama (nomic-embed-text, 768-dim). Sem serviço externo.
const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

// nomic pede um prefixo de tarefa; usar o mesmo dos dois lados mantém a similaridade comparável
const prefix = (t) => `search_document: ${String(t || "").slice(0, 2000)}`;

export async function embedText(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: prefix(text) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const d = await res.json();
  return normalize(Float32Array.from(d.embedding || []));
}

// normaliza p/ vetor unitário → cosseno vira produto escalar
export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// embeda muitos textos com concorrência limitada
export async function embedMany(texts, concurrency = 6) {
  const out = new Array(texts.length);
  let i = 0;
  async function worker() {
    while (i < texts.length) {
      const idx = i++;
      try { out[idx] = await embedText(texts[idx]); }
      catch { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}

export async function ollamaReady() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const d = await r.json();
    return (d.models || []).some((m) => (m.name || "").startsWith(MODEL));
  } catch { return false; }
}
