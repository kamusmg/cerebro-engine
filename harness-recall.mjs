#!/usr/bin/env node
// harness-recall.mjs — mede RECALL do ask.mjs contra o gabarito (reports/golden-questions.json).
//
// A auditoria (18/07) pegou a manchete "8.1x tokens" como frágil: ratio sem sinal fim-a-fim.
// O sinal fim-a-fim é ESTE: numa pergunta real, o arquivo que teria que ser editado aparece
// na resposta do grafo? Se não aparece, o modelo cai no Read-tudo e a economia é zero.
//
// Measures the engine along its three real paths (see the note above `motores`). Per question:
//   • recall  — a target file appears ANYWHERE in the output (top-5 files)
//   • hit@3   — the target is among the first 3 NODE lines
//   • rank    — position of the 1st target NODE (for MRR)
//   • nodes   — number of NODE lines (cheap proxy for tokens)
//
// Last full run (2026-08-25, author's golden set, 24 questions):
//   chamador     recall 20/24 · hit@3 17/24 · MRR 0.701   <- production path
//   cache        recall 21/24 · hit@3 17/24 · MRR 0.636
//   sem-rewrite  recall 17/24 · hit@3 14/24 · MRR 0.533   <- baseline
//
// Usage: node harness-recall.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = import.meta.dirname;
// The golden set is the author's and is NOT shipped: the questions point at private repos, so
// publishing them would leak exactly what this repo takes care not to leak. That makes the
// published numbers reproducible by the author, not by you — the README says so plainly.
//
// What you CAN do is build your own: `reports/golden-questions.example.json` has the shape.
// A bare read here gave a raw ENOENT stack trace instead of that sentence.
//
// UMA RÉGUA POR VEZ, E ELA SE IDENTIFICA JUNTO DO NÚMERO (2026-08-26). A versão anterior caía em
// cascata — gabarito do autor → sintético → exemplo — e avisava qual usou num rótulo ACIMA da
// tabela. Só que a linha do AGREGADO saía idêntica nos três casos, e é ela que a gente copia pro
// relatório e pra memória. Medidor que troca de régua sozinho não mede: produz números que parecem
// da mesma série histórica e não são. Agora é explícito (`--golden`) ou o do autor, nada de
// fallback — e o nome da régua vai colado no agregado, onde ninguém consegue copiar sem levar.
/**
 * @typedef {object} PerguntaGolden
 * @property {string} pergunta
 * @property {string} projeto
 * @property {string[]} alvos
 * @property {string[]} [termos]
 * @property {boolean} [aposentado]
 *
 * @typedef {object} Medida
 * @property {number} recall
 * @property {number} hit3
 * @property {number} rr
 * @property {number} nos
 * @property {number} soBasename
 *
 * @typedef {{erro: string} | {amputada: true} | Medida} Celula
 *
 * O MODO É UMA UNIÃO FECHADA, não uma string qualquer: 'termos' passa --termos, null não passa
 * flag nenhuma (é o braço do cache), 'baseline' passa --sem-rewrite. Deixar isso como string
 * solta foi o que permitiu, por semanas, que a coluna 'chamador' rodasse igual à 'cache'.
 * @typedef {'termos' | 'baseline' | null} ModoMotor
 *
 * @typedef {object} Acumulador
 * @property {number} recall
 * @property {number} hit3
 * @property {number} rr
 * @property {number} nos
 * @property {number} erros
 * @property {Record<string, number>} origens
 * @property {number} aposentadas
 * @property {number} recallVivas
 * @property {number} hit3Vivas
 * @property {number} rrVivas
 * @property {number} amputadas
 * @property {number} soBasename
 *
 * Uma linha da tabela: duas colunas fixas e uma célula por motor, indexada pelo NOME do motor.
 * @typedef {{pergunta: string, projeto: string} & Record<string, string|Celula>} Linha
 */

const args = process.argv.slice(2);
const iGolden = args.indexOf('--golden');
if (iGolden >= 0 && !args[iGolden + 1]) {
  console.error('--golden precisa do caminho: node harness-recall.mjs --golden <arquivo.json>');
  process.exit(1);
}
const GOLDEN = iGolden >= 0
  ? path.resolve(args[iGolden + 1])
  : path.join(REPO, 'reports', 'golden-questions.json');

