#!/usr/bin/env node
// generate-golden.mjs — gera gabarito sintético de benchmark a partir de qualquer graph.json.
//
// Por que existe: o `harness-recall.mjs` original dependia de um gabarito privado do autor
// (perguntas sobre código fechado que não podem ser publicadas). Isso tornava o benchmark
// público não reproduzível por quem clona o repositório.
//
// Esta ferramenta resolve o vão: analisa o `graph.json` de qualquer projeto (seja público ou
// local) e gera automaticamente um `reports/golden-questions.synthetic.json` com perguntas
// sintéticas realistas extraídas de:
//   1. Docstrings e anotações explicativas (`rationale_for`) ligadas aos símbolos
//   2. Funções, classes e métodos descritivos (bem-nomeados) com amostragem balanceada por arquivo
//
// As perguntas geradas incluem:
//   • `projeto`: nome do projeto configurado no projects.json
//   • `pergunta`: formulação em linguagem natural (PT/EN) da busca
//   • `alvos`: basename do arquivo fonte que define o símbolo (ground truth exato do grafo)
//   • `termos`: identificadores-chave para testar o braço `--termos` (chamador)
//   • `nota`: procedência do nó sintético (símbolo, comunidade, tipo de extração)
//
// O QUE ESTE GABARITO NAO E: CEGO.
// As perguntas saem das docstrings e dos simbolos do MESMO `graph.json` que o motor consulta pra
// responder. O vocabulario casa por construcao, e o alvo e, por definicao, um no que o grafo ja
// conhece — nenhuma das duas coisas vale pra um gabarito escrito a mao por quem usa o projeto.
// Numero saido daqui mede COBERTURA e serve de guarda de regressao: se cair de uma versao pra
// outra, alguma coisa quebrou. Ele NAO e comparavel com os numeros publicados no README, que vem
// de um conjunto cego, e nao responde "o motor acha o que EU procuro". Pra isso, escreva as
// perguntas antes de olhar o grafo — `reports/golden-questions.example.json` tem o formato.
//
// Uso:
//   node generate-golden.mjs [projeto-ou-caminho-grafo] [--projeto <nome>] [--out <caminho>] [--limit 24] [--seed 42]
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {import('./types.d.ts').Node} Node
 * @typedef {import('./types.d.ts').RawGraph} RawGraph
 * @typedef {import('./types.d.ts').ProjectConfig} ProjectConfig
 *
 * @typedef {object} Candidato
 * @property {string} projeto
 * @property {string} pergunta
 * @property {string[]} alvos
 * @property {string[]} termos
 * @property {string} tipo
 * @property {number} scoreQualidade
 * @property {string|number} comunidade
 * @property {string|undefined} sourceFile
 * @property {string} simbolo
 * @property {string} nota
 *
 * A entrada do gabarito é MAIS ESTREITA que o candidato: só o que o harness lê.
 * @typedef {Pick<Candidato, 'projeto'|'pergunta'|'alvos'|'termos'|'nota'>} EntradaGolden
 */

// ---------- PRNG determinístico (Mulberry32) pra benchmarks reproduzíveis ----------
/**
 * @param {number} seed
 * @returns {() => number} gerador no intervalo [0,1)
 */
function criaPrng(seed) {
  let s = Math.trunc(seed) >>> 0;
  return function random() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @template T
 * @param {T[]} array
 * @param {() => number} rng
 * @returns {T[]} cópia embaralhada — a entrada não é tocada
 */
function embaralha(array, rng) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Utilitários de texto e identificadores ----------
/** @param {unknown} s @returns {string} */
const semAcento = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** @param {unknown} s @returns {string} */
const normaliza = (s) => semAcento(String(s).toLowerCase().trim());

// Quebra camelCase, snake_case e kebab-case em palavras individuais
/** @param {unknown} s @returns {string[]} */
function extraiPalavras(s) {
  return semAcento(String(s))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._\-:/\\()]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
}

