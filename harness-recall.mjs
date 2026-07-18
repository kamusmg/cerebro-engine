#!/usr/bin/env node
// harness-recall.mjs — mede RECALL do ask.mjs contra o gabarito (reports/golden-questions.json).
//
// A auditoria (18/07) pegou a manchete "8.1x tokens" como frágil: ratio sem sinal fim-a-fim.
// O sinal fim-a-fim é ESTE: numa pergunta real, o arquivo que teria que ser editado aparece
// na resposta do grafo? Se não aparece, o modelo cai no Read-tudo e a economia é zero.
//
// Compara os dois motores (novo próprio × --motor=graphify antigo). Métricas por pergunta:
//   • recall  — algum arquivo-alvo aparece em QUALQUER lugar da saída (top-5 arquivos)
//   • hit@3   — o alvo está entre os 3 primeiros NODE
//   • rank    — posição do 1º NODE-alvo (pra MRR)
//   • nós     — nº de linhas NODE (proxy barato de tokens)
//
// Uso: node harness-recall.mjs            (roda os dois motores)
//      node harness-recall.mjs --so=novo  (só o motor novo)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = import.meta.dirname;
const golden = JSON.parse(fs.readFileSync(path.join(REPO, 'reports', 'golden-questions.json'), 'utf8'));
const args = process.argv.slice(2);
const SO = args.find((a) => a.startsWith('--so='))?.slice(5);

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
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
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

const motores = SO === 'novo' ? [['novo', []]] : [['novo', []], ['graphify', ['--motor=graphify']]];
const acc = {};
for (const [nome] of motores) acc[nome] = { recall: 0, hit3: 0, rr: 0, nos: 0, erros: 0, origens: {} };

const linhas = [];
for (const q of golden) {
  const row = { pergunta: q.pergunta.slice(0, 40), projeto: q.projeto };
  for (const [nome, flags] of motores) {
    const { srcs, erro, origem } = roda(q.pergunta, q.projeto, flags);
    if (erro) {
      // não soma zero: marca ERRO e conta separado, senão "não rodou" vira "errou"
      row[nome] = { erro };
      acc[nome].erros++;
      console.error(`  ! ${nome} falhou em "${q.pergunta.slice(0, 30)}": ${erro}`);
      continue;
    }
    const m = avalia(srcs, q.alvos);
    row[nome] = m;
    acc[nome].origens[origem] = (acc[nome].origens[origem] ?? 0) + 1;
    acc[nome].recall += m.recall; acc[nome].hit3 += m.hit3; acc[nome].rr += m.rr; acc[nome].nos += m.nos;
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
  // procedência: sem isto o mesmo comando dá números diferentes em máquinas diferentes (cache
  // quente vs clone novo) e o relatório não avisa.
  const proc = Object.entries(a.origens).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (proc) console.log(`  ${' '.repeat(10)} rewrite: ${proc}`);
  if (a.erros) console.log(`  ${' '.repeat(10)} ⚠ ${a.erros} pergunta(s) NÃO RODARAM (erro do motor) — fora do agregado`);
}
