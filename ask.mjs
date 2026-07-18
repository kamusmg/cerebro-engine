#!/usr/bin/env node
// ask.mjs — ask the code graph of ANY project, from any folder.
//
// Why it exists: your agent's session may open anywhere, and `graphify query` looks for
// graphify-out/ relative to the cwd. From the wrong folder it finds nothing and fails
// silently — the agent falls back to reading dozens of files. Here the project root comes
// from projects.json and the graph path is passed explicitly via --graph.
//
// ENGINE: by default uses the OWN retrieval layer (retrieval.mjs) — hybrid seed selection
// (lexical + cross-language query-rewrite via Gemini free tier + aider-style hardening) +
// own BFS + Reciprocal Rank Fusion. Measured: recall 15/24 -> 20/24 on the author's golden
// set. The old path (graphify query + aider re-rank) stays under `--motor=graphify` for A/B.
//
// Usage: node ask.mjs "<question>" <project> [--motor=graphify] [--sem-rewrite] [--cru]
//        node ask.mjs --lista
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consultar, formata } from './retrieval.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const projetos = JSON.parse(readFileSync(join(ROOT, 'projects.json'), 'utf8'));

const [pergunta, alvo, ...resto] = process.argv.slice(2);

if (!pergunta || pergunta === '--lista' || !alvo) {
  console.log('Uso: node ask.mjs "<pergunta>" <projeto>\n\nProjetos com grafo:');
  for (const p of projetos) {
    const g = join(p.root, 'graphify-out', 'graph.json');
    if (existsSync(g)) console.log(`  ${p.name.padEnd(26)} ${p.root}`);
  }
  process.exit(pergunta && pergunta !== '--lista' ? 1 : 0);
}

// aceita nome exato, pedaço do nome, ou caminho
const achado = projetos.find((p) => p.name === alvo)
  ?? projetos.find((p) => p.name.includes(alvo.toLowerCase()))
  ?? projetos.find((p) => p.root.toLowerCase().includes(alvo.toLowerCase()));

if (!achado) {
  console.error(`Projeto "${alvo}" não existe. Rode com --lista pra ver os nomes.`);
  process.exit(1);
}

const grafo = join(achado.root, 'graphify-out', 'graph.json');
if (!existsSync(grafo)) {
  console.error(`${achado.name} não tem grafo ainda (${grafo}).`);
  console.error('Gere com: graphify update "' + achado.root + '"');
  process.exit(1);
}

// Pergunta AMPLA ("como funciona", "o que é", "visão geral") puxava uma travessia grande
// e cara que respondia mal — travessia serve pergunta ESPECÍFICA. Pra ampla existe o
// resumo hierárquico (nível GraphRAG, resumo-projetos.mjs): serve ele e para. O grafo
// continua uma pergunta específica de distância; --grafo força a travessia mesmo assim.
const AMPLA = /como (o projeto |esse projeto |ele |isso )?(funciona|trabalha)|vis[aã]o geral|o que (é|faz) (o|esse|este)|arquitetura d|overview|resum(o|e) (o|do|desse)/i;
if (AMPLA.test(pergunta) && !resto.includes('--grafo')) {
  const resumoF = join(ROOT, 'resumos', `${achado.name}.md`);
  if (existsSync(resumoF)) {
    console.log(readFileSync(resumoF, 'utf8'));
    console.log(`[resumo cacheado de ${achado.name} — pra detalhe, faça uma pergunta específica ao grafo ou repita com --grafo]`);
    process.exit(0);
  }
}

// re-rank estilo aider — FIEL AO QUE FOI MEDIDO: o score é por nó, o ranking e o corte
// são por ARQUIVO (top-5 arquivos, todos os nós deles). Foi assim que o harness chegou
// em MRR 0.473→0.659; cortar por nó parecia igual e deixava o alvo de fora.
const MAX_ARQUIVOS = 5;
const NODE_RE = /^NODE (.+?) \[src=(.+?) loc=/;
function reRankeia(saida, raiz) {
  const linhas = saida.split('\n');
  const nos = [];
  for (const l of linhas) {
    const m = NODE_RE.exec(l);
    if (m) nos.push({ linha: l, label: m[1], src: m[2] });
  }
  if (nos.length <= 1) return saida;

  let recentes = new Set();
  try {
    recentes = new Set(execFileSync('git', ['-C', raiz, 'log', '--since=30.days', '--name-only', '--format='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean).map((f) => basename(f.trim())));
  } catch { /* sem git = sem peso de recência */ }

  const palavras = pergunta.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  const scoreArquivo = new Map();
  nos.forEach((n, i) => {
    let s = 1 / (1 + i * 0.1); // leve prior da ordem do BFS
    if (palavras.some((w) => n.label.toLowerCase().includes(w))) s *= 10;
    if (recentes.has(basename(n.src))) s *= 50;
    if (/^(index|utils?|main|misc|helpers?)\b/i.test(n.label)) s *= 0.1;
    n.score = s;
    scoreArquivo.set(n.src, Math.max(scoreArquivo.get(n.src) ?? 0, s));
  });
  const topArquivos = new Set([...scoreArquivo.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ARQUIVOS).map(([f]) => f));
  const escolhidos = nos.filter((n) => topArquivos.has(n.src)).sort((a, b) => b.score - a.score);
  const labels = new Set(escolhidos.map((n) => n.label));

  const EDGE_RE = /^EDGE (.+?) --.*?--> (.+)$/;
  const resultado = [];
  for (const l of linhas) {
    // 'NODE ' que não casou a regex é nó sem src (ValueError, BaseModel...) — lixo, fora
    if (l.startsWith('NODE ')) continue;              // nós entram reordenados, abaixo do cabeçalho
    if (l.startsWith('... (truncated')) continue;     // aviso do orçamento CRU, não vale pós-corte
    const em = EDGE_RE.exec(l);                       // aresta só se as duas pontas sobreviveram
    if (em && !(labels.has(em[1]) && labels.has(em[2]))) continue;
    resultado.push(l);
    if (/^Traversal:/.test(l)) resultado.push('', ...escolhidos.map((n) => n.linha));
  }
  if (scoreArquivo.size > MAX_ARQUIVOS) {
    resultado.push(`[re-rank aider: ${scoreArquivo.size}→${topArquivos.size} arquivos; use --cru pra ver tudo]`);
  }
  return resultado.join('\n');
}

// Motor PRÓPRIO é o padrão (seed híbrido + rewrite PT→EN + RRF; conserta o teto de recall
// de 18/07). `--motor=graphify` volta pro caminho antigo (graphify query + reRankeia) pra A/B.
const MOTOR_GRAPHIFY = resto.includes('--motor=graphify');

try {
  if (MOTOR_GRAPHIFY) {
    const saida = execFileSync('graphify', ['query', pergunta, '--graph', grafo,
      ...resto.filter((r) => r !== '--cru' && !r.startsWith('--motor='))], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    console.log(resto.includes('--cru') ? saida : reRankeia(saida, achado.root));
  } else {
    const res = await consultar({ grafoPath: grafo, raiz: achado.root, pergunta, semRewrite: resto.includes('--sem-rewrite') });
    console.log(formata(res, achado.name));
  }
  console.log(`[grafo de ${achado.name} — o arquivo é a verdade, confirme antes de editar]`);
} catch (e) {
  console.error(`query falhou: ${e.message}`);
  process.exit(1);
}
