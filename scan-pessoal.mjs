#!/usr/bin/env node
// scan-pessoal.mjs — rede de segurança do repo PÚBLICO.
//
// Por que existe: em 18/07 um espelhamento manual (`cp` do repo privado pro público) trouxe
// junto um comentário com o caminho pessoal do autor, e foi pro GitHub. O plano MANDAVA
// re-escanear antes do push; o passo humano foi pulado. Passo que depende de lembrar não é
// controle — vira este script.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// O VIGIA ERA O VAZAMENTO (25/08/2026)
//
// Até hoje a lista de padrões pessoais morava AQUI, literal: o nome do autor, e os nomes de
// 14 projetos privados dele, em texto puro num arquivo público. E a linha que pulava este
// arquivo na varredura (`if (arq.endsWith(EU)) continue`) garantia que ele nunca se veria.
//
// Um scanner que se exclui da própria varredura não tem ponto cego por acidente: ele tem um
// ponto cego POR CONSTRUÇÃO, e exatamente no lugar onde os segredos foram escritos. Três
// auditorias passaram por cima disso — inclusive uma que rodou uma rede de padrões mais larga
// que esta, e que copiou a mesma exclusão sem perceber. Quem audita herda o ponto cego da
// ferramenta que audita.
//
// Foi um revisor de fora que viu, na primeira leitura.
//
// CONSERTO: o público carrega só os padrões GENÉRICOS (chave, e-mail, IP, caminho de disco).
// A lista pessoal — nomes, projetos, identificadores internos — vem de um arquivo local que
// NÃO é versionado. Sem ele o vigia continua servindo pra qualquer pessoa; com ele, serve pro
// dono. E este arquivo passou a se varrer também.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// Uso: node scan-pessoal.mjs
// Sai com código 1 se achar qualquer coisa — dá pra plugar num pre-commit hook.
//
// Lista pessoal (opcional): crie `.scan-pessoal.local.json` ao lado deste arquivo, no formato
//   { "identidade": ["seu-usuario", "seunome"], "projetos": ["repo-privado-1", "repo-2"] }
// Ele está no .gitignore. Sem ele, só os padrões genéricos rodam — e o script AVISA, porque
// "não tenho a lista" e "a lista não achou nada" são resultados diferentes.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

// Genéricos: valem pra qualquer pessoa que use este repo, e não revelam nada de ninguém.
const PADROES = [
  [/[A-Za-z]:[\\/](Users|Projetos|projetos)/i, 'caminho absoluto de Windows'],
  [/\/(home|Users)\/[a-z0-9_-]+\//i, 'caminho absoluto de home'],
  [/AIza[0-9A-Za-z_-]{30,}|nvapi-[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{30,}/, 'chave de API'],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{30,}/, 'token de bot do Telegram'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, 'URL com credencial embutida'],
  [/[\w.+-]+@[\w-]+\.(com|net|org|br|io|dev)\b/i, 'e-mail'],
];

// Pessoais: vêm de fora, e o arquivo que os contém não é versionado.
const LOCAL = join(AQUI, '.scan-pessoal.local.json');
let temLista = false;
if (existsSync(LOCAL)) {
  try {
    const cfg = JSON.parse(readFileSync(LOCAL, 'utf8'));
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Palavra inteira, sem distinguir maiúscula. O `\b` evita que "<projeto-privado>" case dentro de
    // "arguments" e transforme o vigia em ruído.
    if (cfg.identidade?.length) PADROES.push([new RegExp(`\\b(${cfg.identidade.map(esc).join('|')})\\b`, 'i'), 'identidade do autor']);
    if (cfg.projetos?.length) PADROES.push([new RegExp(`\\b(${cfg.projetos.map(esc).join('|')})\\b`, 'i'), 'nome de projeto privado']);
    temLista = Boolean(cfg.identidade?.length || cfg.projetos?.length);
  } catch (e) {
    // lista ilegível é FALHA: seguir sem ela seria rodar meio vigia achando que é vigia inteiro
    console.error(`!! ${LOCAL} ilegível (${e.message}) — corrija ou remova. NÃO faça push.`);
    process.exit(1);
  }
}

// Só o que o git de fato publicaria — e isso NÃO é o mesmo que "arquivo rastreado".
//
// PONTO CEGO FECHADO (04/08/2026): antes esta linha era `git ls-files`, que lista apenas o que
// JÁ está rastreado. Arquivo novo e ainda não commitado é invisível pra ele — e arquivo novo é
// exatamente o que está prestes a entrar. Flagrado ao vivo: um cache com centenas de
// identificadores dos projetos privados do dono apareceu aqui não-rastreado, e o scanner
// anunciou "limpo — 13 arquivos rastreados". Ele não disse "não achei nada"; ele disse "não
// olhei" com cara de aprovação. É a doença da casa no único vigia que separa o repo público de
// um vazamento.
//
// `--cached --others --exclude-standard` = rastreados + novos que NÃO estão no .gitignore, ou
// seja, precisamente o que um `git add -A` levaria.
const rastreados = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

let achados = 0;

// ESTE ARQUIVO NÃO SE EXCLUI MAIS. Era a exclusão que escondia o vazamento — e ela só existia
// porque os padrões moravam aqui dentro. Agora que não moram, não há o que esconder.
for (const arq of rastreados) {
  if (/\.(png|jpg|jpeg|gif|pdf|zip|woff2?)$/i.test(arq)) continue;
  let texto;
  // Ilegível é FALHA, não "pula": um binário disfarçado passaria batido, e o silêncio aqui
  // é exatamente o defeito que este script existe pra impedir.
  try { texto = readFileSync(arq, 'utf8'); } catch (e) {
    console.error(`?? ${arq}: não consegui ler (${e.code}) — confira à mão`);
    achados++;
    continue;
  }
  texto.split('\n').forEach((linha, i) => {
    for (const [re, oque] of PADROES) {
      if (!re.test(linha)) continue;
      // trecho truncado: o relatório aponta ONDE está, nunca despeja o segredo inteiro
      console.error(`!! ${arq}:${i + 1} — ${oque}: ${linha.trim().slice(0, 70)}`);
      achados++;
    }
  });
}

if (achados) {
  console.error(`\n${achados} ocorrência(s). NÃO faça push antes de limpar.`);
  process.exit(1);
}
// "não tenho a lista pessoal" e "a lista não achou nada" são resultados DIFERENTES, e sair pela
// mesma porta seria o pecado que este arquivo inteiro existe pra impedir.
console.log(`limpo — ${rastreados.length} arquivos varridos, nada dos padrões genéricos.`);
if (!temLista) {
  console.log('⚠️  sem `.scan-pessoal.local.json`: os padrões PESSOAIS (nome, projetos privados)');
  console.log('   NÃO foram checados. Isto é "não olhei", não "está limpo".');
}