let golden;
try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
} catch (e) {
  // "não achei" e "achei quebrado" são resultados diferentes e recebem mensagens diferentes.
  const errGolden = /** @type {NodeJS.ErrnoException} */ (e);
  console.error(errGolden.code === 'ENOENT'
    ? `${path.relative(REPO, GOLDEN)} not found.\n\nThis file is not shipped — the author's questions point at private repos. To measure\nyour own engine, build a set with the shape of reports/golden-questions.example.json:\neach entry needs { projeto, pergunta, alvos: ["file-that-should-be-found.js"] }.\nThen run: node harness-recall.mjs --golden <your-file.json>`
    : `${path.relative(REPO, GOLDEN)} could not be parsed: ${errGolden.message}`);
  process.exit(1);
}

const relGolden = path.relative(REPO, GOLDEN);

const SRC_RE = /^NODE .+? \[src=(.+?) loc=/;

// Motor QUEBRADO não pode pontuar igual a motor que errou. Antes o catch virava saída vazia e
// o resultado era `recall 0` limpo: numa máquina sem o `graphify` no PATH, o relatório sairia
// "graphify 0/24" e ninguém saberia que ele nunca rodou. Isso é o pecado capital do projeto
// aplicado justamente à métrica que JUSTIFICA o projeto. Agora falha é `erro`, não zero.
/**
 * @param {string} pergunta
 * @param {string} projeto
 * @param {string[]} flags
 * @returns {{srcs: string[], bytes: number, erro: string|null, origem: string}}
 */
function roda(pergunta, projeto, flags) {
  let saida = '';
  let erro = null;
  try {
    saida = execFileSync('node', [path.join(REPO, 'ask.mjs'), pergunta, projeto, ...flags],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000,
        // the thermometer must not change the temperature — see the note above `motores`
        env: { ...process.env, CEREBRO_CACHE_RO: '1' } });
  } catch (e) {
    // stdout e stderr chegam juntos no erro de um execFileSync que saiu != 0; nenhum tipo do
    // Node cobre os dois, então a forma vai declarada — estreitamento, não `any`.
    const err = /** @type {Error & {stdout?: string, stderr?: string}} */ (e);
    saida = err.stdout ?? '';
    erro = String(err.stderr || err.message).split('\n').find(Boolean)?.slice(0, 90) ?? 'falhou';
  }
  const srcs = [];
  for (const l of saida.split('\n')) { const m = SRC_RE.exec(l); if (m) srcs.push(m[1]); }
  // procedência do rewrite: o número muda se veio do cache, do Gemini ao vivo, ou de léxico-só
  // depois de um 429 — e o relatório não dizia qual. Clone novo = outro número, sem aviso.
  const origem = /rewrite=(\S+)/.exec(saida)?.[1] ?? '?';
  return { srcs, bytes: saida.length, erro, origem };
}

// A BASENAME HIT DOES NOT PROVE THE DIRECTORY (2026-08-26). The ruler compared
// `path.basename(src)` against the target: any `utils.py`, `index.ts` or `__init__.py` among the
// 5 returned files counted as a hit, whether it came from the right folder or not. It is the SAME
// defect this repo had already diagnosed and removed from the recency boost ("matching just
// utils.py would crown the wrong file") — it survived inside the instrument that measures the fix.
//
// Now: a target WITH a slash is a root-relative path, matched by path suffix. A target with no
// slash still falls back to basename (the old golden format keeps working), but that hit is
// COUNTED SEPARATELY and printed in the aggregate — a number that does not prove the directory
// must not hide among the ones that do.
/** @param {string} p @returns {string} */
const normSep = (p) => p.split('\\').join('/');

/** @param {string} src @param {string} alvo @returns {boolean} */
const casa = (src, alvo) => {
  const s = normSep(src), a = normSep(alvo);
  return a.includes('/') ? (s === a || s.endsWith('/' + a)) : s.slice(s.lastIndexOf('/') + 1) === a;
};

/** @param {string[]} srcs @param {string[]} alvos @returns {Medida} */
function avalia(srcs, alvos) {
  const idx = srcs.findIndex((s) => alvos.some((a) => casa(s, a)));
  // did the hit come from a target carrying a path? then the directory was verified.
  const soBasename = idx >= 0 && !alvos.some((a) => normSep(a).includes('/') && casa(srcs[idx], a));
  return {
    recall: idx >= 0 ? 1 : 0,
    hit3: idx >= 0 && idx < 3 ? 1 : 0,
    rr: idx >= 0 ? 1 / (idx + 1) : 0,
    nos: srcs.length,
    soBasename: soBasename ? 1 : 0,
  };
}

