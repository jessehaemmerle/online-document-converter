import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createZip, crc32, uniqueNames } from '../../src/assets/zip.js';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('creates a ZIP that standard tools can read', async () => {
  const files = [
    { name: 'Bericht.docx', data: new TextEncoder().encode('erste Datei') },
    { name: 'Übersicht ä.xlsx', data: new Uint8Array([0, 1, 2, 3, 255]) },
  ];
  const blob = createZip(files);
  const dir = mkdtempSync(path.join(tmpdir(), 'zip-test-'));
  try {
    const zipPath = path.join(dir, 'out.zip');
    writeFileSync(zipPath, new Uint8Array(await blob.arrayBuffer()));
    const script = [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'print("|".join(f"{i.filename}:{len(z.read(i))}" for i in z.infolist()))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', script, zipPath], { encoding: 'utf8' }).trim();
    assert.equal(out, 'Bericht.docx:11|Übersicht ä.xlsx:5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makes duplicate names unique', () => {
  assert.deepEqual(uniqueNames(['a.docx', 'A.docx', 'a.docx', 'b.xlsx']), ['a.docx', 'A (2).docx', 'a (3).docx', 'b.xlsx']);
});
