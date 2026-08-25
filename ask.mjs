#!/usr/bin/env node
// ask.mjs — ask the code graph of ANY project, from any folder.
//
// Why it exists: your agent's session may open anywhere, and `graphify query` looks for
// graphify-out/ relative to the cwd. From the wrong folder it finds nothing and fails
// silently — the agent falls back to reading dozens of files. Here the project root comes
// from projects.json and the graph path is passed explicitly via --graph.
//
// ENGINE: the OWN retrieval layer (retrieval.mjs) — hybrid seed selection (lexical +
// cross-language query-rewrite from caller-supplied terms + aider-style hardening) + own BFS +
// Reciprocal Rank Fusion.
//
// Measured on the author's golden set, along all THREE paths the engine is actually used
// through (2026-08-25). Until then only the middle one had a number, and it was quoted as if
// it described the first:
//
//   caller-supplied --termos   recall 20/24 · hit@3 17/24 · MRR 0.701   <- what production uses
//   rewrite cache hit          recall 21/24 · hit@3 17/24 · MRR 0.636
//   --sem-rewrite (no terms)   recall 17/24 · hit@3 14/24 · MRR 0.533   <- baseline
//
// Read it this way: the term arm pays for itself (3-4 more answers found than the baseline),
// and caller-supplied terms trade one hit for a clearly better rank. Held-out set: 14/14 ·
// MRR 0.869.
//
// The old path (graphify query + aider re-rank) was REMOVED on 2026-08-25 — see the block above
// the `try`, together with the numbers it measured with a crooked ruler.
//
// Usage: node ask.mjs "<question>" <project> [--termos "a,b,c"] [--sem-rewrite] [--cru]
//        node ask.mjs --lista
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consultar, formata, resumoAmplo } from './retrieval.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const projetos = JSON.parse(readFileSync(join(ROOT, 'projects.json'), 'utf8'));

const [pergunta, alvo, ...resto] = process.argv.slice(2);

// --termos: whoever calls this script is almost always a model, and a model translates "how
// the scene gets built" into the code's identifiers better than any automatic bridge — free,
// no network, no key. This used to cost one Gemini call per new question.
const iTermos = resto.indexOf('--termos');
const termos = iTermos >= 0 && resto[iTermos + 1]
  ? resto[iTermos + 1].split(',').map((t) => t.trim()).filter(Boolean)
  : undefined;

if (!pergunta || pergunta === '--lista' || !alvo) {
  console.log('Uso: node ask.mjs "<pergunta>" <projeto> [--termos "build_scene,render_frame"]\n\nProjetos com grafo:');
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

// THE A/B AGAINST THE OLD PATH IS CLOSED (2026-07-29), AND THE COMPARATOR WAS REMOVED
// ON 2026-08-25.
//
// This is where `reRankeia()` — an aider-style re-rank over `graphify query` output — and the
// `--motor=graphify` branch used to live. Two reasons, and the second is the one that matters:
//
// 1. The experiment is over. Keeping the comparison arm of a settled experiment is dead weight.
//
// 2. THE COMPARATOR WAS BIASED, and that contaminated every head-to-head number it produced.
//    It matched file recency by `basename` — the exact bug that `retrieval.mjs` documents
//    having fixed in the NEW engine by matching on the full path. Two files with the same name
//    in different folders counted as one file on one side of the comparison and not on the
//    other. So the old path ran with a limp against an engine with a good leg, and every
//    published margin leans the same way: toward whoever holds the good ruler.
//
//    The numbers measured with that crooked ruler are kept here rather than deleted, because
//    cutting the code and leaving the number loose in the docs is the worst of both worlds:
//      • the MRR 0.473 -> 0.659 that justified the aider re-rank
//      • the head-to-head margin reported in the README
//      • last measurement before removal (2026-08-25, ruler still crooked):
//        own engine 21/24 · MRR 0.636  ×  graphify path 14/24 · MRR 0.519
//
//    None of this overturns the verdict — the gap is far too wide to be bias alone, and the
//    own engine stays. But the number can no longer be quoted as if it were clean.
//
// Production never went through here: `reRankeia` only ran under `--motor=graphify`.

try {
  const res = await consultar({ grafoPath: grafo, raiz: achado.root, pergunta, termos, semRewrite: resto.includes('--sem-rewrite') });
  console.log(formata(res, achado.name));
  console.log(`[grafo de ${achado.name} — o arquivo é a verdade, confirme antes de editar]`);
} catch (e) {
  console.error(`query falhou: ${e.message}`);
  process.exit(1);
}
