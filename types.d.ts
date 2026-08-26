/**
 * @fileoverview Type definitions for cerebro-engine.
 * End-to-end type safety for graph retrieval, MCP server, and CLI tools.
 */

/**
 * Node in the code graph (AST symbol, docstring, or file entity).
 */
export interface Node {
  /** Unique identifier of the node in the graph */
  id: string;
  /** Symbol or entity label (e.g., function name, class, file) */
  label: string;
  /** Normalized lowercase label without diacritics/accents */
  norm_label?: string;
  /** Entity category: 'code' (symbols), 'rationale' (comments/docstrings), 'data', etc. */
  file_type?: 'code' | 'rationale' | 'data' | string;
  /** Relative path to source file from repo root */
  source_file?: string;
  /** Source location in format 'L<line>' or '?' */
  source_location?: string;
  /** Community identifier from hierarchical clustering */
  community?: string | number;
  /** Descriptive community name */
  community_name?: string;
  [key: string]: unknown;
}

/**
 * Directed edge between nodes in the raw graph.
 */
export interface Link {
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Edge relationship type (e.g., 'calls', 'defines', 'rationale_for', 'imports') */
  relation: string;
  /** Optional edge weight or metadata */
  weight?: number;
  [key: string]: unknown;
}

/**
 * Raw graph format emitted by graphify (graph.json).
 */
export interface RawGraph {
  /** Array of graph nodes */
  nodes?: Node[];
  /** Array of graph links */
  links?: Link[];
  [key: string]: unknown;
}

/**
 * Input required for BM25 and aider heuristic seed scoring.
 */
export interface GraphSeedInput {
  /** List of all nodes */
  nodes: Node[];
  /** Degree count (number of incoming + outgoing edges) per node */
  refCount: Map<string, number>;
  /** Map from target symbol ID to associated docstring/comment prose */
  rationaleDe: Map<string, string[]>;
  /** Map from normalized token to the set of source files that define it */
  arquivosDoToken: Map<string, Set<string>>;
}

/**
 * In-memory indexed graph structure for high-performance BFS traversal and ranking.
 */
export interface Graph extends GraphSeedInput {
  /** The underlying raw graph JSON data */
  g: RawGraph;
  /** Fast node lookup by ID */
  byId: Map<string, Node>;
  /** Undirected adjacency map for BFS graph reachability */
  adj: Map<string, Set<string>>;
  /** Original edge relation lookup keyed by "source\0target" */
  relEntre: Map<string, string>;
}

/**
 * Result of the PT->EN query rewrite step.
 */
export interface RewriteResult {
  /** Translated or extracted English code terms */
  termos: string[];
  /** Provenance of the terms: 'chamador' | 'cache' | 'sem-termos' | 'desligado' */
  origem: 'chamador' | 'cache' | 'sem-termos' | 'desligado' | string;
}

/**
 * Return value of the retrieval engine `consultar()` function.
 */
export interface QueryResult {
  /** The indexed graph instance */
  G: Graph;
  /** Ranked list of selected nodes within top files */
  escolhidos: Node[];
  /** Seed node IDs that initiated the BFS traversal */
  seeds: string[];
  /** Query rewrite metadata */
  rw: RewriteResult;
  /** BFS minimum hop distance map from seeds */
  dist: Map<string, number>;
  /** Reciprocal Rank Fusion (RRF k=60) composite scores per node ID */
  rrf: Map<string, number>;
  /** Total number of candidate files before the top-N cut */
  totalArquivos: number;
}

/**
 * Options passed to `consultar()`.
 */
export interface ConsultarOptions {
  /** Path to the graph.json file */
  grafoPath?: string;
  /** Root directory of the target project repository */
  raiz?: string;
  /** Natural-language question */
  pergunta: string;
  /** Optional caller-supplied English code terms */
  termos?: string[];
  /** Flag to disable the query-rewrite arm */
  semRewrite?: boolean;
  /** Optional pre-indexed in-memory Graph instance (avoids disk read/parse) */
  grafo?: Graph;
}

/**
 * Input arguments for the `ask_graph` MCP tool.
 */
export interface AskGraphArgs {
  /** Natural-language question */
  question: string;
  /** Target project name registered in projects.json */
  project: string;
  /** 4-10 identifiers expected in code (snake_case/camelCase in English) */
  terms?: string[];
  /** Query mode: 'auto' (default) | 'graph' | 'summary' */
  mode?: 'auto' | 'graph' | 'summary';
}

/**
 * MCP tool call invocation payload.
 */
export interface MCPToolCall {
  /** Tool name (e.g. 'ask_graph' | 'list_projects') */
  name: string;
  /** Arguments passed to the tool */
  arguments?: Record<string, unknown> | AskGraphArgs;
}

/**
 * JSON-RPC 2.0 request message received via stdio in MCP server.
 */
export interface MCPRequest {
  /** JSON-RPC protocol version */
  jsonrpc?: string;
  /** Request identifier */
  id?: string | number | null;
  /** RPC method name */
  method: string;
  /** Request parameters */
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown> | AskGraphArgs;
    [key: string]: unknown;
  };
}

/**
 * JSON-RPC 2.0 response message emitted over stdio.
 */
export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number | null | undefined;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Cached in-memory graph entry with mtime validation and file watcher.
 */
export interface GrafoCacheEntry {
  /** The indexed in-memory graph */
  grafo: Graph;
  /** Last modified time in milliseconds of graph.json when loaded */
  mtimeMs: number;
  /** Active fs.FSWatcher instance watching the graph directory */
  watcher: import('node:fs').FSWatcher | null;
}

/**
 * Project configuration entry registered in projects.json.
 */
export interface ProjectConfig {
  /** Project identifier name */
  name: string;
  /** Absolute path to project root directory */
  root: string;
}
