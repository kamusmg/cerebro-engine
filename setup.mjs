#!/usr/bin/env node
// setup.mjs — do clone à primeira pergunta, num comando só.
//
//   node setup.mjs                      confere o ambiente e prepara o projects.json
//   node setup.mjs /caminho/do/repo     o acima + registra o repo + indexa + faz a prova real
//
// Por que existe: o caminho manual tinha cinco passos e três deles falhavam calados pra quem
// nunca viu o projeto — instalar um pacote Python a partir de um README em Node, escrever caminho
// ABSOLUTO à mão dentro de um JSON, e lembrar de rodar o indexador antes da primeira pergunta.
// Quem já sabe não erra nenhum; quem está chegando erra os três e não descobre em qual parou.
//
// A REGRA QUE GOVERNA ESTE ARQUIVO: cada passo tem TRÊS desfechos, nunca dois — deu certo, falhou,
// ou não consegui verificar. O terceiro nunca é impresso como o primeiro. Um instalador que diz
// "pronto!" sem ter conferido é pior que um que não existe, porque o erro reaparece três passos
// depois disfarçado de outra coisa.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const GRAPHIFY = process.env.GRAPHIFY_BIN ?? 'graphify';   // mesmo knob que o resto do motor usa
const NODE_MINIMO = 22;
const TIMEOUT_CURTO = 30_000;
const TIMEOUT_INDEX = 900_000;   // indexar repo grande passa de 5 min; 15 é teto, não expectativa

/** @param {string} m */ const ok    = (m) => console.log(`  ✓ ${m}`);
/** @param {string} m */ const falha = (m) => console.log(`  ✗ ${m}`);
/** @param {string} m */ const nao   = (m) => console.log(`  ? ${m}`);  // não consegui verificar — não é ✓
/** @param {string} m */ const info  = (m) => console.log(`    ${m}`);
/** @param {number} n @param {string} m */ const passo = (n, m) => console.log(`\n[${n}] ${m}`);

/**
 * Executa e devolve {saida} ou {erro}. NUNCA lança — quem chama decide o que fazer com a falha,
 * e a falha vem nomeada.
 *
 * `shell` no Windows: o `uv tool install` deixa um `.cmd` em algumas máquinas e um `.exe` em
 * outras. Sem shell, o `.cmd` estoura ENOENT; com shell sempre, argumento com espaço vira
 * roleta de aspas. Então: direto primeiro, shell só como resgate do ENOENT.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [opts]
 * @returns {{saida: string, erro?: undefined} | {erro: string, saida?: undefined}}
 */
function roda(cmd, args, opts = {}) {
  /** @type {import('node:child_process').ExecFileSyncOptions} */
  const base = { encoding: 'utf8', timeout: TIMEOUT_CURTO, stdio: ['ignore', 'pipe', 'pipe'], ...opts };
  try {
    return { saida: String(execFileSync(cmd, args, base) ?? '').trim() };
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' && process.platform === 'win32') {
      try {
        return { saida: String(execFileSync(cmd, args, { ...base, shell: true }) ?? '').trim() };
      } catch (e2) {
        return { erro: classifica(e2) };
      }
    }
    return { erro: classifica(e) };
  }
}

/**
 * "NÃO EXISTE" TEM QUE CONTINUAR SENDO "NÃO EXISTE" DEPOIS DO RESGATE POR SHELL.
 *
 * Pego testando, não deduzido: com `shell: true` no Windows quem responde é o `cmd.exe`, e ele não
 * propaga ENOENT — devolve exit 9009 e a frase "não é reconhecido como um comando interno". O
 * `roda` classificava isso como "existe mas não respondeu", então o setup dizia "não consegui
 * saber" e **nunca chegava a tentar instalar** — o instalador deixava de instalar exatamente no
 * único caso em que ele precisa.
 *
 * O código numérico é o sinal confiável: 9009 no cmd.exe, 127 no shell POSIX. Ambos independem do
 * idioma do Windows, ao contrário da frase — que ainda chega com acento corrompido pelo codepage
 * do console, e por isso é só o último recurso, com regex tolerante.
 */
