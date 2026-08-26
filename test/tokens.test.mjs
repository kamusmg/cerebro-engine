import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, semAcento, normaliza } from '../retrieval.mjs';

describe('Text Utilities and Tokenizer', () => {
  describe('semAcento', () => {
    it('should remove accents and diacritics from Portuguese strings', () => {
      assert.equal(semAcento('pontuação'), 'pontuacao');
      assert.equal(semAcento('código'), 'codigo');
      assert.equal(semAcento('função'), 'funcao');
      assert.equal(semAcento('árvore'), 'arvore');
      assert.equal(semAcento('MAÇÃ'), 'MACA');
      assert.equal(semAcento('é isso aí'), 'e isso ai');
    });

    it('should leave strings without accents unchanged', () => {
      assert.equal(semAcento('graph search'), 'graph search');
      assert.equal(semAcento('retrieval_123'), 'retrieval_123');
    });
  });

  describe('normaliza', () => {
    it('should lowercase and remove accents', () => {
      assert.equal(normaliza('PONTUAÇÃO'), 'pontuacao');
      assert.equal(normaliza('Código Limpo'), 'codigo limpo');
      assert.equal(normaliza('  Espaços Extras  '), '  espacos extras  ');
    });

    it('should convert non-string primitives safely', () => {
      assert.equal(normaliza(12345), '12345');
      assert.equal(normaliza(true), 'true');
    });
  });

  describe('tokens', () => {
    it('should split standard space-separated words', () => {
      const result = tokens('busca no grafo de codigo');
      assert.deepEqual(result, ['busca', 'grafo', 'codigo']);
    });

    it('should split camelCase identifiers into distinct words', () => {
      assert.deepEqual(tokens('splitString'), ['split', 'string']);
      assert.deepEqual(tokens('magneticButtonEffect'), ['magnetic', 'button', 'effect']);
      assert.deepEqual(tokens('setupMagnetic'), ['setup', 'magnetic']);
    });

    it('should split camelCase before lowercasing so uppercase boundaries are preserved', () => {
      // Critical regression test: SomeConcatMode must not become someconcatmode blob
      assert.deepEqual(tokens('SomeConcatMode'), ['some', 'concat', 'mode']);
      assert.deepEqual(tokens('GraphQLSchemaBuilder'), ['graph', 'qlschema', 'builder']);
    });

    it('should split snake_case and kebab-case identifiers', () => {
      assert.deepEqual(
        tokens('split_string_by_punctuations'),
        ['split', 'string', 'punctuations']
      );
      assert.deepEqual(
        tokens('fast-graph-retrieval-engine'),
        ['fast', 'graph', 'retrieval', 'engine']
      );
    });

    it('should filter out tokens shorter than 3 characters (MIN_LENGTH = 3)', () => {
      // 1 and 2-letter words (de, em, do, da, by, id, to, is, a, o) must be removed
      const result = tokens('get user by id from db');
      assert.deepEqual(result, ['get', 'user', 'from']);

      const ptResult = tokens('o que e um grafo de nós');
      // 'que', 'grafo', 'nos' >= 3; 'o', 'e', 'um', 'de' < 3
      assert.deepEqual(ptResult, ['que', 'grafo', 'nos']);
    });

    it('should strip punctuation and special characters as delimiters', () => {
      const result = tokens('foo, bar; baz.qux / hello [world] (test) {code}');
      assert.deepEqual(result, ['foo', 'bar', 'baz', 'qux', 'hello', 'world', 'test', 'code']);
    });

    it('should normalize accented words inside tokens', () => {
      const result = tokens('análise de pontuação e configuração');
      assert.deepEqual(result, ['analise', 'pontuacao', 'configuracao']);
    });

    it('should handle numbers attached to alphanumeric identifiers', () => {
      assert.deepEqual(tokens('token123 version42'), ['token123', 'version42']);
      assert.deepEqual(tokens('step1_process2'), ['step1', 'process2']);
    });

    it('should handle edge cases: empty strings, whitespace, delimiters, non-string inputs', () => {
      assert.deepEqual(tokens(''), []);
      assert.deepEqual(tokens('   \t\n  '), []);
      assert.deepEqual(tokens('---...***///###'), []);
      assert.deepEqual(tokens('a bb c dd'), []);
      assert.deepEqual(tokens(12345), ['12345']);
      assert.deepEqual(tokens(null), []);
      assert.deepEqual(tokens(undefined), []);
    });
  });
});