// Limpa docstrings/comentários removendo marcadores e tags JSDoc/Sphinx/Rustdoc
/** @param {unknown} raw @returns {string} */
function limpaDocstring(raw) {
  if (!raw) return '';
  const semTags = String(raw)
    .replace(/\/\*+|\*+\/|^\s*\* ?/gm, '')       // /* ... */
    .replace(/^\s*\/\/\/?\s?/gm, '')            // // ou ///
    .replace(/^\s*#\s?/gm, '')                  // #
    .replace(/^["']{3}|["']{3}$/gm, '')         // """ ou '''
    .replace(/@\w+\s*\{[^}]*\}|\b@\w+\b/g, '')  // @param, @returns, etc.
    .replace(/:\w+:.*$/gm, '')                  // :param foo: ...
    .replace(/\b(Args|Returns|Raises|Example|Note):\s*$/gim, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')          // inline code blocks
    .replace(/https?:\/\/\S+/g, '')             // URLs
    .replace(/\s+/g, ' ')
    .trim();

  if (semTags.length < 10) return '';

  // Pega a primeira frase significativa
  const primeiraFrase = semTags.split(/[.\n!?](?:\s|$)/)[0]?.trim() ?? '';
  const candidata = primeiraFrase.length >= 10 ? primeiraFrase : semTags;
  return candidata.slice(0, 140).trim();
}

// Filtro de identificadores genéricos ou utilitários vazios de sinal
const GENERICOS = new Set([
  'index', 'utils', 'util', 'helper', 'helpers', 'main', 'misc', 'const', 'config',
  'schema', 'types', 'type', 'models', 'model', 'get', 'set', 'run', 'test', 'data',
  'item', 'items', 'handler', 'handle', 'temp', 'tmp', 'app', 'exec', 'init', 'create',
  'update', 'delete', 'remove', 'process', 'render', 'props', 'state', 'value', 'node',
]);

const EXTENSOES_CODIGO = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.vue',
  '.svelte', '.zig', '.scala', '.sh', '.bash',
]);

// ---------- Resolução de projeto e caminho do grafo ----------
/** @param {string[]} args @returns {{grafoPath: string|null, projNome: string|null}} */
function descobreGrafoEProjeto(args) {
  const pos = args.filter((a) => !a.startsWith('-'));
  const argAlvo = pos[0];

  const iProj = args.indexOf('--projeto');
  const nomeProjFlag = iProj >= 0 && args[iProj + 1] ? args[iProj + 1] : null;

  /** @type {ProjectConfig[]} */
  let projectsList = [];
  const projectsFile = path.join(REPO, 'projects.json');
  if (fs.existsSync(projectsFile)) {
    try {
      projectsList = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    } catch { /* ignora se corrompido */ }
  }

  // 1. Alvo explícito passado como caminho direto para arquivo .json
  if (argAlvo && argAlvo.endsWith('.json') && fs.existsSync(argAlvo)) {
    const grafoPath = path.resolve(argAlvo);
    const projNome = nomeProjFlag || path.basename(path.dirname(path.dirname(grafoPath))) || 'projeto';
    return { grafoPath, projNome };
  }

  // 2. Alvo explícito correspondente a projeto em projects.json
  if (argAlvo && projectsList.length > 0) {
    const match = projectsList.find((p) => p.name === argAlvo)
      ?? projectsList.find((p) => p.name.toLowerCase().includes(argAlvo.toLowerCase()))
      ?? projectsList.find((p) => p.root && p.root.toLowerCase().includes(argAlvo.toLowerCase()));

    if (match) {
      const g = path.join(match.root, 'graphify-out', 'graph.json');
      if (fs.existsSync(g)) {
        return { grafoPath: g, projNome: match.name };
      }
    }
  }

  // 3. Alvo explícito como diretório
  if (argAlvo && fs.existsSync(argAlvo) && fs.statSync(argAlvo).isDirectory()) {
    const g1 = path.join(argAlvo, 'graphify-out', 'graph.json');
    const g2 = path.join(argAlvo, 'graph.json');
    const grafoPath = fs.existsSync(g1) ? g1 : fs.existsSync(g2) ? g2 : null;
    if (grafoPath) {
      const projNome = nomeProjFlag || path.basename(path.resolve(argAlvo));
      return { grafoPath, projNome };
    }
  }

  // ALVO QUE NAO CASA NAO PODE VIRAR OUTRO PROJETO (26/08/2026). O comentario abaixo sempre disse
  // "se nao passou alvo" — mas nao existia o `if (!argAlvo)`, entao um nome desconhecido caia
  // aqui e levava o PRIMEIRO projeto da lista. Medido: `generate-golden.mjs projeto-que-nao-existe`
  // gerava um gabarito inteiro do <projeto-privado>, saia com codigo 0, e nada avisava. Gabarito do
  // projeto errado e pior que gabarito nenhum: ele mede, publica numero, e o numero nao e do que
  // voce pediu.
  // 4. SÓ quando não passou alvo: o primeiro projeto da lista que tenha grafo.
  //
  // O `if (!argAlvo)` é o conserto de 26/08/2026. O comentário sempre disse "se não passou alvo",
  // mas a condição não existia: um nome desconhecido caía aqui e levava o PRIMEIRO projeto da
  // lista. Medido antes do conserto: `generate-golden.mjs projeto-que-nao-existe` gerava um
  // gabarito inteiro do <projeto-privado> e saía com código 0. Gabarito do projeto errado é pior que
  // gabarito nenhum — ele mede, publica número, e o número não é do que você pediu.
  if (!argAlvo) {
    for (const p of projectsList) {
      if (!p.root) continue;
      const g = path.join(p.root, 'graphify-out', 'graph.json');
      if (fs.existsSync(g)) {
        return { grafoPath: g, projNome: p.name };
      }
    }
  }

  // 5. Fallback local em ./graphify-out/graph.json
  // 5. Grafo do próprio repositório. Vale sem alvo — e também COM alvo, desde que o alvo seja o
  // nome desta pasta: é assim que `generate-golden.mjs cerebro-engine` funciona, já que este repo
  // não se registra no próprio projects.json. Qualquer outro nome não resolvido cai fora.
  const nomeLocal = path.basename(REPO);
  const localGrafo = path.join(REPO, 'graphify-out', 'graph.json');
  if ((!argAlvo || argAlvo === nomeLocal) && fs.existsSync(localGrafo)) {
    return { grafoPath: localGrafo, projNome: nomeProjFlag || nomeLocal };
  }

  return { grafoPath: null, projNome: null };
}

// ---------- Geração de perguntas sintéticas ----------
/**
 * @param {RawGraph} grafo
 * @param {string} nomeProjeto
 * @returns {Candidato[]}
 */
export function extraiCandidatos(grafo, nomeProjeto) {
  const nodes = grafo.nodes ?? [];
  const links = grafo.links ?? [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rationaleNodes = new Map(); // targetId -> Array<{ docstring: string, source: any }>
  const freqPorLabel = new Map();

  // Mapeia links de rationale e conta frequência de rótulos
  for (const l of links) {
    if (l.relation === 'rationale_for') {
      const src = byId.get(l.source);
      if (src && src.label) {
        const limpo = limpaDocstring(src.label);
        if (limpo) {
          if (!rationaleNodes.has(l.target)) rationaleNodes.set(l.target, []);
          rationaleNodes.get(l.target).push({ docstring: limpo, srcNode: src });
        }
      }
    }
  }

  for (const n of nodes) {
    if (n.file_type !== 'code' || !n.source_file) continue;
    const lbl = normaliza(n.label).replace(/\(\)$/, '');
    freqPorLabel.set(lbl, (freqPorLabel.get(lbl) ?? 0) + 1);
  }

  const candidatos = [];

  // Templates de variação de pergunta em Português e Inglês
  /** @type {((d: string) => string)[]} */
  const templatesDocstringPT = [
    (d) => d,
    (d) => `onde fica ${d.toLowerCase()}`,
    (d) => `lógica de ${d.toLowerCase()}`,
    (d) => `como é feito ${d.toLowerCase()}`,
  ];

  /** @type {((d: string) => string)[]} */
  const templatesDocstringEN = [
    (d) => d,
    (d) => `where is ${d.toLowerCase()}`,
    (d) => `how ${d.toLowerCase()} is implemented`,
    (d) => `handles ${d.toLowerCase()}`,
  ];

  /** @type {((w: string) => string)[]} */
  const templatesSimboloPT = [
    (w) => `onde fica a função ${w}`,
    (w) => `onde a lógica de ${w} é implementada`,
    (w) => `qual arquivo cuida de ${w}`,
    (w) => `responsável por ${w}`,
    (w) => w,
  ];

  /** @type {((w: string) => string)[]} */
  const templatesSimboloEN = [
    (w) => `where is ${w} implemented`,
    (w) => `function that handles ${w}`,
    (w) => `how ${w} works`,
    (w) => `responsible for ${w}`,
    (w) => w,
  ];

  let seq = 0;

  for (const n of nodes) {
    if (n.file_type !== 'code' || !n.source_file) continue;

    const ext = path.extname(n.source_file).toLowerCase();
    if (!EXTENSOES_CODIGO.has(ext)) continue;

    const targetFile = path.basename(n.source_file);
    if (!targetFile || targetFile.includes('node_modules') || targetFile.includes('dist')) continue;

    const rawLabel = String(n.label || '').trim();
    if (!rawLabel || rawLabel.length < 3) continue;

    const cleanLabel = rawLabel.replace(/^[\.\_]+/, '').replace(/\(\)$/, '');
    const words = extraiPalavras(cleanLabel);
    const idNorm = normaliza(cleanLabel);

    // Multi-definição (>5 arquivos) torna o símbolo fraco para ground truth
    if ((freqPorLabel.get(idNorm) ?? 0) > 5) continue;

    // Identificador genérico sem docstring é descartado
    const ehGenerico = words.length <= 1 && (GENERICOS.has(idNorm) || cleanLabel.length < 6);

    // 1. Candidato via Docstring / Rationale
    const rationales = rationaleNodes.get(n.id) ?? [];
    for (const rat of rationales) {
      const doc = rat.docstring;
      if (!doc || doc.length < 12) continue;

      const termos = [...new Set([...words, cleanLabel, ...extraiPalavras(doc).slice(0, 4)])].filter(Boolean);
      const isPT = /[ãáàâéêíóôõúç]/i.test(doc) || /\b(onde|para|com|não|que|função|sistema|tela|banco)\b/i.test(doc);
      const tpls = isPT ? templatesDocstringPT : templatesDocstringEN;
      const tpl = tpls[seq % tpls.length];
      const pergunta = tpl(doc);

      candidatos.push({
        projeto: nomeProjeto,
        pergunta,
        alvos: [targetFile],
        termos: termos.slice(0, 6),
        tipo: 'rationale',
        scoreQualidade: 10 + Math.min(doc.length / 10, 10),
        comunidade: n.community ?? n.community_name ?? 0,
        sourceFile: n.source_file,
        simbolo: rawLabel,
        nota: `synthetic from docstring of ${rawLabel} in ${targetFile}`,
      });
      seq++;
    }

    // 2. Candidato via Símbolo de Código Descritivo (se não for genérico)
    if (!ehGenerico && words.length >= 2 && cleanLabel.length >= 7) {
      const termos = [...new Set([...words, cleanLabel])].filter(Boolean);
      const palavrasTexto = words.join(' ');

      // Alterna entre formulações PT e EN
      const usePT = (seq % 2 === 0);
      const tpls = usePT ? templatesSimboloPT : templatesSimboloEN;
      const tpl = tpls[Math.floor(seq / 2) % tpls.length];
      const pergunta = tpl(palavrasTexto);

      candidatos.push({
        projeto: nomeProjeto,
        pergunta,
        alvos: [targetFile],
        termos: termos.slice(0, 5),
        tipo: 'simbolo',
        scoreQualidade: 5 + Math.min(words.length * 2, 8),
        comunidade: n.community ?? n.community_name ?? 0,
        sourceFile: n.source_file,
        simbolo: rawLabel,
        nota: `synthetic from symbol ${rawLabel} [community ${n.community ?? '?'}]`,
      });
      seq++;
    }
  }

  return candidatos;
}

// Seleciona e balanceia um conjunto representativo de perguntas
/**
 * @param {Candidato[]} candidatos
 * @param {{limite?: number, seed?: number}} [opts]
 * @returns {EntradaGolden[]}
 */
export function selecionaGoldenSet(candidatos, { limite = 24, seed = 42 } = {}) {
  const rng = criaPrng(seed);
  const embaralhados = embaralha(candidatos, rng);

  // Ordena com peso para qualidade + diversidade
  embaralhados.sort((a, b) => b.scoreQualidade - a.scoreQualidade);

  const selecionados = [];
  const perguntasVistas = new Set();
  const contagemPorArquivo = new Map();
  const maxPorArquivo = 2; // Garante diversidade de arquivos alvos

  // Primeiro passo: prioriza rationale e símbolos de alta qualidade com limite por arquivo
  for (const c of embaralhados) {
    if (selecionados.length >= limite) break;

    const normP = normaliza(c.pergunta);
    if (perguntasVistas.has(normP)) continue;

    const arq = c.alvos[0];
    const qtdArq = contagemPorArquivo.get(arq) ?? 0;
    if (qtdArq >= maxPorArquivo) continue;

    perguntasVistas.add(normP);
    contagemPorArquivo.set(arq, qtdArq + 1);
    selecionados.push({
      projeto: c.projeto,
      pergunta: c.pergunta,
      alvos: c.alvos,
      termos: c.termos,
      nota: c.nota,
    });
  }

  // Segundo passo: se ainda não bateu o limite, relaxa o limite por arquivo
  if (selecionados.length < limite) {
    for (const c of embaralhados) {
      if (selecionados.length >= limite) break;

      const normP = normaliza(c.pergunta);
      if (perguntasVistas.has(normP)) continue;

      perguntasVistas.add(normP);
      selecionados.push({
        projeto: c.projeto,
        pergunta: c.pergunta,
        alvos: c.alvos,
        termos: c.termos,
        nota: c.nota,
      });
    }
  }

  return selecionados;
}

// ---------- Execução CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Uso: node generate-golden.mjs [projeto-ou-grafo.json] [opções]

Gera um arquivo reports/golden-questions.synthetic.json a partir do graph.json de um projeto
para permitir benchmark cego do harness-recall.mjs sem depender de gabarito privado.

Opções:
  --projeto <nome>   Nome do projeto (caso não detectado automaticamente)
  --out <caminho>    Caminho do arquivo de saída (padrão: reports/golden-questions.synthetic.json)
  --limit <N>        Número máximo de perguntas a gerar (padrão: 24)
  --seed <S>         Seed para gerador de números aleatórios reproduzível (padrão: 42)
  --help, -h         Exibe esta mensagem de ajuda

Exemplos:
  node generate-golden.mjs
  node generate-golden.mjs meu-projeto
  node generate-golden.mjs /caminho/para/graphify-out/graph.json --projeto meu-app
  node generate-golden.mjs --limit 30 --out reports/meu-gabarito.json
`);
    process.exit(0);
  }

  const iOut = args.indexOf('--out');
  const outPath = iOut >= 0 && args[iOut + 1]
    ? path.resolve(args[iOut + 1])
    : path.join(REPO, 'reports', 'golden-questions.synthetic.json');

  const iLimit = args.indexOf('--limit');
  const limite = iLimit >= 0 && Number(args[iLimit + 1]) ? Number(args[iLimit + 1]) : 24;

  const iSeed = args.indexOf('--seed');
  const seed = iSeed >= 0 && Number(args[iSeed + 1]) ? Number(args[iSeed + 1]) : 42;

  const { grafoPath, projNome } = descobreGrafoEProjeto(args);

  // projNome entra na guarda junto com o grafoPath (26/08/2026): os dois saem nulos no mesmo
  // ramo do descobreGrafoEProjeto, mas so um estava conferido. O typecheck apontou.
  if (!grafoPath || !projNome || !fs.existsSync(grafoPath)) {
    console.error(`Erro: graph.json não encontrado.\n
Especifique o caminho do grafo ou o nome do projeto configurado em projects.json:
  node generate-golden.mjs <caminho/para/graph.json> --projeto <nome>
  node generate-golden.mjs <nome-do-projeto>
`);
    process.exit(1);
  }

  console.log(`Analisando grafo: ${grafoPath}`);
  console.log(`Projeto: ${projNome}`);

  let grafo;
  try {
    grafo = JSON.parse(fs.readFileSync(grafoPath, 'utf8'));
  } catch (e) {
    console.error(`Falha ao ler graph.json: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }

  const candidatos = extraiCandidatos(grafo, projNome);
  console.log(`Candidatos extraídos: ${candidatos.length} nós válidos (docstrings e símbolos de código)`);

  if (candidatos.length === 0) {
    console.error('Nenhum candidato a pergunta sintética pôde ser extraído do grafo.');
    process.exit(1);
  }

  const selecionados = selecionaGoldenSet(candidatos, { limite, seed });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(selecionados, null, 2) + '\n', 'utf8');

  const arquivosAlvo = new Set(selecionados.map((s) => s.alvos[0]));
  const relOut = path.relative(REPO, outPath);

  console.log(`\n✓ Gabarito sintético gerado com sucesso em: ${relOut}`);
  console.log(`  • Total de perguntas: ${selecionados.length}`);
  console.log(`  • Arquivos únicos cobertos: ${arquivosAlvo.size}`);
  console.log(`\nPara rodar o benchmark com este gabarito:\n  node harness-recall.mjs\n`);
}
