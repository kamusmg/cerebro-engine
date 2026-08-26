import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bfs, DEPTH, CAP_NOS } from '../retrieval.mjs';

describe('BFS Graph Traversal', () => {
  function buildGraph(edges) {
    const adj = new Map();
    const liga = (a, b) => {
      let setA = adj.get(a);
      if (!setA) {
        setA = new Set();
        adj.set(a, setA);
      }
      setA.add(b);
    };

    for (const [u, v] of edges) {
      liga(u, v);
      liga(v, u);
    }

    return { adj };
  }

  it('should traverse immediate neighbors at distance 1 and 2-hop neighbors at distance 2', () => {
    // Linear chain: A - B - C - D
    const G = buildGraph([
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
    ]);

    const dist = bfs(G, ['A'], 2, 60);

    assert.equal(dist.get('A'), 0);
    assert.equal(dist.get('B'), 1);
    assert.equal(dist.get('C'), 2);
    // D is at distance 3, depth=2 must not include D
    assert.equal(dist.has('D'), false);
    assert.equal(dist.size, 3);
  });

  it('should respect the depth parameter strictly', () => {
    const G = buildGraph([
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
    ]);

    // depth = 0 -> only seeds
    const dist0 = bfs(G, ['A'], 0, 60);
    assert.deepEqual([...dist0.entries()], [['A', 0]]);

    // depth = 1 -> only 1-hop
    const dist1 = bfs(G, ['A'], 1, 60);
    assert.equal(dist1.size, 2);
    assert.equal(dist1.get('A'), 0);
    assert.equal(dist1.get('B'), 1);
    assert.equal(dist1.has('C'), false);

    // depth = 3 -> reaches D
    const dist3 = bfs(G, ['A'], 3, 60);
    assert.equal(dist3.size, 4);
    assert.equal(dist3.get('D'), 3);
  });

  it('should stop exploration when cap (CAP_NOS) is reached', () => {
    // Star topology: Center node H connected to N1..N10
    const edges = [];
    for (let i = 1; i <= 10; i++) {
      edges.push(['H', `N${i}`]);
    }
    const G = buildGraph(edges);

    const dist = bfs(G, ['H'], 2, 4);

    assert.equal(dist.size, 4);
    assert.equal(dist.get('H'), 0);
  });

  it('should handle multiple seeds and preserve shortest distance', () => {
    // Topology: S1 - M - S2 - E
    const G = buildGraph([
      ['S1', 'M'],
      ['M', 'S2'],
      ['S2', 'E'],
    ]);

    const dist = bfs(G, ['S1', 'S2'], 2, 60);

    // Both seeds must be at distance 0
    assert.equal(dist.get('S1'), 0);
    assert.equal(dist.get('S2'), 0);
    // M is 1-hop from both S1 and S2
    assert.equal(dist.get('M'), 1);
    // E is 1-hop from S2
    assert.equal(dist.get('E'), 1);
  });

  it('should handle cycles without infinite loops or double visiting', () => {
    // Ring: A - B - C - A
    const G = buildGraph([
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
    ]);

    const dist = bfs(G, ['A'], 2, 60);

    assert.equal(dist.size, 3);
    assert.equal(dist.get('A'), 0);
    assert.equal(dist.get('B'), 1);
    assert.equal(dist.get('C'), 1);
  });

  it('should not reach disconnected components', () => {
    // Component 1: A - B; Component 2: X - Y
    const G = buildGraph([
      ['A', 'B'],
      ['X', 'Y'],
    ]);

    const dist = bfs(G, ['A'], 3, 60);

    assert.equal(dist.has('A'), true);
    assert.equal(dist.has('B'), true);
    assert.equal(dist.has('X'), false);
    assert.equal(dist.has('Y'), false);
  });

  it('should explore multiple disconnected components if seeds exist in each', () => {
    const G = buildGraph([
      ['A', 'B'],
      ['X', 'Y'],
    ]);

    const dist = bfs(G, ['A', 'X'], 2, 60);

    assert.equal(dist.get('A'), 0);
    assert.equal(dist.get('B'), 1);
    assert.equal(dist.get('X'), 0);
    assert.equal(dist.get('Y'), 1);
    assert.equal(dist.size, 4);
  });

  it('should handle edge cases: empty seeds, isolated nodes, non-existent seeds', () => {
    const G = buildGraph([['A', 'B']]);

    // Empty seeds
    const emptyDist = bfs(G, [], 2, 60);
    assert.equal(emptyDist.size, 0);

    // Non-existent seed ID with no edges
    const nonExistentDist = bfs(G, ['UNKNOWN'], 2, 60);
    assert.equal(nonExistentDist.size, 1);
    assert.equal(nonExistentDist.get('UNKNOWN'), 0);

    // Graph with empty adj map
    const emptyGraph = { adj: new Map() };
    const isolatedDist = bfs(emptyGraph, ['ISO'], 2, 60);
    assert.equal(isolatedDist.size, 1);
    assert.equal(isolatedDist.get('ISO'), 0);
  });
});

// OS TESTES CHAMAVAM `bfs(G, seeds, depth, cap)` COM VALORES PRÓPRIOS (2026-08-26). Isso exercita a
// função, mas deixa os defaults de produção sem guarda nenhuma: medido por mutação, trocar DEPTH
// 2->1 e CAP_NOS 60->5 no motor mantinha os 60 testes verdes. Estes dois valores não são gosto —
// saíram de medição, e o histórico do projeto já registra um knob calibrado no olho (W_RECENTE
// 50->3) que enterrava o alvo. Travar a constante obriga quem mudar a mexer aqui e dizer por quê.
describe('Production defaults (measured knobs, not taste)', () => {
  it('pins BFS depth at 2 hops', () => {
    assert.equal(DEPTH, 2);
  });

  it('pins the BFS node ceiling at 60', () => {
    assert.equal(CAP_NOS, 60);
  });
});