/** @param {unknown} e @returns {string} */
function classifica(e) {
  // Um erro de spawn no Node carrega três coisas ao mesmo tempo: `code` do libuv, `status` do
  // processo e `stderr` capturado. Nenhum tipo pronto do Node cobre os três juntos, então a
  // forma vai declarada aqui — estreitar `unknown` para ISTO é diferente de aceitar `any`:
  // um typo em `e.statuss` continua sendo erro de compilação.
  const err = /** @type {NodeJS.ErrnoException & {status?: number, stderr?: unknown}} */ (e);
  if (err.code === 'ENOENT') return 'ENOENT';
  if (err.status === 9009 || err.status === 127) return 'ENOENT';
  const txt = String(err.stderr || err.message || err);
  if (/not recognized as an internal|command not found|n.o . reconhecido como um comando/i.test(txt)) return 'ENOENT';
  return txt.trim();
}

/** @param {string} cmd */
const existe = (cmd) => !roda(cmd, ['--version']).erro;

// ---------- 1. Node ----------
function checaNode() {
  passo(1, 'Node');
  const maior = Number(process.versions.node.split('.')[0]);
  if (maior >= NODE_MINIMO) { ok(`Node ${process.versions.node}`); return true; }
  falha(`Node ${process.versions.node} — este motor precisa de ${NODE_MINIMO}+`);
  info('https://nodejs.org — instale a LTS e rode este comando de novo.');
  return false;
}

// ---------- 2. graphify ----------
/** @returns {{estado:'ok', versao:string} | {estado:'falta'} | {estado:'naoSei', motivo:string}} */
function versaoGraphify() {
  const r = roda(GRAPHIFY, ['--version']);
  if (!r.erro) return { estado: 'ok', versao: r.saida ?? 'graphify (versão não informada)' };
  if (r.erro === 'ENOENT') return { estado: 'falta' };
  return { estado: 'naoSei', motivo: r.erro.split('\n')[0] };
}

function instalaGraphify() {
  // Ordem: uv (o que o README recomenda e o mais rápido), pipx (isolado), pip --user (último
  // recurso, sem sudo). Cada tentativa é anunciada ANTES, porque baixar pacote demora e uma tela
  // parada sem explicação parece travamento.
  /** @type {[string, string[], string][]} */
  const tentativas = [
    ['uv',   ['tool', 'install', 'graphifyy'],            'uv tool install graphifyy'],
    ['pipx', ['install', 'graphifyy'],                     'pipx install graphifyy'],
    ['python', ['-m', 'pip', 'install', '--user', 'graphifyy'], 'python -m pip install --user graphifyy'],
    ['python3', ['-m', 'pip', 'install', '--user', 'graphifyy'], 'python3 -m pip install --user graphifyy'],
  ];

  const disponiveis = tentativas.filter(([bin]) => existe(bin));
  if (!disponiveis.length) {
    falha('não achei uv, pipx nem python nesta máquina — não dá pra instalar o graphify daqui');
    info('Instale UM destes e rode o setup de novo:');
    info('  uv     → https://docs.astral.sh/uv/  (recomendado, mais rápido)');
    info('  python → https://python.org  (depois: python -m pip install --user graphifyy)');
    return false;
  }

  for (const [bin, args, humano] of disponiveis) {
    info(`tentando: ${humano}  (pode demorar um minuto)`);
    const r = roda(bin, args, { timeout: TIMEOUT_INDEX, stdio: ['ignore', 'inherit', 'pipe'] });
    if (r.erro) { info(`  não deu por aqui: ${String(r.erro).split('\n')[0]}`); continue; }

    // VERIFICA DEPOIS DE AGIR. "o instalador saiu com 0" não é "o comando existe": o binário pode
    // ter caído numa pasta fora do PATH desta sessão, que é o caso mais comum no Windows.
    const v = versaoGraphify();
    if (v.estado === 'ok') { ok(`graphify ${v.versao} instalado via ${bin}`); return true; }

    falha(`${humano} terminou sem erro, mas o comando \`graphify\` ainda não responde`);
    info('Quase sempre é PATH: o binário existe e esta sessão não o enxerga.');
    info('Feche e reabra o terminal e rode o setup de novo. Se persistir, aponte o caminho:');
    info(process.platform === 'win32'
      ? '  set GRAPHIFY_BIN=C:\\caminho\\completo\\graphify.exe'
      : '  export GRAPHIFY_BIN=/caminho/completo/graphify');
    return false;
  }

  falha('nenhum instalador conseguiu trazer o graphify');
  info('Tente à mão: uv tool install graphifyy');
  return false;
}

