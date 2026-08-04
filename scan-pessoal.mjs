#!/usr/bin/env node
// scan-pessoal.mjs — rede de segurança do repo PÚBLICO.
//
// Por que existe: em 18/07 um espelhamento manual (`cp` do repo privado pro público) trouxe
// junto um comentário com o caminho pessoal do autor, e foi pro GitHub. O plano MANDAVA
// re-escanear antes do push; o passo humano foi pulado. Passo que depende de lembrar não é
// controle — vira este script.
//
// Uso: node scan-pessoal.mjs        (escaneia os arquivos RASTREADOS pelo git)
// Sai com código 1 se achar qualquer coisa — dá pra plugar num pre-commit hook.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Cada padrão é "coisa que só existe na máquina/vida do autor e não tem o que fazer num repo
// público". O nome de projeto pessoal entra porque o público é engine-only por desenho.
const PADROES = [
  [/[A-Za-z]:[\\/](Users|Projetos|projetos)/i, 'caminho absoluto de Windows'],
  [/\/(home|Users)\/[a-z0-9_-]+\//i, 'caminho absoluto de home'],
  // `<autor>` entrou em 04/08/2026: o padrão era `\b<autor>\b|<autor>`, e por isso
  // `KamusProfileService` / `kamus_active_window` — identificadores tirados dos repos privados —
  // passavam batido. Scanner que roda, olha e aprova o que deveria pegar é pior que scanner
  // nenhum: produz a confiança sem o controle.
  // O `(?!mg)` não é detalhe: `kamusmg` é o handle PÚBLICO do autor e tem todo o direito de
  // estar no LICENSE, no README e no package.json. Sem essa exceção o vigia reprovava 7 linhas
  // legítimas — e vigia que grita no caso normal ensina o dono a ignorar o vigia.
  [/\b<autor>\b|<autor>|<autor>(?!mg)/i, 'identidade do autor'],
  [/\b(<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|<projeto-privado>|anima|<projeto-privado>)\b/i, 'nome de projeto pessoal'],
  [/AIza[0-9A-Za-z_-]{30,}|nvapi-[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{30,}/, 'chave de API'],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{30,}/, 'token de bot do Telegram'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, 'URL com credencial embutida'],
];

// Só o que o git de fato publicaria — e isso NÃO é o mesmo que "arquivo rastreado".
//
// PONTO CEGO FECHADO (04/08/2026): antes esta linha era `git ls-files`, que lista apenas o que
// JÁ está rastreado. Arquivo novo e ainda não commitado é invisível pra ele — e arquivo novo é
// exatamente o que está prestes a entrar. Flagrado ao vivo: um `.rewrite-cache.json` com 832
// identificadores dos projetos privados do dono (KamusProfileService, kamus_active_window)
// apareceu aqui não-rastreado, e o scanner anunciou "limpo — 13 arquivos rastreados". Ele não
// disse "não achei nada"; ele disse "não olhei" com cara de aprovação. É a doença da casa no
// único vigia que separa o repo público de um vazamento.
//
// `--cached --others --exclude-standard` = rastreados + novos que NÃO estão no .gitignore, ou
// seja, precisamente o que um `git add -A` levaria. Ignorado continua de fora (node_modules,
// projects.json), que era a parte certa do raciocínio original.
const rastreados = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

let achados = 0;
const EU = 'scan-pessoal.mjs'; // a lista de padrões contém as palavras proibidas por definição

for (const arq of rastreados) {
  if (arq.endsWith(EU)) continue;
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
console.log(`limpo — ${rastreados.length} arquivos rastreados, nada pessoal.`);
