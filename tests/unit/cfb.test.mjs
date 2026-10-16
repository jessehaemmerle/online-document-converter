import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasVbaMacros, isCompoundFile, readCompoundFile } from '../../src/assets/cfb.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

test('recognises compound files', () => {
  assert.equal(isCompoundFile(fixture('SampleDoc.doc')), true);
  assert.equal(isCompoundFile(fixture('sample.rtf')), false);
  assert.equal(isCompoundFile(new Uint8Array(0)), false);
});

test('lists top-level entries of a Word file', () => {
  const cfb = readCompoundFile(fixture('SampleDoc.doc'));
  const names = cfb.children(0).map((e) => e.name);
  assert.ok(names.includes('WordDocument'), names.join(', '));
});

test('detects VBA macros in Word, Excel and PowerPoint files', () => {
  assert.equal(hasVbaMacros(fixture('SimpleMacro.doc')), true);
  assert.equal(hasVbaMacros(fixture('SimpleMacro.xls')), true);
  assert.equal(hasVbaMacros(fixture('SimpleMacro.ppt')), true);
});

test('reports no macros for files without VBA', () => {
  for (const name of ['SampleDoc.doc', 'SampleSS.xls', 'basic_test_ppt_file.ppt', 'Word95.doc', 'testEXCEL_4.xls', 'sample.rtf', 'sample.wk1']) {
    assert.equal(hasVbaMacros(fixture(name)), false, name);
  }
});

test('survives truncated and garbage input', () => {
  const doc = fixture('SimpleMacro.doc');
  for (const len of [512, 1024, 4096, 10000]) {
    assert.doesNotThrow(() => hasVbaMacros(doc.subarray(0, len)));
  }
  const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) & 0xff);
  garbage.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(hasVbaMacros(garbage), false);
});