function checaGraphify() {
  passo(2, 'graphify (quem indexa o código)');
  const v = versaoGraphify();
  if (v.estado === 'ok')     { ok(v.versao); return true; }
  if (v.estado === 'naoSei') {
    nao(`o comando \`graphify\` existe mas não respondeu ao --version: ${v.motivo}`);
    info('NÃO estou dizendo que está ok nem que está quebrado — não consegui saber.');
    info('Rode `graphify --version` à mão pra ver o que ele diz.');
    return false;
  }
  info('não encontrado — vou tentar instalar');
  return instalaGraphify();
}

// ---------- 3. projects.json ----------
const ARQ_PROJETOS = path.join(REPO, 'projects.json');

/** @returns {{name: string, root: string}[]} */
function leProjetos() {
  if (!fs.existsSync(ARQ_PROJETOS)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(ARQ_PROJETOS, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (err) {
    const e = /** @type {Error} */ (err);
    // Arquivo quebrado NÃO vira lista vazia em silêncio: sobrescrever aqui apagaria os projetos
    // que a pessoa já tinha cadastrado.
    falha(`projects.json existe mas está mal formado: ${e.message}`);
    info('Conserte o JSON à mão (ou apague o arquivo) e rode o setup de novo. Não vou sobrescrever.');
    process.exit(1);
  }
}

function garanteProjectsJson() {
  passo(3, 'projects.json (o registro dos seus repos)');
  if (fs.existsSync(ARQ_PROJETOS)) {
    const n = leProjetos().length;
    ok(`já existe — ${n} projeto(s) cadastrado(s)`);
    return;
  }
  // Começa VAZIO, não com os exemplos: `--lista` mostrando "my-backend" que não existe é ruído
  // que parece cadastro.
  fs.writeFileSync(ARQ_PROJETOS, '[]\n');
  ok('criado vazio (projects.json — o git ignora este arquivo)');
}

/** @param {string} alvo @returns {{name: string, root: string} | null} */
function registraProjeto(alvo) {
  passo(4, 'registrando o projeto');
  const raiz = path.resolve(alvo);
  if (!fs.existsSync(raiz) || !fs.statSync(raiz).isDirectory()) {
    falha(`não é uma pasta: ${raiz}`);
    return null;
  }
  const nome = path.basename(raiz).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const projetos = leProjetos();

  const jaTem = projetos.find((p) => path.resolve(p.root) === raiz);
  if (jaTem) { ok(`já estava cadastrado como "${jaTem.name}"`); return jaTem; }

  const conflito = projetos.find((p) => p.name === nome);
  if (conflito) {
    falha(`já existe um projeto chamado "${nome}" apontando pra ${conflito.root}`);
    info('Renomeie um dos dois à mão no projects.json.');
    return null;
  }

  const novo = { name: nome, root: raiz };
  projetos.push(novo);
  fs.writeFileSync(ARQ_PROJETOS, JSON.stringify(projetos, null, 2) + '\n');
  ok(`"${nome}" → ${raiz}`);
  return novo;
}

// ---------- 5. indexar ----------
/** @param {{name: string, root: string}} projeto */
function indexa(projeto) {
  passo(5, 'indexando (o graphify lê o código e escreve o grafo)');
  const grafo = path.join(projeto.root, 'graphify-out', 'graph.json');
  if (fs.existsSync(grafo)) {
    ok(`grafo já existe — ${(fs.statSync(grafo).size / 1024).toFixed(0)} KB`);
    info('Pra reindexar depois de um refactor: graphify update "' + projeto.root + '"');
    return true;
  }

  info(`graphify update "${projeto.root}"`);
  info('Repo grande leva alguns minutos. A saída do graphify vem abaixo:');
  const r = spawnSync(GRAPHIFY, ['update', projeto.root], {
    stdio: 'inherit', timeout: TIMEOUT_INDEX, shell: process.platform === 'win32',
  });

  if (r.error)  { falha(`não consegui rodar o graphify: ${r.error.message}`); return false; }
  if (r.status !== 0) { falha(`graphify saiu com código ${r.status}`); return false; }

  // De novo: saiu 0 não é "o grafo existe".
  if (!fs.existsSync(grafo)) {
    falha('o graphify terminou sem erro, mas não achei o graph.json');
    info(`Esperava em: ${grafo}`);
    return false;
  }
  ok(`grafo escrito — ${(fs.statSync(grafo).size / 1024).toFixed(0)} KB`);
  return true;
}

// ---------- 6. a prova ----------
/** @param {{name: string, root: string}} projeto */
function provaReal(projeto) {
  passo(6, 'a prova (uma pergunta de verdade, não um "pronto!")');
  const r = roda(process.execPath, [
    path.join(REPO, 'ask.mjs'), 'where is the entry point of this project', projeto.name,
    '--termos', 'main,init,entry,start,setup',
  ], { timeout: 120_000 });

  if (r.erro) { falha(`a pergunta não rodou: ${String(r.erro).split('\n')[0]}`); return false; }
  const saida = r.saida ?? '';
  const nos = (saida.match(/^NODE /gm) ?? []).length;
  if (nos === 0) {
    nao('a pergunta rodou mas não devolveu nó nenhum');
    info('Não é necessariamente defeito: repo minúsculo, ou os termos não casaram com este código.');
    info('Tente uma pergunta sua com --termos que existam no código:');
    info(`  node ask.mjs "sua pergunta" ${projeto.name} --termos "ident1,ident2"`);
    return false;
  }
  ok(`${nos} nós devolvidos — o motor está de pé`);
  for (const l of saida.split('\n').filter((x) => x.startsWith('NODE ')).slice(0, 3)) info(l);
  return true;
}

// ---------- fluxo ----------
console.log('cerebro-engine · setup\n' + '─'.repeat(46));

if (!checaNode()) process.exit(1);
if (!checaGraphify()) process.exit(1);
garanteProjectsJson();

const alvo = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (!alvo) {
  console.log('\n' + '─'.repeat(46));
  console.log('Ambiente pronto. Falta apontar um repositório:\n');
  console.log('  node setup.mjs /caminho/absoluto/do/seu-repo\n');
  console.log('Isso registra, indexa e faz uma pergunta de verdade pra provar que funciona.');
  process.exit(0);
}

const projeto = registraProjeto(alvo);
if (!projeto) process.exit(1);
if (!indexa(projeto)) process.exit(1);
const provou = provaReal(projeto);

console.log('\n' + '─'.repeat(46));
if (provou) {
  console.log(`Pronto. Pergunte ao grafo de "${projeto.name}":\n`);
  console.log(`  node ask.mjs "onde valida o token" ${projeto.name} --termos "auth,token,validate"\n`);
  console.log('SEMPRE passe --termos: são 4-10 identificadores em inglês que você espera achar NO');
  console.log('CÓDIGO. Você traduz melhor que qualquer ponte automática, porque conhece a conversa —');
  console.log('e medido, o braço de termos vale 3 a 4 respostas a mais. Via MCP o modelo preenche');
  console.log('sozinho; veja o README.');
} else {
  console.log('Ambiente e índice OK, mas a prova final não fechou — leia o passo 6 acima.');
  console.log('Nada aqui está "quase pronto": ou a pergunta devolve nó, ou não devolve.');
  process.exit(1);
}
