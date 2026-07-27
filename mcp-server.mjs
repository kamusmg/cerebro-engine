#!/usr/bin/env node
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
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consultar, formata, resumoAmplo } from './retrieval.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const log = (...m) => process.stderr.write(m.join(' ') + '\n'); // NUNCA stdout

let projetos = [];
try {
  projetos = JSON.parse(readFileSync(join(ROOT, 'projects.json'), 'utf8'));
} catch {
  log('projects.json não encontrado — copie projects.example.json e liste seus repos. list_projects virá vazio.');
}

const acha = (alvo) =>
  projetos.find((p) => p.name === alvo)
  ?? projetos.find((p) => p.name.includes(String(alvo).toLowerCase()))
  ?? projetos.find((p) => p.root.toLowerCase().includes(String(alvo).toLowerCase()));

const grafoDe = (p) => join(p.root, 'graphify-out', 'graph.json');

const TOOLS = [
  {
    name: 'ask_graph',
    description: 'Ask a project\'s code graph WHERE something lives, in natural language (any language — a cross-language rewrite bridges e.g. Portuguese question to English identifiers). Returns the few files/symbols that answer it, so you read those instead of many files. The graph is an INDEX — confirm in the real file before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language question, e.g. "where is the auth token validated".' },
        project: { type: 'string', description: 'Project name (call list_projects to see the options).' },
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

async function chamaFerramenta(name, args) {
  if (name === 'list_projects') {
    const com = projetos.filter((p) => existsSync(grafoDe(p))).map((p) => `- ${p.name}`);
    return com.length ? `Projects with a graph:\n${com.join('\n')}` : 'No project has a graph yet. Run `graphify update <path>` and add it to projects.json.';
  }
  if (name === 'ask_graph') {
    const { question, project, mode = 'auto' } = args ?? {};
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
    const res = await consultar({ grafoPath: grafo, raiz: p.root, pergunta: question });
    // Absolute paths in the answer. Measured in a real headless agent run: the engine found the
    // right symbol on call #2, then the agent burned **15 more tool calls** (Read/Glob/Bash) just
    // locating the file — `src=` was relative to the project root and the consumer has no idea what
    // that root is. Emitting the root plus absolute paths took the same question from 17 tool calls
    // to 2. An index that returns an address the reader cannot open charges back in tool calls what
    // it saved in tokens — and a token-only benchmark never sees that bill.
    const raizPosix = p.root.replace(/\\/g, '/').replace(/\/$/, '');
    const cabecalho = `Project root: ${raizPosix}\n(paths below are absolute — open them directly, do not search for them)\n\n`;
    const corpo = formata(res, p.name).replace(/src=(?!\/|[A-Za-z]:)([^\s\]]+)/g, (_, rel) => `src=${raizPosix}/${rel}`);
    return `${cabecalho}${corpo}\n[graph of ${p.name} — the file is the truth, confirm before editing]`;
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------- JSON-RPC 2.0 sobre stdio ----------
const envia = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => envia({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => envia({ jsonrpc: '2.0', id, error: { code, message } });

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
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buffer = '';
const pendentes = new Set(); // requisições em voo — não sair enquanto houver async pendente
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const linha = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!linha) continue;
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
    const pr = Promise.resolve(trata(msg)).catch((e) => {
      log('erro no handler:', e.message);
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, `internal error: ${e.message}`);
    });
    pendentes.add(pr);
    pr.finally(() => pendentes.delete(pr));
  }
});
process.stdin.on('end', async () => { await Promise.allSettled([...pendentes]); process.exit(0); });
log('cerebro-engine MCP server no ar (stdio) ·', projetos.length, 'projeto(s) no projects.json');