// THE THREE PATHS OF THE SAME ENGINE (2026-08-25). Not three engines — one engine, measured
// at each of the doors it is actually used through. Until now only the middle one had a number,
// and that number was quoted as if it described the first.
//
//   'chamador'    the caller passes identifiers via --termos. This is the PRODUCTION path.
//   'cache'       nobody passes terms and .rewrite-cache.json answers. This is what this
//                 harness always measured.
//   'sem-rewrite' the engine WITHOUT the term arm, on purpose. The baseline — the only way to
//                 answer "what is the arm worth?", which every heuristic here owes.
//
// The old `--motor=graphify` comparison arm was removed together with the code it drove. The
// two could not be cut separately: this harness's DEFAULT run depended on that flag, so
// removing it only from ask.mjs would have turned it into an unknown argument, silently
// ignored, and the harness would have compared the new engine AGAINST ITSELF — publishing a
// tie with the face of a measurement.
//
// IMPORTANT: run with CEREBRO_CACHE_RO=1 (this harness sets it). Without it, measuring the
// 'chamador' path writes the measurement's own terms into the rewrite cache, and the 'cache'
// arm then returns those same terms — both arms collapse into one number and the baseline dies
// inside the measurement. Caught happening.
/** @type {[string, ModoMotor][]} */
const motores = [['chamador', 'termos'], ['cache', null], ['sem-rewrite', 'baseline']];
/** @type {Record<string, Acumulador>} */
const acc = {};
// PERGUNTA APOSENTADA (04/08/2026): quando o código-alvo é retirado do projeto de propósito, a
// pergunta não vira errada — vira INAPLICÁVEL. Apagá-la faria o recall subir sem nada ter
// melhorado (ajustar a régua pra agradar o resultado). Deixá-la calada é pior: uma pergunta que
// nunca mais passa vira desculpa pronta pro próximo miss REAL ("ah, esse é o conhecido"). Então
// ela fica, falha, e é contada SEPARADO — com os dois números na tela, sempre.
for (const [nome] of motores) acc[nome] = { recall: 0, hit3: 0, rr: 0, nos: 0, erros: 0, origens: {}, aposentadas: 0, recallVivas: 0, hit3Vivas: 0, rrVivas: 0, amputadas: 0, soBasename: 0 };

// AN AMPUTATED ENGINE IS NOT AN ENGINE THAT MISSED (guard added 2026-08-25).
// When no terms are supplied and the cache has no entry, the engine falls back to lexical-only
// and SAYS SO — it prints `rewrite=sem-termos`. This harness did not read that notice, so a
// run without the term arm scored as a plain miss and the engine took the blame for an
// accident. It never fired by luck: the golden set is fully cached.
//
// The wider lesson, written down because it will happen again: a guard written against
// yesterday's amputation does not know the name of today's. The earlier guards here knew
// `falhou` and `sem-chave` — the names produced when the rewrite bridge was a network call.
// When the bridge was replaced by caller-supplied terms, a new failure mode appeared under a
// new name and no guard was watching it.
//
// `desligado` stays OUT on purpose: that is --sem-rewrite, an explicit choice by whoever is
// measuring, and it is exactly how the baseline gets its number.
const AMPUTADAS = new Set(['falhou', 'sem-chave', 'sem-termos']);

