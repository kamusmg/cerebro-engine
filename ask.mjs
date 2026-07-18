#!/usr/bin/env node
// ask.mjs — pergunta ao grafo de QUALQUER projeto, de qualquer pasta.
//
// Por que existe: a sessão do Claude Code abre em C:\Users\samue (a home), e o
// `graphify query` procura graphify-out/ a partir do cwd. Da home ele nunca acha nada —
// o reflexo do CLAUDE.md morria calado e o modelo caía no Read/Grep (medido: uma sessão
// com 543 Reads e ZERO queries). Aqui a raiz do projeto sai do projects.json e o grafo
// vai explícito no --graph.
//
// MOTOR (18/07): por padrão usa o retrieval PRÓPRIO (retrieval.mjs) — seed híbrido
// (léxico + rewrite PT→EN via Gemini free + endurecimento aider) + BFS próprio + fusão RRF.
// Medido: recall 5/8→8/8 no gabarito (o teto quebrou). Detalhe em reports/recall.md.
// O caminho antigo (graphify query + re-rank aider) continua em `--motor=graphify` pra A/B.
//
// Uso: node ask.mjs "<pergunta>" <projeto> [--motor=graphify] [--sem-rewrite] [--cru]
//      node ask.mjs --lista
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consultar, formata, resumoAmplo } from './retrieval.mjs';

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
// (o portão mora no retrieval.mjs, compartilhado com o mcp-server.mjs)
if (!resto.includes('--grafo')) {
  const resumo = resumoAmplo(pergunta, achado.name);
  if (resumo) {
    console.log(`${resumo} (ou repita com --grafo)`);
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
