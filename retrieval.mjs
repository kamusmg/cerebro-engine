#!/usr/bin/env node
// retrieval.mjs — o motor de recuperação PRÓPRIO do cérebro.
//
// Por que existe (medido em 18/07): o `graphify query` escolhe o seed por casamento
// léxico do texto da pergunta e NÃO deixa a gente injetar seed, nem controlar profundidade
// ou nº de nós. Isso teto-limitava o recall em 2 falhas:
//   (a) TERMO FREQUENTE DOMINA — "legenda mantém a pontuação" semeava só em "legenda"
//       (o bairro de transcrição/queima) e nunca chegava no `split_string_by_punctuations`.
//   (b) VÃO PT→EN — a pergunta é portuguesa, o símbolo-alvo é inglês; overlap léxico ZERO.
// A auditoria red-team (18/07) confirmou: "seed delegado ao matcher léxico" era o erro nº1.
//
// O conserto, copiando o melhor do mercado (nada se cria, tudo se copia):
//   • aider repo-map  → sqrt(refs) damping + x0.1 genérico/privado + x10 bem-nomeado (mata (a))
//   • query-rewrite   → 1 chamada Gemini free traduz PT→EN de código (mata (b)); cai pra
//                       léxico-só se o Gemini falhar (nunca falha muda)
//   • RRF k=60        → funde os braços (léxico + rewrite + grafo) por RANK, imune às escalas
//   • GraphRAG local  → padrão "seed bom → BFS", travessia PRÓPRIA sobre o graph.json
//
// O grafo é ÍNDICE, o arquivo é a verdade. Isto aponta; confirme no código antes de editar.
//
// Uso como lib:  const { consultar } = await import('./retrieval.mjs')
//        CLI:    node retrieval.mjs "<pergunta>" <graph.json> [raiz] [--sem-rewrite]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = import.meta.dirname;
const REWRITE_CACHE = path.join(REPO, '.rewrite-cache.json');
const KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

const K_RRF = 60;          // constante canônica do Reciprocal Rank Fusion (Cormack 2009)
const N_SEEDS = 8;         // quantos seeds alimentam o BFS
const DEPTH = 2;           // profundidade da travessia (graphify fixava em 2; aqui é knob)
const CAP_NOS = 60;        // teto de nós coletados no BFS
const MAX_ARQUIVOS = 5;    // corte final por arquivo — fiel ao que o harness mediu

// Pesos das heurísticas estilo-aider. Os defaults foram medidos (recall 20/24) numa base
// de nome DESCRITIVO (Python/JS/Rust/TS). Em linguagens de nome CURTO idiomático (Go, C),
// o bônus de "bem-nomeado" quase não dispara — destrave via env, ex.:
//   CEREBRO_W_BEMNOMEADO=1  CEREBRO_MIN_IDENT=4   (não premiar nome longo)
const W_GENERICO   = Number(process.env.CEREBRO_W_GENERICO   ?? 0.1); // símbolo genérico/privado/definido em >5 arquivos
const W_BEMNOMEADO = Number(process.env.CEREBRO_W_BEMNOMEADO ?? 10);  // identificador longo bem-nomeado
const MIN_IDENT    = Number(process.env.CEREBRO_MIN_IDENT    ?? 8);   // tamanho mínimo pra contar como "bem-nomeado"
const W_RECENTE    = Number(process.env.CEREBRO_W_RECENTE    ?? 50);  // arquivo mexido no git nos últimos 30 dias

// ---------- utilidades de texto ----------
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const normaliza = (s) => semAcento(String(s).toLowerCase());
// quebra identificador em palavras: split_string / splitString / split-string → [split,string]
// ATENÇÃO: o split de camelCase tem que vir ANTES do lowercase, senão "magneticButtonEffect"
// vira o blob "magneticbuttoneffect" e não casa com "setupMagnetic" (bug medido em 18/07-6:15).
function tokens(s) {
  return semAcento(String(s))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 3);
}

// ---------- FNV-1a (mesmo hash barato do resto do cérebro) ----------
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
};

// ---------- query-rewrite: a ponte semântica PT→EN (Gemini free, cacheado, com fallback) ----------
const leJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return padrao; } };

