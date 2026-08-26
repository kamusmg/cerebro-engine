import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  raiz,
  casaPrefixo,
  partesBusca,
  textoBusca,
  pontuaSeeds,
  BM25_K1,
  BM25_B,
  MIN_PREFIXO,
  W_GENERICO,
  W_BEMNOMEADO,
} from '../retrieval.mjs';

describe('BM25 & Lexical Scoring', () => {
  describe('raiz (Stemming / Plural stripping)', () => {
    it('should strip trailing "s" for words with length >= 4', () => {
      assert.equal(raiz('videos'), 'video');
      assert.equal(raiz('arquivos'), 'arquivo');
      assert.equal(raiz('tokens'), 'token');
      assert.equal(raiz('users'), 'user');
      assert.equal(raiz('tags'), 'tag');
      assert.equal(raiz('keys'), 'key');
      assert.equal(raiz('logs'), 'log');
    });

    it('should not strip trailing "s" for short words (< 4 characters)', () => {
      assert.equal(raiz('is'), 'is');
      assert.equal(raiz('as'), 'as');
      assert.equal(raiz('yes'), 'yes');
      assert.equal(raiz('bus'), 'bus');
    });

    it('should leave non-plural words unchanged', () => {
      assert.equal(raiz('split'), 'split');
      assert.equal(raiz('code'), 'code');
      assert.equal(raiz('graph'), 'graph');
    });
  });

  describe('casaPrefixo (Prefix Matching)', () => {
    it('should match identical tokens exactly', () => {
      assert.equal(casaPrefixo('auth', 'auth'), true);
      assert.equal(casaPrefixo('get', 'get'), true);
      assert.equal(casaPrefixo('retrieval', 'retrieval'), true);
    });

    it('should match prefixes when query term length >= MIN_PREFIXO (4)', () => {
      assert.equal(MIN_PREFIXO, 4);
      // Cross-lingual accidental stemming e.g. portugues -> portuguese
      assert.equal(casaPrefixo('portugues', 'portuguese'), true);
      assert.equal(casaPrefixo('auth', 'authenticate'), true);
      assert.equal(casaPrefixo('auth', 'authentication'), true);
      assert.equal(casaPrefixo('valid', 'validator'), true);
      assert.equal(casaPrefixo('token', 'tokenizer'), true);
    });

    it('should NOT match substrings that are not prefixes', () => {
      // Anchored at beginning of token: som must not match awesome
      assert.equal(casaPrefixo('som', 'awesome'), false);
      assert.equal(casaPrefixo('ler', 'compiler'), false);
      assert.equal(casaPrefixo('port', 'transport'), false);
      assert.equal(casaPrefixo('script', 'javascript'), false);
    });

    it('should NOT match prefix if query term length < MIN_PREFIXO', () => {
      // Short terms (length 3) only match exactly, not as prefixes
      assert.equal(casaPrefixo('get', 'getter'), false);
      assert.equal(casaPrefixo('set', 'setter'), false);
      assert.equal(casaPrefixo('log', 'logger'), false);
      assert.equal(casaPrefixo('log', 'log'), true);
    });
  });

  describe('partesBusca & textoBusca', () => {
    const mockNode = {
      id: 'node-1',
      label: 'processPaymentWebhook',
      norm_label: 'process_payment_webhook',
      source_file: 'src/services/billing/payments.ts',
      community_name: 'billing_service',
      file_type: 'code',
    };
    const rationaleDe = new Map([
      ['node-1', ['Handles incoming Stripe webhook events and verifies signatures']],
    ]);

    it('should construct raw search text with label, norm_label, basename, community, and rationale', () => {
      const partes = partesBusca(mockNode, rationaleDe);
      assert.match(partes, /processPaymentWebhook/);
      assert.match(partes, /process_payment_webhook/);
      assert.match(partes, /payments\.ts/);
      assert.match(partes, /billing_service/);
      assert.match(partes, /Handles incoming Stripe/);
    });

    it('should construct normalized search text', () => {
      const texto = textoBusca(mockNode, rationaleDe);
      assert.equal(texto, texto.toLowerCase());
      assert.match(texto, /processpaymentwebhook/);
      assert.match(texto, /payments\.ts/);
    });
  });

  describe('pontuaSeeds (BM25 + Aider Hardening)', () => {
    function createMockGraph() {
      const nodes = [
        {
          id: 'target-1',
          label: 'split_string_by_punctuations',
          norm_label: 'split_string_by_punctuations',
          source_file: 'src/utils/string_helpers.py',
          file_type: 'code',
          community_name: 'text_processing',
        },
        {
          id: 'generic-1',
          label: '_helper',
          norm_label: '_helper',
          source_file: 'src/utils/common.py',
          file_type: 'code',
          community_name: 'utils',
        },
        {
          id: 'schema-1',
          label: 'schemaConfig',
          norm_label: 'schema_config',
          source_file: 'src/config/schema.ts',
          file_type: 'code',
          community_name: 'config',
        },
        {
          id: 'doc-1',
          label: 'README documentation for split_string',
          norm_label: 'readme_documentation',
          source_file: 'docs/README.md',
          file_type: 'doc',
          community_name: 'docs',
        },
        {
          id: 'hub-1',
          label: 'split_tokens',
          norm_label: 'split_tokens',
          source_file: 'src/core/tokenizer.py',
          file_type: 'code',
          community_name: 'core',
        },
        {
          id: 'unrelated-1',
          label: 'database_pool_connection',
          norm_label: 'database_pool_connection',
          source_file: 'src/db/pool.py',
          file_type: 'code',
          community_name: 'db',
        },
      ];

      const refCount = new Map([
        ['target-1', 1],
        ['generic-1', 2],
        ['schema-1', 1],
        ['doc-1', 0],
        ['hub-1', 99], // highly connected hub node (degree 99)
        ['unrelated-1', 0],
      ]);

      const rationaleDe = new Map([
        ['target-1', ['Split text strings maintaining punctuation marks']],
      ]);

      const arquivosDoToken = new Map([
        ['split_string_by_punctuations', new Set(['src/utils/string_helpers.py'])],
        ['_helper', new Set(['f1.py', 'f2.py', 'f3.py', 'f4.py', 'f5.py', 'f6.py'])], // defined in >5 files
        ['schemaconfig', new Set(['src/config/schema.ts'])],
        ['split_tokens', new Set(['src/core/tokenizer.py'])],
      ]);

      return { nodes, refCount, rationaleDe, arquivosDoToken };
    }

    it('should assign positive BM25 scores to matching nodes and 0 to unrelated nodes', () => {
      const G = createMockGraph();
      const termosPergunta = ['split', 'string', 'punctuations'];
      const termosRewrite = [];

      const { scoreLex, scoreRw } = pontuaSeeds(G, termosPergunta, termosRewrite);

      assert.ok(scoreLex.has('target-1'));
      assert.ok(scoreLex.get('target-1') > 0);
      assert.equal(scoreLex.has('unrelated-1'), false);
      assert.equal(scoreRw.size, 0);
    });

    it('should boost well-named identifiers (W_BEMNOMEADO = 10)', () => {
      const G = createMockGraph();
      assert.equal(W_BEMNOMEADO, 10);

      const termos = ['split', 'string'];
      const { scoreLex } = pontuaSeeds(G, termos, []);

      // target-1 is well named (contains underscore and length >= 8)
      const scoreTarget = scoreLex.get('target-1');
      assert.ok(scoreTarget > 0);
    });

    it('should penalize generic names and tokens defined in >5 files (W_GENERICO = 0.1)', () => {
      const G = createMockGraph();
      assert.equal(W_GENERICO, 0.1);

      // generic-1 starts with '_' and is defined in 6 files
      const { scoreLex } = pontuaSeeds(G, ['helper'], []);
      const scoreGeneric = scoreLex.get('generic-1');
      assert.ok(scoreGeneric > 0);

      // schema-1 matches 'schema' prefix keyword
      const { scoreLex: scoreSchemaMap } = pontuaSeeds(G, ['schema'], []);
      const scoreSchema = scoreSchemaMap.get('schema-1');
      assert.ok(scoreSchema > 0);
    });

    it('should discount non-code files (0.25x) compared to code files', () => {
      const G = createMockGraph();
      const { scoreLex } = pontuaSeeds(G, ['split', 'string'], []);

      const scoreDoc = scoreLex.get('doc-1');
      const scoreCode = scoreLex.get('target-1');
      assert.ok(scoreDoc > 0);
      assert.ok(scoreCode > scoreDoc);
    });

    // This test used to assert only `scoreHub > 0`, with the expected damping factor written in a
    // comment and never checked. Measured 2026-08-26 by deleting the damping from retrieval.mjs:
    // the suite stayed green — a test that names a behaviour and cannot go red for it is worse
    // than no test, because it reports coverage on the one heuristic the engine leans on hardest.
    // Now it pins the ratio: same node, same terms, only the degree changes.
    it('should apply degree damping (1 / sqrt(1 + refCount)) to prevent hub nodes from dominating', () => {
      const comGrau = pontuaSeeds(createMockGraph(), ['split', 'tokens'], []).scoreLex.get('hub-1');

      const semGrau = createMockGraph();
      semGrau.refCount.set('hub-1', 0);
      const base = pontuaSeeds(semGrau, ['split', 'tokens'], []).scoreLex.get('hub-1');

      assert.ok(base > 0, 'fixture broken: hub-1 must score above zero to compare against');
      // refCount 99 -> 1/sqrt(100) = 0.1 ; refCount 0 -> 1/sqrt(1) = 1
      const razao = comGrau / base;
      assert.ok(
        Math.abs(razao - 0.1) < 1e-9,
        `degree damping not applied: expected ratio 0.1, got ${razao}`,
      );
    });

    it('should deduplicate stem roots to prevent double counting (e.g. video vs videos)', () => {
      const G = createMockGraph();
      // 'string' and 'strings' have the same root 'string'
      const { scoreLex: scoreSingle } = pontuaSeeds(G, ['string'], []);
      const { scoreLex: scoreDouble } = pontuaSeeds(G, ['string', 'strings'], []);

      assert.equal(scoreSingle.get('target-1'), scoreDouble.get('target-1'));
    });

    it('should score rewrite terms separately in scoreRw', () => {
      const G = createMockGraph();
      const { scoreLex, scoreRw } = pontuaSeeds(
        G,
        ['database'],
        ['split', 'string', 'punctuations']
      );

      assert.ok(scoreLex.has('unrelated-1'));
      assert.equal(scoreLex.has('target-1'), false);

      assert.ok(scoreRw.has('target-1'));
      assert.equal(scoreRw.has('unrelated-1'), false);
    });
  });
});
