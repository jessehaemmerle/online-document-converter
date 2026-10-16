// End-to-end test: builds on dist/ (run `npm run build` first), serves it without any special
// headers (like GitHub Pages) and drives the app in Chromium.
//   CHROMIUM_PATH=/path/to/chrome npm run test:e2e
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name) => path.join(root, 'tests', 'fixtures', name);

const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
};

// Reads the entries of a ZIP file (central directory) and returns { name → contents }.
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'not a ZIP file');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries[name] = method === 0 ? raw : inflateRawSync(raw);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function assertOfficeFile(buffer, format, { vba = false } = {}) {
  const entries = readZip(buffer);
  const types = entries['[Content_Types].xml']?.toString('utf8') ?? '';
  assert.ok(types.includes(CONTENT_TYPES[format]), `expected ${format} content type`);
  const hasVba = Object.keys(entries).some((name) => name.endsWith('vbaProject.bin'));
  assert.equal(hasVba, vba, `vbaProject.bin ${vba ? 'missing' : 'unexpected'} in ${format}`);
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

let server;
let browser;
let context;
let page;
let baseUrl;
const foreignRequests = [];

before(async () => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'dist/ missing – run `npm run build` first');
  const port = await freePort();
  baseUrl = `http://localhost:${port}/`;
  server = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), String(port)], { stdio: 'pipe' });
  await new Promise((resolve) => server.stdout.once('data', resolve));

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  context = await browser.newContext({ acceptDownloads: true, locale: 'de-AT' });
  context.on('request', (request) => {
    if (!request.url().startsWith(baseUrl) && !request.url().startsWith('blob:')) foreignRequests.push(request.url());
  });
  page = await context.newPage();
  await page.goto(baseUrl);
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 30_000 });
  await page.waitForSelector('#choose-files:not([disabled])');
});

after(async () => {
  await browser?.close();
  server?.kill();
});

const fileItem = (name) => page.locator('.file', { has: page.locator('.file-source', { hasText: name }) });

async function waitForStatus(name, status, timeout = 120_000) {
  await page.waitForFunction(
    ([n, s]) => [...document.querySelectorAll('.file')].some((el) => el.querySelector('.file-source').textContent === n && el.dataset.status === s),
    [name, status],
    { timeout },
  );
}

async function download(name) {
  const [file] = await Promise.all([page.waitForEvent('download'), fileItem(name).locator('.file-download').click()]);
  return { name: file.suggestedFilename(), buffer: readFileSync(await file.path()) };
}

test('reloads once into cross-origin isolated mode and removes the marker', async () => {
  assert.equal(new URL(page.url()).searchParams.has('isolated'), false);
  assert.equal(await page.evaluate(() => typeof SharedArrayBuffer), 'function');
  assert.equal(await page.locator('h1').textContent(), 'Alte Office-Dateien in aktuelle Formate umwandeln');
});

test('converts legacy files without macros', async () => {
  const cases = [
    ['SampleDoc.doc', 'SampleDoc.docx', 'docx'],
    ['Word95.doc', 'Word95.docx', 'docx'],
    ['sample.rtf', 'sample.docx', 'docx'],
    ['SampleSS.xls', 'SampleSS.xlsx', 'xlsx'],
    ['testEXCEL_4.xls', 'testEXCEL_4.xlsx', 'xlsx'],
    ['sample.wk1', 'sample.xlsx', 'xlsx'],
    ['basic_test_ppt_file.ppt', 'basic_test_ppt_file.pptx', 'pptx'],
  ];
  await page.setInputFiles('#file-input', cases.map(([name]) => fixture(name)));
  for (const [input, output, format] of cases) {
    await waitForStatus(input, 'done');
    const result = await download(input);
    assert.equal(result.name, output);
    assertOfficeFile(result.buffer, format);
  }
  const lotus = readZip((await download('sample.wk1')).buffer);
  assert.ok(lotus['xl/sharedStrings.xml'].toString().includes('Hallo Lotus'));
});