const linhas = [];
for (const q of golden) {
  /** @type {Linha} */
  const row = { pergunta: q.pergunta.slice(0, 40), projeto: q.projeto };
  for (const [nome, modo] of motores) {
    // NO TERMS IN TERMS MODE = AMPUTATED, not valid (2026-08-26). Before, a golden question with
    // no `termos` field ran with no flag at all — byte for byte the 'cache' column — and the
    // result was summed into the 'chamador' aggregate. The arm the column exists to measure did
    // not take part. Same artifact CEREBRO_CACHE_RO was born to kill: thermometer reading
    // something else.
    if (modo === 'termos' && !q.termos?.length) {
      row[nome] = { amputada: true };
      acc[nome].amputadas++;
      console.error(`  ~ ${nome} AMPUTATED on "${q.pergunta.slice(0, 30)}": golden entry has no terms`);
      continue;
    }
    const flags = modo === 'baseline' ? ['--sem-rewrite']
      : modo ? ['--termos', q.termos.join(',')] : [];
    const { srcs, erro, origem } = roda(q.pergunta, q.projeto, flags);
    if (erro) {
      // não soma zero: marca ERRO e conta separado, senão "não rodou" vira "errou"
      row[nome] = { erro };
      acc[nome].erros++;
      console.error(`  ! ${nome} falhou em "${q.pergunta.slice(0, 30)}": ${erro}`);
      continue;
    }
    acc[nome].origens[origem] = (acc[nome].origens[origem] ?? 0) + 1;
    if (AMPUTADAS.has(origem)) {
      // out of the aggregate: a number measured without an arm is a property of the accident,
      // not of the engine
      row[nome] = { amputada: true };
      acc[nome].amputadas++;
      console.error(`  ~ ${nome} AMPUTATED on "${q.pergunta.slice(0, 30)}": rewrite=${origem}`);
      continue;
    }
    const m = avalia(srcs, q.alvos);
    row[nome] = m;
    acc[nome].recall += m.recall; acc[nome].hit3 += m.hit3; acc[nome].rr += m.rr; acc[nome].nos += m.nos;
    acc[nome].soBasename += m.soBasename;
    if (q.aposentado) acc[nome].aposentadas++;
    else { acc[nome].recallVivas += m.recall; acc[nome].hit3Vivas += m.hit3; acc[nome].rrVivas += m.rr; }
  }
  linhas.push(row);
}

const N = golden.length;
console.log(`\nRECALL — ${N} perguntas do gabarito [${relGolden}] (ground truth por grep no repo mapeado)\n`);
/** @param {Celula|undefined} m @returns {string} */
// Estreita pela PRESENÇA da chave, não pela verdade do valor: a célula é uma união fechada
// (erro | amputada | medida), e `'erro' in m` é o que diz ao leitor — e ao compilador — qual dos
// três casos está na mão. O ternário encadeado que morava aqui lia igual, mas não distinguia
// "não tem a chave" de "tem a chave com valor falso".
const col = (m) => {
  if (!m) return '     ';
  if ('erro' in m) return 'ERRO       ';
  if ('amputada' in m) return 'AMPUTADA   ';
  return `${m.recall ? '✓' : '·'}${m.hit3 ? '³' : ' '} r${m.rr.toFixed(2)}`;
};
console.log('projeto        pergunta                                  ' + motores.map(([n]) => n.padEnd(12)).join(''));
for (const r of linhas) {
  console.log(r.projeto.padEnd(14) + ' ' + r.pergunta.padEnd(42) + motores.map(([n]) => col(/** @type {Celula|undefined} */ (r[n])).padEnd(12)).join(''));
}
// A régua vai COLADA no agregado, não num rótulo lá em cima: é esta linha que a gente copia pro
// relatório e pra memória, e um número sem a régua ao lado não pertence a série nenhuma.
console.log(`\nAGREGADO [régua: ${relGolden}]:`);
for (const [nome] of motores) {
  const a = acc[nome];
  const validas = N - a.erros - a.amputadas;
  console.log(`  ${nome.padEnd(10)} recall ${a.recall}/${validas} · hit@3 ${a.hit3}/${validas} · MRR ${(a.rr / (validas || 1)).toFixed(3)} · nós/pergunta ${(a.nos / (validas || 1)).toFixed(1)}`);
  if (a.aposentadas) {
    const vivas = validas - a.aposentadas;
    console.log(`  ${' '.repeat(10)} └─ sem as ${a.aposentadas} aposentada(s): recall ${a.recallVivas}/${vivas} · hit@3 ${a.hit3Vivas}/${vivas} · MRR ${(a.rrVivas / (vivas || 1)).toFixed(3)}`);
  }
  // procedência: sem isto o mesmo comando dá números diferentes em máquinas diferentes (cache
  // quente vs clone novo) e o relatório não avisa.
  const proc = Object.entries(a.origens).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (proc) console.log(`  ${' '.repeat(10)} rewrite: ${proc}`);
  if (a.erros) console.log(`  ${' '.repeat(10)} ⚠ ${a.erros} pergunta(s) NÃO RODARAM (erro do motor) — fora do agregado`);
  if (a.amputadas) console.log(`  ${' '.repeat(10)} ~ ${a.amputadas} pergunta(s) AMPUTADAS (sem termos/cache) — fora do agregado`);
  if (a.soBasename) console.log(`  ${' '.repeat(10)} ⚠ ${a.soBasename} acerto(s) casado(s) só por BASENAME — a pasta NÃO foi verificada`);
}
