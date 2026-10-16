// Builds the static site into dist/.
//
// The LibreOffice engine (~250 MB) is taken from the pinned npm package. Its two large files
// are gzip-compressed and split into parts of at most 20 MiB so the site works on any static
// host (GitHub Pages, Cloudflare Pages, a plain web server, …). The service worker
// reassembles and decompresses them in the browser.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const enginePackage = path.join(root, 'node_modules', '@matbee', 'libreoffice-converter');
const engineDir = path.join(enginePackage, 'wasm');
const PART_SIZE = 20 * 1024 * 1024;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function listFiles(dir, base = dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(full, base)));
    else result.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return result.sort();
}

await rm(distDir, { recursive: true, force: true });
await cp(srcDir, distDir, { recursive: true });
await mkdir(path.join(distDir, 'engine'), { recursive: true });

// Small engine files are copied as they are (the web server may compress them on the fly).
for (const name of ['soffice.js', 'soffice.worker.js']) {
  await cp(path.join(engineDir, name), path.join(distDir, 'engine', name));
}

// Large engine files: gzip + split.
const files = {};
for (const [name, type] of [
  ['soffice.wasm', 'application/wasm'],
  ['soffice.data', 'application/octet-stream'],
]) {
  const raw = await readFile(path.join(engineDir, name));
  const compressed = gzipSync(raw, { level: 9 });
  const hash = sha256(compressed).slice(0, 12);
  const parts = [];
  for (let offset = 0, index = 0; offset < compressed.length; offset += PART_SIZE, index++) {
    const partPath = `engine/${name}.${hash}.part${index}.bin`;
    const chunk = compressed.subarray(offset, offset + PART_SIZE);
    await writeFile(path.join(distDir, partPath), chunk);
    parts.push({ path: partPath, size: chunk.length });
  }
  const filePath = `engine/${name}`;
  files[filePath] = { path: filePath, type, size: raw.length, compressedSize: compressed.length, parts };
  console.log(`${name}: ${(raw.length / 1e6).toFixed(1)} MB → ${(compressed.length / 1e6).toFixed(1)} MB in ${parts.length} parts`);
}

const { version: engineVersion } = JSON.parse(await readFile(path.join(enginePackage, 'package.json'), 'utf8'));
const engineId = sha256(JSON.stringify(files)).slice(0, 12);
const manifest = { id: engineId, version: engineVersion, files };
await writeFile(path.join(distDir, 'engine', 'manifest.json'), JSON.stringify(manifest, null, 2));

// The build id changes whenever any file changes; it versions the service worker's app cache.
const hash = createHash('sha256');
for (const file of await listFiles(distDir)) {
  if (file.endsWith('.bin')) continue; // covered by the engine manifest
  hash.update(file).update(await readFile(path.join(distDir, file)));
}
const buildId = hash.digest('hex').slice(0, 12);

const swPath = path.join(distDir, 'sw.js');
const sw = await readFile(swPath, 'utf8');
const injected = sw
  .replace("'@BUILD_ID@'", () => JSON.stringify(buildId))
  .replace("/*@ENGINE_MANIFEST@*/ { id: 'dev', files: {} }", () => JSON.stringify(manifest));
if (injected.includes('@BUILD_ID@') || injected.includes('@ENGINE_MANIFEST@')) {
  throw new Error('Could not inject build information into sw.js');
}
await writeFile(swPath, injected);

// GitHub Pages: serve files as they are, without Jekyll processing.
await writeFile(path.join(distDir, '.nojekyll'), '');

console.log(`Build ${buildId} (engine ${engineVersion}, ${engineId}) written to dist/`);
