#!/usr/bin/env node
// @ts-check
// mcp-server.mjs — expõe o motor de retrieval como um servidor MCP (Model Context Protocol)
// sobre stdio. Com isso o cerebro-engine vira ferramenta NATIVA de qualquer IA que fala MCP
// (Claude Desktop, Cursor, Antigravity, etc.) — em vez de um CLI que a IA tem que rodar no bash
// e parsear texto na mão.
//
// Zero dependência: o protocolo MCP (JSON-RPC 2.0 newline-delimited) é implementado à mão,
// porque o projeto é vanilla por escolha. Regra de ouro: stdout é SÓ do JSON-RPC — todo log
// vai pra stderr, senão o cliente MCP quebra.
//
// Configurar no cliente (ex.: Claude Desktop, em claude_desktop_config.json):
//   "cerebro-engine": { "command": "node", "args": ["/caminho/pro/mcp-server.mjs"] }
import { readFileSync, existsSync, statSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { consultar, formata, resumoAmplo, carregaGrafo } from './retrieval.mjs';

/**
 * @typedef {import('./types.d.ts').ProjectConfig} ProjectConfig
 * @typedef {import('./types.d.ts').GrafoCacheEntry} GrafoCacheEntry
 * @typedef {import('./types.d.ts').Graph} Graph
 * @typedef {import('./types.d.ts').QueryResult} QueryResult
 * @typedef {import('./types.d.ts').AskGraphArgs} AskGraphArgs
 * @typedef {import('./types.d.ts').MCPRequest} MCPRequest
 * @typedef {import('./types.d.ts').MCPResponse} MCPResponse
 * @typedef {import('./types.d.ts').MCPToolCall} MCPToolCall
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
/** @param {...unknown} m */
const log = (...m) => process.stderr.write(m.join(' ') + '\n'); // NUNCA stdout

/** @type {ProjectConfig[]} */
let projetos = [];
try {
  projetos = JSON.parse(readFileSync(join(ROOT, 'projects.json'), 'utf8'));
} catch (err) {
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  if (e.code === 'ENOENT') {
    log('projects.json não encontrado — copie projects.example.json e liste seus repos. list_projects virá vazio.');
  } else {
    log(`[cerebro-engine] erro ao ler ou parsear projects.json (${e.message}) — list_projects virá vazio.`);
  }
}

/**
 * @param {string} alvo
 * @returns {ProjectConfig | undefined}
 */
const acha = (alvo) =>
  projetos.find((p) => p.name === alvo)
  ?? projetos.find((p) => p.name.includes(String(alvo).toLowerCase()))
  ?? projetos.find((p) => p.root.toLowerCase().includes(String(alvo).toLowerCase()));

/**
 * @param {ProjectConfig} p
 * @returns {string}
 */
const grafoDe = (p) => join(p.root, 'graphify-out', 'graph.json');

// ---------- Cache em memória do grafo AST indexado ----------
// Evita fs.readFileSync + JSON.parse + montagem de Maps/Sets a cada chamada de ask_graph.
// Invalidação híbrida: reativa via fs.watch (notificação instantânea) + verificação de mtime (consistência estrita).
/** @type {Map<string, GrafoCacheEntry>} */
const grafoCache = new Map(); // grafoPath -> { grafo, mtimeMs, watcher }

/**
 * @param {GrafoCacheEntry | undefined} entry
 * @returns {void}
 */
function fechaWatcher(entry) {
  if (entry?.watcher) {
    try {
      entry.watcher.close();
    } catch (err) {
      const e = /** @type {Error} */ (err);
      log(`[cache] aviso ao fechar watcher: ${e.message}`);
    }
    entry.watcher = null;
  }
}

/**
 * @param {string} grafoPath
 * @returns {void}
 */
function invalidaGrafo(grafoPath) {
  const entry = grafoCache.get(grafoPath);
  if (entry) {
    fechaWatcher(entry);
    grafoCache.delete(grafoPath);
    log(`[cache] grafo invalidado: ${grafoPath}`);
  }
}

/**
 * @param {string} grafoPath
 * @returns {Graph}
 */
function obterGrafo(grafoPath) {
  const stat = statSync(grafoPath);
  const cached = grafoCache.get(grafoPath);

  // Cache hit: mtime inalterado -> retorna estrutura já indexada em RAM
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.grafo;
  }

  // Cache miss / stale: limpa watcher anterior se existir
  if (cached) {
    fechaWatcher(cached);
  }

  log(`[cache] carregando grafo na memória: ${grafoPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  const t0 = performance.now();
  const grafo = carregaGrafo(grafoPath);
  const duracaoMs = (performance.now() - t0).toFixed(1);
  log(`[cache] grafo carregado e indexado em ${duracaoMs}ms (${grafo.nodes.length} nós)`);

  // fs.watch no diretório pai para capturar atualizações diretas e substituições atômicas (rename)
  /** @type {import('node:fs').FSWatcher | null} */
  let watcher = null;
  try {
    const dirGrafo = dirname(grafoPath);
    watcher = watch(dirGrafo, (eventType, filename) => {
      if (!filename || filename === 'graph.json' || filename.endsWith('graph.json')) {
        invalidaGrafo(grafoPath);
      }
    });
    if (watcher.unref) watcher.unref();
    watcher.on('error', (err) => {
      log(`[cache] erro no watcher de ${grafoPath}: ${err.message}`);
      invalidaGrafo(grafoPath);
    });
  } catch (err) {
    const e = /** @type {Error} */ (err);
    // Fallback: se fs.watch falhar por limitação de SO/permissão, a verificação de mtime garante consistência
    log(`[cache] aviso: fs.watch não disponível para ${grafoPath} (${e.message}) — usando verificação por mtime`);
  }

  grafoCache.set(grafoPath, {
    grafo,
    mtimeMs: stat.mtimeMs,
    watcher,
  });

  return grafo;
}

const TOOLS = [
  {
    name: 'ask_graph',
    description: 'Ask a project\'s code graph WHERE something lives. Returns the few files/symbols that answer it, so you read those instead of many files. ALWAYS pass "terms": you know the codebase and the conversation, so you translate the question into likely code identifiers better than any bridge could — without them this falls back to plain lexical matching. The graph is an INDEX — confirm in the real file before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language question, e.g. "where is the auth token validated".' },
        project: { type: 'string', description: 'Project name (call list_projects to see the options).' },
        terms: {
          type: 'array',
          items: { type: 'string' },
          description: '4-10 identifiers you expect to find IN THE CODE for this question — English, snake_case/camelCase, e.g. ["validate_token","auth_middleware","jwt_verify"]. If the question is in another language, translate the concepts to code English (legenda→subtitle/caption). Omit only if you truly have no guess.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'graph', 'summary'],
          description: 'auto (default): project-wide questions get the cached summary, everything else traverses the graph. graph: always traverse (use when auto gave you a summary but you wanted specific files). summary: force the project summary.',
        },
      },
      required: ['question', 'project'],
    },
  },
  {
    name: 'list_projects',
    description: 'List the projects that currently have a code graph available to query.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * @param {string|undefined} name
 * @param {Record<string, unknown>|AskGraphArgs|undefined} [args]
 * @returns {Promise<string>}
 */
async function chamaFerramenta(name, args) {
  if (name === 'list_projects') {
    const com = projetos.filter((p) => existsSync(grafoDe(p))).map((p) => `- ${p.name}`);
    return com.length ? `Projects with a graph:\n${com.join('\n')}` : 'No project has a graph yet. Run `graphify update <path>` and add it to projects.json.';
  }
  if (name === 'ask_graph') {
    const { question, project, terms, mode = 'auto' } = /** @type {AskGraphArgs} */ (args ?? {});
    if (!question || !project) throw new Error('both "question" and "project" are required');
    const p = acha(project);
    if (!p) throw new Error(`project "${project}" not found — call list_projects`);
    const grafo = grafoDe(p);
    if (!existsSync(grafo)) throw new Error(`${p.name} has no graph yet — run: graphify update "${p.root}"`);
    // mesmo portão do CLI (o `mode` é o equivalente do --grafo: sem ele, uma IA que caísse no
    // resumo sem querer não tinha como pedir a travessia).
    if (mode !== 'graph') {
      const resumo = resumoAmplo(question, p.name, mode === 'summary');
      if (resumo) return resumo;
      if (mode === 'summary') throw new Error(`${p.name} has no cached summary yet — use mode "graph"`);
    }
    const grafoObj = obterGrafo(grafo);
    const res = await consultar({ grafo: grafoObj, grafoPath: grafo, raiz: p.root, pergunta: question, termos: terms });
    // Absolute paths in the answer. Measured in a real headless agent run: the engine found the
    // right symbol on call #2, then the agent burned **15 more tool calls** (Read/Glob/Bash) just
    // locating the file — `src=` was relative to the project root and the consumer has no idea what
    // that root is. Emitting the root plus absolute paths took the same question from 17 tool calls
    // to 2. An index that returns an address the reader cannot open charges back in tool calls what
    // it saved in tokens — and a token-only benchmark never sees that bill.
    // Read a WINDOW, not the whole file (2026-07-29) — measured in a head-to-head against a
    // tool that returns source inline instead of addresses. That design pays ~3,200 tokens per
    // question and zero follow-up Reads; this one pays ~1,500 and the agent pays the Read. The
    // end-to-end bill depends entirely on HOW it reads:
    //     addresses + 80-line window Read   2,254 tk  ← this design wins
    //     addresses + whole-file Read        5,887 tk  ← this design loses badly
    //     source inline                      3,209 tk
    // In a real headless run the agent read whole files. The `loc=L<n>` was already in the
    // answer and went unused — data that is present but never acted on is not data delivered.
    // This turns the line number into an instruction.
    const raizPosix = p.root.replace(/\\/g, '/').replace(/\/$/, '');
    const cabecalho = `Project root: ${raizPosix}\n`
      + `(paths below are absolute — open them directly, do not search for them)\n`
      + `(each NODE carries loc=L<line>: read with offset/limit around that line, ~40 lines each side.\n`
      + ` Reading whole files here costs more than the graph saved.)\n\n`;
    /** @param {string} _ @param {string} rel */
    const substituiRelativo = (_, rel) => `src=${raizPosix}/${rel}`;
    const corpo = formata(res, p.name).replace(/src=(?!\/|[A-Za-z]:)([^\s\]]+)/g, substituiRelativo);
    return `${cabecalho}${corpo}\n[graph of ${p.name} — the file is the truth, confirm before editing]`;
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------- JSON-RPC 2.0 sobre stdio ----------
/**
 * @param {unknown} msg
 * @returns {boolean}
 */
const envia = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * @param {string|number|null|undefined} id
 * @param {unknown} result
 * @returns {boolean}
 */
const ok = (id, result) => envia({ jsonrpc: '2.0', id, result });

/**
 * @param {string|number|null|undefined} id
 * @param {number} code
 * @param {string} message
 * @returns {boolean}
 */
const fail = (id, code, message) => envia({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * @param {MCPRequest} msg
 * @returns {Promise<boolean|void>}
 */
async function trata(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05', // ecoa a versão do cliente (compat)
      capabilities: { tools: {} },
      serverInfo: { name: 'cerebro-engine', version: '1.0.0' },
    });
  }
  if (method?.startsWith('notifications/')) return;          // notificação: sem resposta
  if (method === 'ping') return ok(id, {});                   // keep-alive do cliente (Claude Desktop) — responder senão ele reinicia o server
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const texto = await chamaFerramenta(params?.name, params?.arguments);
      return ok(id, { content: [{ type: 'text', text: texto }] });
    } catch (err) {
      const e = /** @type {Error} */ (err);
      return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buffer = '';
/** @type {Set<Promise<unknown>>} */
const pendentes = new Set(); // requisições em voo — não sair enquanto houver async pendente
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const linha = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!linha) continue;
    /** @type {MCPRequest} */
    let msg;
    // a spec do JSON-RPC 2.0 EXIGE responder -32700 com id:null quando o parse falha — engolir
    // calado deixaria o cliente sem sinal se o buffer se deformasse no meio do stream.
    try { msg = JSON.parse(linha); } catch {
      log('JSON-RPC inválido:', linha.slice(0, 80));
      fail(null, -32700, 'Parse error');
      continue;
    }
    // Se o handler explodir ANTES de responder, devolve fail(id) — senão o cliente (Claude/Cursor)
    // fica com o spinner eterno "calling ask_graph" esperando um id que nunca volta.
    const pr = Promise.resolve(trata(msg)).catch((err) => {
      const e = /** @type {Error} */ (err);
      log('erro no handler:', e.message);
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, `internal error: ${e.message}`);
    });
    pendentes.add(pr);
    pr.finally(() => pendentes.delete(pr));
  }
});
process.stdin.on('end', async () => {
  for (const entry of grafoCache.values()) fechaWatcher(entry);
  grafoCache.clear();
  await Promise.allSettled([...pendentes]);
  process.exit(0);
});
log('cerebro-engine MCP server no ar (stdio) ·', projetos.length, 'projeto(s) no projects.json');
