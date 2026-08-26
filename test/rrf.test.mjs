import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankeia, K_RRF } from '../retrieval.mjs';

describe('Reciprocal Rank Fusion (RRF)', () => {
  describe('K_RRF Constant', () => {
    it('should match the canonical Cormack 2009 constant (k = 60)', () => {
      assert.equal(K_RRF, 60);
    });
  });

  describe('rankeia (Rank Conversion)', () => {
    it('should convert scores into 1-based ranks ordered descending by score', () => {
      const scores = new Map([
        ['nodeA', 15.5],
        ['nodeB', 120.0],
        ['nodeC', 42.1],
      ]);

      const ranks = rankeia(scores);

      assert.equal(ranks.get('nodeB'), 1); // highest score (120.0) -> rank 1
      assert.equal(ranks.get('nodeC'), 2); // second highest (42.1) -> rank 2
      assert.equal(ranks.get('nodeA'), 3); // third highest (15.5) -> rank 3
      assert.equal(ranks.size, 3);
    });

    it('should handle single-element map', () => {
      const scores = new Map([['singleNode', 99]]);
      const ranks = rankeia(scores);
      assert.equal(ranks.get('singleNode'), 1);
      assert.equal(ranks.size, 1);
    });

    it('should handle empty map', () => {
      const scores = new Map();
      const ranks = rankeia(scores);
      assert.equal(ranks.size, 0);
    });

    it('should handle negative and decimal scores properly', () => {
      const scores = new Map([
        ['n1', -10.5],
        ['n2', 0.001],
        ['n3', -0.5],
      ]);

      const ranks = rankeia(scores);

      assert.equal(ranks.get('n2'), 1);
      assert.equal(ranks.get('n3'), 2);
      assert.equal(ranks.get('n1'), 3);
    });
  });

  describe('RRF Score Formula & Multi-Arm Fusion', () => {
    function computeRRF(rankLists, candidateIds) {
      const rrf = new Map();
      for (const id of candidateIds) {
        let s = 0;
        for (const rk of rankLists) {
          const rkVal = rk.get(id);
          if (rkVal !== undefined) {
            s += 1 / (K_RRF + rkVal);
          }
        }
        rrf.set(id, s);
      }
      return rrf;
    }

    it('should compute exact reciprocal rank score 1 / (K_RRF + rank)', () => {
      const scoreMap = new Map([
        ['first', 100],
        ['second', 50],
      ]);
      const rk = rankeia(scoreMap);
      const rrf = computeRRF([rk], ['first', 'second']);

      const expectedFirst = 1 / (60 + 1); // ~ 0.0163934426
      const expectedSecond = 1 / (60 + 2); // ~ 0.0161290322

      assert.ok(Math.abs((rrf.get('first') ?? 0) - expectedFirst) < 1e-9);
      assert.ok(Math.abs((rrf.get('second') ?? 0) - expectedSecond) < 1e-9);
      assert.ok((rrf.get('first') ?? 0) > (rrf.get('second') ?? 0));
    });

    it('should prioritize multi-arm consensus over single-arm dominance', () => {
      // Node A is rank 2 in both Lexical and Graph arms
      // Node B is rank 1 in Lexical arm only, and missing in Graph arm
      const rkLex = new Map([
        ['nodeB', 1],
        ['nodeA', 2],
      ]);
      const rkGrafo = new Map([
        ['nodeA', 2],
        ['nodeC', 1],
      ]);

      const candidates = new Set(['nodeA', 'nodeB', 'nodeC']);
      const rrf = computeRRF([rkLex, rkGrafo], candidates);

      const scoreA = rrf.get('nodeA') ?? 0; // 1/(60+2) + 1/(60+2) = 2/62 ≈ 0.032258
      const scoreB = rrf.get('nodeB') ?? 0; // 1/(60+1) ≈ 0.016393
      const scoreC = rrf.get('nodeC') ?? 0; // 1/(60+1) ≈ 0.016393

      assert.ok(scoreA > scoreB);
      assert.ok(scoreA > scoreC);
    });

    it('should boost an item supported by all three arms (Lexical + Rewrite + Graph)', () => {
      const rkLex = new Map([['target', 3], ['other', 1]]);
      const rkRw = new Map([['target', 3]]);
      const rkGr = new Map([['target', 3]]);

      const candidates = new Set(['target', 'other']);
      const rrf = computeRRF([rkLex, rkRw, rkGr], candidates);

      const targetScore = rrf.get('target') ?? 0; // 3 * (1/63) ≈ 0.047619
      const otherScore = rrf.get('other') ?? 0;   // 1 * (1/61) ≈ 0.016393

      assert.ok(targetScore > otherScore);
    });

    it('should remain scale-invariant regardless of raw score magnitude', () => {
      // Raw scores on different scales (e.g. 10,000 vs 0.001) produce the same RRF ranking
      const scoresScaleSmall = new Map([
        ['A', 0.03],
        ['B', 0.02],
        ['C', 0.01],
      ]);

      const scoresScaleLarge = new Map([
        ['A', 300_000],
        ['B', 200_000],
        ['C', 100_000],
      ]);

      const rkSmall = rankeia(scoresScaleSmall);
      const rkLarge = rankeia(scoresScaleLarge);

      assert.deepEqual([...rkSmall.entries()], [...rkLarge.entries()]);

      const rrfSmall = computeRRF([rkSmall], ['A', 'B', 'C']);
      const rrfLarge = computeRRF([rkLarge], ['A', 'B', 'C']);

      assert.deepEqual([...rrfSmall.entries()], [...rrfLarge.entries()]);
    });
  });
});
