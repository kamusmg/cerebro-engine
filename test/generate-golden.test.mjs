import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extraiCandidatos, selecionaGoldenSet } from '../generate-golden.mjs';

describe('Synthetic Benchmark Generator (generate-golden.mjs)', () => {
  const sampleGraph = {
    nodes: [
      {
        id: 'file_auth',
        label: 'auth.py',
        file_type: 'code',
        source_file: 'src/auth/auth.py',
        community: 1,
      },
      {
        id: 'func_validate_jwt',
        label: 'validate_jwt_token()',
        file_type: 'code',
        source_file: 'src/auth/auth.py',
        community: 1,
      },
      {
        id: 'doc_validate_jwt',
        label: '/** Validates incoming JWT access token and verifies signature */',
        file_type: 'rationale',
        source_file: 'src/auth/auth.py',
      },
      {
        id: 'func_generic_get',
        label: 'get()',
        file_type: 'code',
        source_file: 'src/utils/helpers.py',
        community: 2,
      },
      {
        id: 'func_calculate_tax',
        label: 'calculate_tax_rate()',
        file_type: 'code',
        source_file: 'src/billing/tax.py',
        community: 3,
      },
      {
        id: 'class_user_session',
        label: 'UserSessionManager',
        file_type: 'code',
        source_file: 'src/session/manager.ts',
        community: 4,
      },
    ],
    links: [
      {
        source: 'doc_validate_jwt',
        target: 'func_validate_jwt',
        relation: 'rationale_for',
      },
      {
        source: 'file_auth',
        target: 'func_validate_jwt',
        relation: 'contains',
      },
    ],
  };

  describe('extraiCandidatos', () => {
    it('should extract docstring/rationale questions linked via rationale_for', () => {
      const candidates = extraiCandidatos(sampleGraph, 'test-project');
      const rationaleCandidates = candidates.filter((c) => c.tipo === 'rationale');

      assert.ok(rationaleCandidates.length > 0, 'Should have rationale candidates');
      const cand = rationaleCandidates.find((c) => c.alvos.includes('auth.py'));
      assert.ok(cand, 'Should find candidate targeting auth.py');
      assert.equal(cand.projeto, 'test-project');
      assert.ok(cand.pergunta.toLowerCase().includes('validates incoming jwt access token'));
      assert.ok(cand.termos.includes('jwt'));
      assert.ok(cand.termos.includes('validate'));
      assert.deepEqual(cand.alvos, ['auth.py']);
    });

    it('should extract descriptive function/class symbol candidates', () => {
      const candidates = extraiCandidatos(sampleGraph, 'test-project');
      const symbolCandidates = candidates.filter((c) => c.tipo === 'simbolo');

      const taxCand = symbolCandidates.find((c) => c.alvos.includes('tax.py'));
      assert.ok(taxCand, 'Should extract calculate_tax_rate symbol');
      assert.ok(taxCand.termos.includes('calculate'));
      assert.ok(taxCand.termos.includes('tax'));
      assert.ok(taxCand.termos.includes('rate'));

      const sessionCand = symbolCandidates.find((c) => c.alvos.includes('manager.ts'));
      assert.ok(sessionCand, 'Should extract UserSessionManager symbol');
      assert.ok(sessionCand.termos.includes('user'));
      assert.ok(sessionCand.termos.includes('session'));
      assert.ok(sessionCand.termos.includes('manager'));
    });

    it('should filter out short or generic symbols without docstrings', () => {
      const candidates = extraiCandidatos(sampleGraph, 'test-project');
      const genericCand = candidates.find((c) => c.simbolo === 'get()');
      assert.equal(genericCand, undefined, 'get() should be filtered out as generic');
    });
  });

  describe('selecionaGoldenSet', () => {
    it('should respect the limit argument', () => {
      const candidates = extraiCandidatos(sampleGraph, 'test-project');
      const selected = selecionaGoldenSet(candidates, { limite: 2, seed: 123 });
      assert.equal(selected.length, 2);
    });

    it('should be deterministic given the same seed', () => {
      const candidates = extraiCandidatos(sampleGraph, 'test-project');
      const runA = selecionaGoldenSet(candidates, { limite: 3, seed: 42 });
      const runB = selecionaGoldenSet(candidates, { limite: 3, seed: 42 });

      assert.deepEqual(runA, runB, 'Runs with same seed must be identical');
    });

    it('should enforce diversity across target files', () => {
      // Create candidates with many entries on the same file
      const dummyCandidates = Array.from({ length: 10 }, (_, i) => ({
        projeto: 'proj',
        pergunta: `pergunta ${i}`,
        alvos: ['common_file.py'],
        termos: ['term'],
        tipo: 'simbolo',
        scoreQualidade: 10,
        nota: `test ${i}`,
      })).concat([
        {
          projeto: 'proj',
          pergunta: 'unique question',
          alvos: ['other_file.py'],
          termos: ['term'],
          tipo: 'simbolo',
          scoreQualidade: 10,
          nota: 'other file',
        },
      ]);

      const selected = selecionaGoldenSet(dummyCandidates, { limite: 5, seed: 42 });
      const countCommon = selected.filter((s) => s.alvos[0] === 'common_file.py').length;
      // Max per file is 2 in first pass
      assert.ok(countCommon <= 4, 'Should balance files');
      const countOther = selected.filter((s) => s.alvos[0] === 'other_file.py').length;
      assert.equal(countOther, 1, 'Should include other files for diversity');
    });
  });
});
