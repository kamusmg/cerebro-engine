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
const GOLDEN = path.join(REPO, 'reports', 'golden-questions.json');
let golden;
try {
  golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
} catch (e) {
  const falta = e.code === 'ENOENT';
  console.error(falta
    ? `reports/golden-questions.json not found.\n\nThis file is not shipped — the author's questions point at private repos. To measure\nyour own engine, build a set with the shape of reports/golden-questions.example.json:\neach entry needs { projeto, pergunta, alvos: ["file-that-should-be-found.js"] }.`
    : `golden-questions.json could not be parsed: ${e.message}`);
  process.exit(1);
}

const SRC_RE = /^NODE .+? \[src=(.+?) loc=/;

// Motor QUEBRADO não pode pontuar igual a motor que errou. Antes o catch virava saída vazia e
// o resultado era `recall 0` limpo: numa máquina sem o `graphify` no PATH, o relatório sairia
// "graphify 0/24" e ninguém saberia que ele nunca rodou. Isso é o pecado capital do projeto
// aplicado justamente à métrica que JUSTIFICA o projeto. Agora falha é `erro`, não zero.
function roda(pergunta, projeto, flags) {
  let saida = '';
  let erro = null;
  try {
    saida = execFileSync('node', [path.join(REPO, 'ask.mjs'), pergunta, projeto, ...flags],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000,
        // the thermometer must not change the temperature — see the note above `motores`
        env: { ...process.env, CEREBRO_CACHE_RO: '1' } });
  } catch (e) {
    saida = e.stdout ?? '';
    erro = String(e.stderr || e.message).split('\n').find(Boolean)?.slice(0, 90) ?? 'falhou';
  }
  const srcs = [];
  for (const l of saida.split('\n')) { const m = SRC_RE.exec(l); if (m) srcs.push(path.basename(m[1])); }
  // procedência do rewrite: o número muda se veio do cache, do Gemini ao vivo, ou de léxico-só
  // depois de um 429 — e o relatório não dizia qual. Clone novo = outro número, sem aviso.
  const origem = /rewrite=(\S+)/.exec(saida)?.[1] ?? '?';
  return { srcs, bytes: saida.length, erro, origem };
}

function avalia(srcs, alvos) {
  const idx = srcs.findIndex((s) => alvos.includes(s));
  return {
    recall: idx >= 0 ? 1 : 0,
    hit3: idx >= 0 && idx < 3 ? 1 : 0,
    rr: idx >= 0 ? 1 / (idx + 1) : 0,
    nos: srcs.length,
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
const motores = [['chamador', 'termos'], ['cache', null], ['sem-rewrite', 'baseline']];
const acc = {};
// PERGUNTA APOSENTADA (04/08/2026): quando o código-alvo é retirado do projeto de propósito, a
// pergunta não vira errada — vira INAPLICÁVEL. Apagá-la faria o recall subir sem nada ter
// melhorado (ajustar a régua pra agradar o resultado). Deixá-la calada é pior: uma pergunta que
// nunca mais passa vira desculpa pronta pro próximo miss REAL ("ah, esse é o conhecido"). Então
// ela fica, falha, e é contada SEPARADO — com os dois números na tela, sempre.
for (const [nome] of motores) acc[nome] = { recall: 0, hit3: 0, rr: 0, nos: 0, erros: 0, origens: {}, aposentadas: 0, recallVivas: 0, hit3Vivas: 0, rrVivas: 0, amputadas: 0 };

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
  const row = { pergunta: q.pergunta.slice(0, 40), projeto: q.projeto };
  for (const [nome, modo] of motores) {
    const flags = modo === 'baseline' ? ['--sem-rewrite']
      : modo && q.termos?.length ? ['--termos', q.termos.join(',')] : [];
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
    if (q.aposentado) acc[nome].aposentadas++;
    else { acc[nome].recallVivas += m.recall; acc[nome].hit3Vivas += m.hit3; acc[nome].rrVivas += m.rr; }
  }
  linhas.push(row);
}

const N = golden.length;
console.log(`\nRECALL — ${N} perguntas do gabarito (ground truth por grep no repo mapeado)\n`);
const col = (m) => !m ? '     ' : m.erro ? 'ERRO       ' : `${m.recall ? '✓' : '·'}${m.hit3 ? '³' : ' '} r${m.rr.toFixed(2)}`;
console.log('projeto        pergunta                                  ' + motores.map(([n]) => n.padEnd(12)).join(''));
for (const r of linhas) {
  console.log(r.projeto.padEnd(14) + ' ' + r.pergunta.padEnd(42) + motores.map(([n]) => col(r[n]).padEnd(12)).join(''));
}
console.log('\nAGREGADO:');
for (const [nome] of motores) {
  const a = acc[nome];
  const validas = N - a.erros;
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
}
