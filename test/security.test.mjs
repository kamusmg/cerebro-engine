import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumoAmplo, consultar } from '../retrieval.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(REPO, '..');
const RESUMOS_DIR = path.join(ROOT, 'resumos');
const MOCK_PROJ = 'test-security-sample';
const MOCK_FILE = path.join(RESUMOS_DIR, `${MOCK_PROJ}.md`);

describe('Defensive Security & Sanitization Suite', () => {
  before(() => {
    if (!fs.existsSync(RESUMOS_DIR)) {
      fs.mkdirSync(RESUMOS_DIR, { recursive: true });
    }
    fs.writeFileSync(MOCK_FILE, '# Sample Summary\nTest content for security validation.');
  });

  after(() => {
    if (fs.existsSync(MOCK_FILE)) {
      fs.unlinkSync(MOCK_FILE);
    }
  });

  describe('Path Traversal Prevention in resumoAmplo', () => {
    it('should safely return summary for valid safe project name', () => {
      const result = resumoAmplo('visao geral do projeto', MOCK_PROJ);
      assert.ok(result);
      assert.match(result, /# Sample Summary/);
    });

    it('should reject relative path traversal payloads with ../', () => {
      const payloads = [
        '../package',
        '../../package',
        '../../../etc/passwd',
        '..\\..\\package',
        '..',
        '.',
        './test',
        'nested/test',
        'nested\\test',
      ];
      for (const payload of payloads) {
        const resForced = resumoAmplo('visao geral', payload, true);
        assert.equal(resForced, null, `Payload "${payload}" should have been rejected`);
      }
    });

    it('should reject absolute paths in project name', () => {
      const payloads = [
        '/etc/passwd',
        'C:\\Windows\\System32\\cmd',
        path.join(ROOT, 'package'),
      ];
      for (const payload of payloads) {
        const resForced = resumoAmplo('visao geral', payload, true);
        assert.equal(resForced, null, `Absolute path "${payload}" should have been rejected`);
      }
    });

    it('should reject invalid types, empty strings, and special characters', () => {
      const invalid = [
        null,
        undefined,
        12345,
        {},
        [],
        '',
        '   ',
        'proj*name',
        'proj?name',
        'proj:name',
        'proj|name',
        'proj\0nullbyte',
      ];
      for (const val of invalid) {
        const res = resumoAmplo('visao geral', val, true);
        assert.equal(res, null, `Invalid input ${JSON.stringify(val)} must return null`);
      }
    });
  });

  describe('Subprocess raiz Sanitization in consultar', () => {
    // Construct a minimal valid in-memory graph fixture
    const mockGraphPath = path.join(ROOT, '.test-temp-graph.json');

    before(() => {
      fs.writeFileSync(mockGraphPath, JSON.stringify({
        nodes: [
          { id: 'n1', label: 'authenticateUser', file_type: 'code', source_file: 'auth.ts' },
          { id: 'n2', label: 'verifyToken', file_type: 'code', source_file: 'jwt.ts' },
        ],
        links: [
          { source: 'n1', target: 'n2', relation: 'calls' },
        ],
      }));
    });

    after(() => {
      if (fs.existsSync(mockGraphPath)) {
        fs.unlinkSync(mockGraphPath);
      }
    });

    it('should handle non-existent raiz without throwing uncaught exception', async () => {
      const nonExistent = path.join(ROOT, 'non_existent_folder_xyz_123');
      const res = await consultar({
        grafoPath: mockGraphPath,
        raiz: nonExistent,
        pergunta: 'authenticate user',
        semRewrite: true,
      });
      assert.ok(res);
      assert.ok(res.escolhidos.length > 0);
    });

    it('should handle invalid non-directory raiz gracefully', async () => {
      const filePath = mockGraphPath; // file, not directory
      const res = await consultar({
        grafoPath: mockGraphPath,
        raiz: filePath,
        pergunta: 'authenticate user',
        semRewrite: true,
      });
      assert.ok(res);
      assert.ok(res.escolhidos.length > 0);
    });

    it('should handle option injection or malformed strings as raiz', async () => {
      const malicious = '--upload-pack=/bin/sh';
      const res = await consultar({
        grafoPath: mockGraphPath,
        raiz: malicious,
        pergunta: 'authenticate user',
        semRewrite: true,
      });
      assert.ok(res);
      assert.ok(res.escolhidos.length > 0);
    });

    it('should handle null / undefined raiz gracefully', async () => {
      const res = await consultar({
        grafoPath: mockGraphPath,
        raiz: undefined,
        pergunta: 'authenticate user',
        semRewrite: true,
      });
      assert.ok(res);
      assert.ok(res.escolhidos.length > 0);
    });
  });
});
