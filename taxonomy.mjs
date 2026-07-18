// Vocabulário de conceitos compartilhado (Fase 1 — sem embeddings).
// Mapeia as categorias que já existem em REFS/LATEFEED e dá keywords p/ casar
// páginas do NOTION (que não têm categoria estruturada).
export const CONCEPTS = [
  { label: "ia",            refs_cats: ["ai"],      latefeed_slugs: [],            keywords: ["ia","inteligência artificial","ai","llm","gpt","claude","modelo","machine learning","prompt","generative","rede neural","difusão"] },
  { label: "design",        refs_cats: ["design"],  latefeed_slugs: [],            keywords: ["design","ui","ux","interface","layout","gráfico","grid","cor","branding","identidade visual","product design","figma"] },
  { label: "tipografia",    refs_cats: ["type"],    latefeed_slugs: [],            keywords: ["tipografia","fonte","typeface","font","type","lettering","kerning","serif","glifo","tipografico"] },
  { label: "audiovisual",   refs_cats: ["av"],      latefeed_slugs: [],            keywords: ["audiovisual","vídeo","video","filme","cinema","montagem","edição","motion","animação","som","câmera","render","3d"] },
  { label: "assets",        refs_cats: ["assets"],  latefeed_slugs: [],            keywords: ["asset","recurso","template","mockup","textura","ícone","icon","stock","biblioteca","download","plugin","preset"] },
  { label: "inspiracao",    refs_cats: ["inspo"],   latefeed_slugs: ["inspiracao"], keywords: ["inspiração","inspiration","referência","reference","moodboard","portfólio","showcase","ideia","estética","exemplo"] },
  { label: "produtividade", refs_cats: ["self"],    latefeed_slugs: ["pessoal"],   keywords: ["produtividade","productivity","hábito","habit","foco","rotina","organização","workflow","notas","aprendizado","desenvolvimento pessoal","tempo"] },
  { label: "seguranca",     refs_cats: ["sec"],     latefeed_slugs: [],            keywords: ["segurança","security","privacidade","privacy","senha","password","criptografia","encryption","vpn","hack","dados","malware"] },
  { label: "cultura",       refs_cats: ["culture"], latefeed_slugs: [],            keywords: ["cultura","culture","arte","art","música","sociedade","história","política","tendência","ensaio","filosofia"] },
  { label: "negocios",      refs_cats: [],          latefeed_slugs: ["outros"],    keywords: ["negócio","business","trabalho","carreira","freelance","cliente","projeto","estratégia","marketing","empreendedorismo","dinheiro","startup"] },
  { label: "pessoal",       refs_cats: [],          latefeed_slugs: ["pessoal"],   keywords: ["pessoal","vida","saúde","health","família","viagem","finanças pessoais","bem-estar","relacionamento","casa"] },
];

// tira acentos e baixa caixa — p/ casar keywords contra texto do Notion
export const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const BY_REFS_CAT = {};
const BY_LATE_SLUG = {};
for (const c of CONCEPTS) {
  for (const r of c.refs_cats) (BY_REFS_CAT[r] ||= []).push(c.label);
  for (const s of c.latefeed_slugs) (BY_LATE_SLUG[s] ||= []).push(c.label);
}
export const conceptsForRefsCat = (cat) => BY_REFS_CAT[cat] || [];
export const conceptsForLateSlug = (slug) => BY_LATE_SLUG[slug] || [];

// conceitos cujo texto casa alguma keyword — por PALAVRA INTEIRA (evita
// "ia" casar dentro de "tipografia"). Tokeniza tudo em palavras separadas por espaço.
const tokens = (s) => " " + norm(s).replace(/[^a-z0-9]+/g, " ").trim() + " ";
export function conceptsForText(text) {
  const t = tokens(text);
  const out = [];
  for (const c of CONCEPTS) {
    if (c.keywords.some((k) => t.includes(" " + tokens(k).trim() + " "))) out.push(c.label);
  }
  return out;
}