async function reescreve(pergunta) {
  if (!KEY) return { termos: [], origem: 'sem-chave' };
  const cache = leJson(REWRITE_CACHE, {});
  const chave = hash(normaliza(pergunta));
  if (cache[chave]) return { termos: cache[chave], origem: 'cache' };

  const prompt = [
    `Uma pergunta em português sobre um código-fonte (identificadores costumam ser em inglês).`,
    `Pergunta: "${pergunta}"`,
    ``,
    `Liste de 4 a 10 TERMOS que provavelmente aparecem NO CÓDIGO (nomes de função/variável em`,
    `inglês, snake_case ou camelCase, e substantivos técnicos em inglês). Traduza os conceitos`,
    `em português para o inglês de código (ex.: legenda→subtitle/caption, pontuação→punctuation,`,
    `acento→accent). Responda SÓ com um array JSON de strings, nada mais.`,
  ].join('\n');

  for (const model of ['gemini-2.5-flash-lite', 'gemini-2.5-flash']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) { if (r.status === 429) continue; throw new Error(`HTTP ${r.status}`); }
      const txt = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const m = txt.match(/\[[\s\S]*\]/);            // pesca o array mesmo se vier com cerca ```json
      const arr = m ? JSON.parse(m[0]) : null;
      if (Array.isArray(arr) && arr.length) {
        const termos = [...new Set(arr.map((t) => String(t)).filter(Boolean))];
        cache[chave] = termos;
        const tmp = `${REWRITE_CACHE}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2)); fs.renameSync(tmp, REWRITE_CACHE);
        return { termos, origem: model };
      }
    } catch { /* tenta o próximo modelo; se ambos falharem, cai no léxico-só */ }
  }
  return { termos: [], origem: 'falhou' };
}

// ---------- carga do grafo ----------
function carregaGrafo(grafoPath) {
  const g = JSON.parse(fs.readFileSync(grafoPath, 'utf8'));
  const nodes = g.nodes ?? [];
  const links = g.links ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const adj = new Map();          // adjacência não-direcionada (alcance no BFS)
  const refCount = new Map();     // grau do nó → damping do aider (sqrt)
  const rationaleDe = new Map();  // símbolo → prosa das docstrings/comentários ligadas
  const arquivosDoToken = new Map(); // identificador → conjunto de arquivos que o definem
  const relEntre = new Map();     // "src\0tgt" → relação (direção original) — evita varrer todas as arestas no formata

  const liga = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const l of links) {
    const s = l.source, t = l.target;
    liga(s, t); liga(t, s);
    relEntre.set(`${s}\0${t}`, l.relation);
    refCount.set(s, (refCount.get(s) ?? 0) + 1);
    refCount.set(t, (refCount.get(t) ?? 0) + 1);
    // rationale_for: o nó-fonte é a prosa (docstring/comentário), o alvo é o símbolo
    if (l.relation === 'rationale_for') {
      const prosa = byId.get(s)?.label;
      if (prosa) { if (!rationaleDe.has(t)) rationaleDe.set(t, []); rationaleDe.get(t).push(prosa); }
    }
  }
  // quantos arquivos distintos "definem" cada identificador (aider: >5 = genérico, x0.1)
  for (const n of nodes) {
    if (n.file_type !== 'code' || !n.source_file) continue;
    const id = normaliza(n.label).replace(/\(\)$/, '');
    if (!arquivosDoToken.has(id)) arquivosDoToken.set(id, new Set());
    arquivosDoToken.get(id).add(n.source_file);
  }
  return { g, nodes, byId, adj, refCount, rationaleDe, arquivosDoToken, relEntre };
}

// texto onde um nó é "buscável": rótulo + caminho + comunidade + prosa das docstrings ligadas
function textoBusca(n, rationaleDe) {
  const partes = [n.label, n.norm_label, n.source_file ? path.basename(n.source_file) : '',
    n.community_name ?? '', ...(rationaleDe.get(n.id) ?? [])];
  return normaliza(partes.filter(Boolean).join(' '));
}

// ---------- pontuação de seed, com o endurecimento do aider ----------
function pontuaSeeds(G, termosPergunta, termosRewrite) {
  const { nodes, refCount, rationaleDe, arquivosDoToken } = G;
  // IDF barato: termo que casa em MUITOS nós vale menos ("legenda") — mata a dominância (a)
  const docFreq = new Map();
  const textos = new Map();
  for (const n of nodes) {
    const tx = textoBusca(n, rationaleDe);
    textos.set(n.id, tx);
    const vistos = new Set();
    for (const w of new Set([...termosPergunta, ...termosRewrite])) {
      if (!vistos.has(w) && tx.includes(w)) { docFreq.set(w, (docFreq.get(w) ?? 0) + 1); vistos.add(w); }
    }
  }
  const N = nodes.length || 1;
  const idf = (w) => Math.log((N + 1) / ((docFreq.get(w) ?? 0) + 1)) + 1;

  const scoreLex = new Map(), scoreRw = new Map();
  for (const n of nodes) {
    const tx = textos.get(n.id);
    const idNorm = normaliza(n.label).replace(/\(\)$/, '');

    // multiplicadores do aider (por nó)
    let mul = 1;
    if (/^_/.test(n.label) || /^(index|utils?|main|misc|helpers?|const|config|schema)\b/i.test(n.label)) mul *= W_GENERICO;
    if ((arquivosDoToken.get(idNorm)?.size ?? 0) > 5) mul *= W_GENERICO;      // definido em >5 arquivos = genérico
    if (/[a-z0-9]_[a-z0-9]|[a-z][A-Z]/.test(n.label) && n.label.length >= MIN_IDENT) mul *= W_BEMNOMEADO; // identificador longo bem-nomeado
    // prefer CODE when seeding: data-file nodes (json/txt) match a common term via community_name
    // and drown the real target. Don't exclude docs — just discount when code is competing.
    if (n.file_type && n.file_type !== 'code') mul *= 0.25;
    // sqrt damping: nó-hub (grau alto) não domina só por ser popular
    const damp = 1 / Math.sqrt(1 + (refCount.get(n.id) ?? 0));

    const acumula = (mapa, termos) => {
      let s = 0;
      for (const w of termos) if (tx.includes(w)) s += idf(w);
      if (s > 0) mapa.set(n.id, s * mul * damp);
    };
    acumula(scoreLex, termosPergunta);
    acumula(scoreRw, termosRewrite);
  }
  return { scoreLex, scoreRw };
}

// ranking → rank 1-based (pra RRF)
const rankeia = (mapa) => {
  const ord = [...mapa.entries()].sort((a, b) => b[1] - a[1]);
  const rank = new Map();
  ord.forEach(([id], i) => rank.set(id, i + 1));
  return rank;
};

// BFS próprio a partir dos seeds — devolve id→distância(saltos) mínima
function bfs(G, seeds, depth, cap) {
  const dist = new Map(seeds.map((id) => [id, 0]));
  let fronteira = [...seeds];
  for (let d = 1; d <= depth && dist.size < cap; d++) {
    const prox = [];
    for (const id of fronteira) {
      for (const viz of G.adj.get(id) ?? []) {
        if (!dist.has(viz)) { dist.set(viz, d); prox.push(viz); if (dist.size >= cap) break; }
      }
      if (dist.size >= cap) break;
    }
    fronteira = prox;
  }
  return dist;
}

// ---------- a consulta ----------
export async function consultar({ grafoPath, raiz, pergunta, semRewrite = false }) {
  const G = carregaGrafo(grafoPath);
  const termosPergunta = [...new Set(tokens(pergunta))];
  const rw = semRewrite ? { termos: [], origem: 'desligado' } : await reescreve(pergunta);
  const termosRewrite = [...new Set(rw.termos.flatMap((t) => tokens(t)))];

  const { scoreLex, scoreRw } = pontuaSeeds(G, termosPergunta, termosRewrite);

  // seeds = melhores dos dois braços léxicos juntos
  const somaSeed = new Map();
  for (const [id, s] of scoreLex) somaSeed.set(id, (somaSeed.get(id) ?? 0) + s);
  for (const [id, s] of scoreRw) somaSeed.set(id, (somaSeed.get(id) ?? 0) + s);
  const seeds = [...somaSeed.entries()].sort((a, b) => b[1] - a[1]).slice(0, N_SEEDS).map(([id]) => id);

  const dist = bfs(G, seeds, DEPTH, CAP_NOS);

  // braço-grafo: quem o BFS alcançou, mais perto = melhor
  const scoreGrafo = new Map();
  for (const [id, d] of dist) scoreGrafo.set(id, 1 / (1 + d));

  // RRF k=60 sobre os três braços (léxico + rewrite + grafo)
  const rkLex = rankeia(scoreLex), rkRw = rankeia(scoreRw), rkGr = rankeia(scoreGrafo);
  const candidatos = new Set([...scoreLex.keys(), ...scoreRw.keys(), ...scoreGrafo.keys()]);
  const rrf = new Map();
  for (const id of candidatos) {
    let s = 0;
    for (const rk of [rkLex, rkRw, rkGr]) if (rk.has(id)) s += 1 / (K_RRF + rk.get(id));
    rrf.set(id, s);
  }

  // corte por ARQUIVO (top-5) + reforço de recência do git (x50).
  // Recência por CAMINHO COMPLETO, não basename: casar só "utils.py" daria o bônus ×50 a TODO
  // utils.py/index.js/__init__.py do repo (Next/Django) e coroaria o arquivo errado. git e o
  // source_file do graphify são ambos relativos à raiz — normaliza a barra e casa exato.
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  let recentes = new Set();
  try {
    recentes = new Set(execFileSync('git', ['-C', raiz, 'log', '--since=30.days', '--name-only', '--format='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean).map((f) => norm(f.trim())));
  } catch { /* sem git = sem recência */ }

  // Recência do git (x50) entra SÓ na escolha do arquivo, não no sort dos nós — medido em
  // 18/07: reforçar o nó com x10/x50 no sort final OVERFITTOU e enterrou o alvo (MRR 0.58→0.52).
  // RRF puro dentro dos arquivos recentes-selecionados foi estritamente melhor (recall 8/8,
  // hit@3 6/8). Lição: menos tempero, mais fusão.
  const scoreArquivo = new Map();
  for (const [id, s] of rrf) {
    const src = G.byId.get(id)?.source_file; if (!src) continue;
    const boost = recentes.has(norm(src)) ? W_RECENTE : 1;
    scoreArquivo.set(src, Math.max(scoreArquivo.get(src) ?? 0, s * boost));
  }
  const topArquivos = new Set([...scoreArquivo.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ARQUIVOS).map(([f]) => f));

  const escolhidos = [...candidatos]
    .map((id) => G.byId.get(id))
    .filter((n) => n && n.source_file && topArquivos.has(n.source_file) && n.file_type !== 'rationale')
    .sort((a, b) => (rrf.get(b.id) ?? 0) - (rrf.get(a.id) ?? 0));

  return { G, escolhidos, seeds, rw, dist, rrf, totalArquivos: scoreArquivo.size };
}

// Pergunta AMPLA ("como funciona", "visão geral") não é caso de travessia: BFS responde mal e
// caro. Pra ela existe o resumo hierárquico cacheado (nível GraphRAG). Isso morava só no ask.mjs
// — o MCP chamava consultar() direto e a IA levava travessia ruidosa em pergunta arquitetural.
// Agora vive aqui, e os DOIS clientes (CLI e MCP) passam por este mesmo portão.
export const AMPLA = /como (o projeto |esse projeto |ele |isso )?(funciona|trabalha)|vis[aã]o geral|o que (é|faz) (o|esse|este)|arquitetura d|overview|resum(o|e) (o|do|desse)/i;

// devolve o resumo cacheado do projeto, ou null (pergunta específica, ou projeto sem resumo)
export function resumoAmplo(pergunta, nomeProjeto) {
  if (!AMPLA.test(pergunta)) return null;
  // fileURLToPath e não .pathname: o caminho de instalação pode ter espaço, e o pathname cru
  // devolve %20 (e "/D:/..." no Windows) — o existsSync falharia CALADO e a pergunta ampla
  // voltaria a cair na travessia cara sem ninguém perceber.
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resumos', `${nomeProjeto}.md`);
  if (!fs.existsSync(f)) return null;
  return `${fs.readFileSync(f, 'utf8')}\n[resumo cacheado de ${nomeProjeto} — pra detalhe, faça uma pergunta específica ao grafo]`;
}

// formata igual à saída do graphify (NODE/EDGE) pra medição e leitura continuarem valendo
export function formata(res, nomeProjeto) {
  const { G, escolhidos, seeds, rw, totalArquivos } = res;
  const nomesSeed = seeds.map((id) => G.byId.get(id)?.label ?? id).slice(0, 5);
  const linhas = [`Traversal: seeds=[${nomesSeed.join(' · ')}] | rewrite=${rw.origem} | ${escolhidos.length} nós em ${Math.min(totalArquivos, MAX_ARQUIVOS)} arquivos`, ''];
  for (const n of escolhidos) {
    linhas.push(`NODE ${n.label} [src=${n.source_file} loc=${n.source_location ?? '?'} community=${n.community ?? '?'}]`);
  }
  // arestas entre os nós escolhidos (≤~50) via adjacência — NÃO varrer todas as arestas do grafo
  // (era O(|E|) por consulta; num grafo grande, loop gigante só pra desenhar setas). relEntre só
  // tem a direção original, então cada aresta sai uma vez, sem duplicar o reverso.
  const ids = new Set(escolhidos.map((n) => n.id));
  for (const a of ids) {
    for (const b of G.adj.get(a) ?? []) {
      if (!ids.has(b)) continue;
      const rel = G.relEntre.get(`${a}\0${b}`);
      if (!rel) continue;
      const la = G.byId.get(a)?.label, lb = G.byId.get(b)?.label;
      if (la && lb) linhas.push(`EDGE ${la} --${rel}--> ${lb}`);
    }
  }
  if (totalArquivos > MAX_ARQUIVOS) linhas.push('', `[motor próprio: RRF léxico+rewrite+grafo · ${totalArquivos}→${MAX_ARQUIVOS} arquivos]`);
  return linhas.join('\n');
}

// CLI direto (debug)
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('retrieval.mjs')) {
  const [pergunta, grafoPath, raiz] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const semRewrite = process.argv.includes('--sem-rewrite');
  if (!pergunta || !grafoPath) { console.error('Uso: node retrieval.mjs "<pergunta>" <graph.json> [raiz] [--sem-rewrite]'); process.exit(1); }
  const res = await consultar({ grafoPath, raiz: raiz ?? path.dirname(path.dirname(grafoPath)), pergunta, semRewrite });
  console.log(formata(res, 'debug'));
}