test('asks how to handle macros and honours the choice', async () => {
  await page.click('#clear-list');
  await page.setInputFiles('#file-input', ['SimpleMacro.doc', 'SimpleMacro.ppt', 'SimpleMacro.xls'].map(fixture));
  for (const name of ['SimpleMacro.doc', 'SimpleMacro.ppt', 'SimpleMacro.xls']) await waitForStatus(name, 'needs-choice', 30_000);
  assert.match(await fileItem('SimpleMacro.doc').locator('.macro-keep-hint').textContent(), /nicht immer zu 100 % korrekt/);

  await fileItem('SimpleMacro.doc').locator('.macro-keep').click();
  await fileItem('SimpleMacro.ppt').locator('.macro-remove').click();
  await fileItem('SimpleMacro.xls').locator('.macro-keep').click();
  for (const name of ['SimpleMacro.doc', 'SimpleMacro.ppt', 'SimpleMacro.xls']) await waitForStatus(name, 'done');

  const doc = await download('SimpleMacro.doc');
  assert.equal(doc.name, 'SimpleMacro.docm');
  assertOfficeFile(doc.buffer, 'docm', { vba: true });

  const ppt = await download('SimpleMacro.ppt');
  assert.equal(ppt.name, 'SimpleMacro.pptx');
  assertOfficeFile(ppt.buffer, 'pptx', { vba: false });

  // The engine cannot carry Excel macros over: the user gets an honest macro-free file and a note.
  const xls = await download('SimpleMacro.xls');
  assert.equal(xls.name, 'SimpleMacro.xlsx');
  assertOfficeFile(xls.buffer, 'xlsx', { vba: false });
  assert.match(await fileItem('SimpleMacro.xls').locator('.file-note').textContent(), /Makros konnten nicht übernommen werden/);
});

test('keeps macros in PowerPoint files when asked', async () => {
  await page.click('#clear-list');
  await page.setInputFiles('#file-input', fixture('SimpleMacro.ppt'));
  await waitForStatus('SimpleMacro.ppt', 'needs-choice', 30_000);
  await fileItem('SimpleMacro.ppt').locator('.macro-keep').click();
  await waitForStatus('SimpleMacro.ppt', 'done');
  const ppt = await download('SimpleMacro.ppt');
  assert.equal(ppt.name, 'SimpleMacro.pptm');
  assertOfficeFile(ppt.buffer, 'pptm', { vba: true });
});

test('rejects unsupported, broken and password-protected files and bundles results as ZIP', async () => {
  await page.click('#clear-list');
  const asUpload = (name) => ({ name, mimeType: 'application/octet-stream', buffer: readFileSync(fixture(name)) });
  await page.setInputFiles('#file-input', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'broken.doc', mimeType: 'application/msword', buffer: readFileSync(fixture('SampleDoc.doc')).subarray(0, 6000) },
    asUpload('PasswordProtected.doc'),
    asUpload('SampleDoc.doc'),
    asUpload('SampleSS.xls'),
  ]);
  await waitForStatus('notes.txt', 'error', 10_000);
  assert.match(await fileItem('notes.txt').locator('.file-status').textContent(), /nicht unterstützt/);
  for (const name of ['broken.doc', 'PasswordProtected.doc']) {
    await waitForStatus(name, 'error');
    assert.match(await fileItem(name).locator('.file-status').textContent(), /passwortgeschützt/);
  }
  await waitForStatus('SampleDoc.doc', 'done');
  await waitForStatus('SampleSS.xls', 'done');

  const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#download-all')]);
  const entries = readZip(readFileSync(await zip.path()));
  assert.deepEqual(Object.keys(entries).sort(), ['SampleDoc.docx', 'SampleSS.xlsx']);
  assertOfficeFile(entries['SampleDoc.docx'], 'docx');
});

test('stores no user data and contacts no other servers', async () => {
  const storage = await page.evaluate(async () => ({
    cookies: document.cookie,
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).length,
    caches: await caches.keys(),
  }));
  assert.equal(storage.cookies, '');
  assert.equal(storage.local, 0);
  assert.equal(storage.session, 0);
  assert.equal(storage.databases, 0);
  assert.ok(storage.caches.every((key) => /^(app|engine)-/.test(key)), storage.caches.join(', '));
  assert.deepEqual(foreignRequests, []);
});

test('works offline once loaded', async () => {
  await context.setOffline(true);
  try {
    await page.reload();
    await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 30_000 });
    await page.waitForSelector('#choose-files:not([disabled])');
    await page.setInputFiles('#file-input', fixture('SampleDoc.doc'));
    await waitForStatus('SampleDoc.doc', 'done');
    assertOfficeFile((await download('SampleDoc.doc')).buffer, 'docx');
  } finally {
    await context.setOffline(false);
  }
});

test('switches the language without storing anything', async () => {
  await page.click('[data-lang="en"]');
  assert.equal(await page.locator('h1').textContent(), 'Convert legacy Office files to current formats');
  assert.equal(new URL(page.url()).searchParams.get('lang'), 'en');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
});
