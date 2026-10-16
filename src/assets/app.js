import { hasVbaMacros } from './cfb.js';
import { ACCEPT_ATTRIBUTE, INPUT_FORMATS, MIME_TYPES, OUTPUT_FORMATS, baseNameOf, extensionOf } from './formats.js';
import { detectLanguage, translator } from './i18n.js';
import { createZip, uniqueNames } from './zip.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEBUG = new URL(location.href).searchParams.has('debug');
const ISOLATION_MARKER = 'isolated';

let lang = detectLanguage();
let t = translator(lang);
let manifest = null;
let engineCached = false;

const $ = (selector) => document.querySelector(selector);
const ui = {
  fatal: $('#fatal'),
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  chooseFiles: $('#choose-files'),
  firstLoadHint: $('#first-load-hint'),
  engineStatus: $('#engine-status'),
  engineText: $('#engine-text'),
  engineProgress: $('#engine-progress'),
  files: $('#files'),
  fileList: $('#file-list'),
  downloadAll: $('#download-all'),
  clearList: $('#clear-list'),
  techText: $('#tech-text'),
  clearCache: $('#clear-cache'),
  cacheStatus: $('#cache-status'),
  template: $('#file-template'),
};

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(lang, { maximumFractionDigits: digits })} ${units[unit]}`;
}

const engineDownloadSize = () => (manifest ? Object.values(manifest.files).reduce((sum, f) => sum + f.compressedSize, 0) : 0);

// ---------------------------------------------------------------------------
// Cross-origin isolation: the multithreaded engine needs SharedArrayBuffer, which browsers only
// allow on pages sent with COOP/COEP headers. GitHub Pages cannot send them, so the service
// worker adds them. On the very first visit the page reloads once after the worker is active.

async function ensureIsolation() {
  const url = new URL(location.href);
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch {
    return self.crossOriginIsolated;
  }
  if (self.crossOriginIsolated) {
    if (url.searchParams.has(ISOLATION_MARKER)) {
      url.searchParams.delete(ISOLATION_MARKER);
      history.replaceState(null, '', url);
    }
    return true;
  }
  if (url.searchParams.has(ISOLATION_MARKER)) return false; // already reloaded once, give up

  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // First visit: wait until the new service worker takes control. After a hard reload the
    // worker is active but bypassed; a normal reload is enough then.
    await Promise.race([
      new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  url.searchParams.set(ISOLATION_MARKER, '1');
  location.replace(url.href);
  return new Promise(() => {}); // the page is reloading
}

// ---------------------------------------------------------------------------
// Engine: a dedicated worker running LibreOffice. Conversions run one after another.

const engine = {
  state: 'idle', // idle | loading | ready | failed
  worker: null,
  ready: null,
  nextId: 1,
  pending: new Map(),
  queue: Promise.resolve(),
  progress: new Map(),

  start() {
    this.ready ??= this.boot().catch((error) => {
      this.reset();
      this.setState('failed');
      throw error;
    });
    return this.ready;
  },

  async boot() {
    this.progress.clear();
    this.setState('loading');
    const url = new URL('../engine/convert-worker.js', import.meta.url);
    if (DEBUG) url.searchParams.set('debug', '1');
    this.worker = new Worker(url);
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.ok) request.resolve(data);
      else request.reject(Object.assign(new Error(data.message), { code: data.code }));
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.crash(new Error(event.message || 'worker error'));
    };
    await this.call({ type: 'init' });
    this.setState('ready');
  },

  call(message, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  },

  crash(error) {
    error.code ??= 'engine-crash';
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.reset();
    this.setState('failed');
  },

  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  },

  convert(data, ext, keepMacros, onStart) {
    const job = this.queue.then(async () => {
      await this.start();
      onStart();
      try {
        return await this.call({ type: 'convert', data, ext, keepMacros }, [data]);
      } catch (error) {
        // After a crash inside the engine its state is unknown: start a fresh one next time.
        if (error.code === 'engine-crash' || error.code === 'engine-abort') this.reset();
        throw error;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  },

  setState(state) {
    this.state = state;
    if (state === 'ready') engineCached = true;
    renderEngine();
  },
};

// The service worker reports the download progress of the engine files.
const downloadChannel = new BroadcastChannel('engine-download');
downloadChannel.onmessage = ({ data }) => {
  if (data.loaded === undefined) return;
  engine.progress.set(data.path, data.loaded);
  renderEngine();
};

function renderEngine() {
  const { state } = engine;
  ui.engineStatus.hidden = state === 'idle' || state === 'ready';
  ui.engineStatus.classList.toggle('engine-failed', state === 'failed');
  ui.engineProgress.hidden = state === 'failed';
  if (state === 'loading') {
    const total = engineDownloadSize();
    const loaded = [...engine.progress.values()].reduce((sum, n) => sum + n, 0);
    if (total && loaded < total) {
      ui.engineText.textContent = t('engineDownloading', { loaded: formatBytes(loaded), total: formatBytes(total) });
      ui.engineProgress.value = Math.round((loaded / total) * 100);
    } else {
      ui.engineText.textContent = t('engineStarting');
      ui.engineProgress.removeAttribute('value');
    }
  } else if (state === 'failed') {
    ui.engineText.textContent = t('engineFailed');
  }
  renderFirstLoadHint();
}

function renderFirstLoadHint() {
  const total = engineDownloadSize();
  ui.firstLoadHint.hidden = !total || engineCached || engine.state !== 'idle';
  if (total) ui.firstLoadHint.textContent = t('dropFirstLoad', { size: formatBytes(total) });
}

function renderTechText() {
  ui.techText.textContent = t('techText', { version: manifest?.version ?? '' });
}

async function loadManifest() {
  try {
    const response = await fetch('engine/manifest.json');
    if (!response.ok) return;
    manifest = await response.json();
    engineCached = await caches.has(`engine-${manifest.id}`);
  } catch {
    // Only used for the size hint and progress bar; conversion works without it.
  }
  renderTechText();
  renderEngine();
}

// ---------------------------------------------------------------------------
// Files

const items = [];

async function addFiles(fileList) {
  const added = [];
  for (const file of fileList) {
    const ext = extensionOf(file.name);
    const item = { file, ext, format: INPUT_FORMATS[ext] ?? null, status: 'checking', keepMacros: false };
    items.push(item);
    added.push(item);
    createItemElement(item);
  }
  ui.files.hidden = items.length === 0;

  for (const item of added) {
    if (!item.format) {
      setError(item, 'errorUnsupported');
      continue;
    }
    if (item.file.size === 0) {
      setError(item, 'errorEmpty');
      continue;
    }
    if (item.file.size > MAX_FILE_SIZE) {
      setError(item, 'errorTooLarge', { max: formatBytes(MAX_FILE_SIZE) });
      continue;
    }
    if (item.format.cfb) {
      try {
        item.hasMacros = hasVbaMacros(new Uint8Array(await item.file.arrayBuffer()));
      } catch {
        setError(item, 'errorRead');
        continue;
      }
    }
    // Start loading the engine as soon as there is something to convert.
    engine.start().catch(() => {});
    if (item.hasMacros) {
      item.status = 'needs-choice';
      renderItem(item);
    } else {
      convertItem(item);
    }
  }
}

async function convertItem(item) {
  item.status = engine.state === 'ready' ? 'queued' : 'waiting-engine';
  item.error = null;
  renderItem(item);
  try {
    const data = await item.file.arrayBuffer();
    const result = await engine.convert(data, item.ext, item.keepMacros, () => {
      item.status = 'converting';
      renderItem(item);
    });
    if (!items.includes(item)) return; // removed while converting
    const blob = new Blob([result.data], { type: MIME_TYPES[result.format] });
    item.result = {
      name: `${baseNameOf(item.file.name)}.${result.format}`,
      format: result.format,
      macrosLost: result.macrosLost,
      blob,
      url: URL.createObjectURL(blob),
    };
    item.status = 'done';
    renderItem(item);
  } catch (error) {
    if (!items.includes(item)) return;
    if (DEBUG) console.error(error);
    const key =
      { 'load-failed': 'errorLoad', 'unsupported-type': 'errorType' }[error.code] ??
      (error instanceof DOMException ? 'errorRead' : 'errorEngine');
    setError(item, key);
  }
  updateToolbar();
}

function setError(item, key, params) {
  item.status = 'error';
  item.error = { key, params };
  renderItem(item);
  updateToolbar();
}

function removeItem(item) {
  const index = items.indexOf(item);
  if (index !== -1) items.splice(index, 1);
  if (item.result) URL.revokeObjectURL(item.result.url);
  item.result = null;
  item.element.remove();
  ui.files.hidden = items.length === 0;
  updateToolbar();
}

function clearList() {
  for (const item of [...items]) removeItem(item);
}

function updateToolbar() {
  ui.downloadAll.disabled = !items.some((item) => item.status === 'done');
}

async function downloadAll() {
  const done = items.filter((item) => item.status === 'done');
  if (!done.length) return;
  const names = uniqueNames(done.map((item) => item.result.name));
  const files = await Promise.all(
    done.map(async (item, i) => ({ name: names[i], data: new Uint8Array(await item.result.blob.arrayBuffer()) })),
  );
  const url = URL.createObjectURL(createZip(files));
  const link = document.createElement('a');
  link.href = url;
  link.download = lang === 'de' ? 'konvertierte-dateien.zip' : 'converted-files.zip';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const KIND_ICON = { text: 'W', sheet: 'X', slides: 'P' };

function createItemElement(item) {
  const element = ui.template.content.firstElementChild.cloneNode(true);
  item.element = element;
  element.querySelector('.file-remove').addEventListener('click', () => removeItem(item));
  element.querySelector('.file-retry').addEventListener('click', () => convertItem(item));
  element.querySelector('.macro-remove').addEventListener('click', () => {
    item.keepMacros = false;
    convertItem(item);
  });
  element.querySelector('.macro-keep').addEventListener('click', () => {
    item.keepMacros = true;
    convertItem(item);
  });
  ui.fileList.append(element);
  renderItem(item);
}

function expectedTargetName(item) {
  if (item.result) return item.result.name;
  const target = item.format ? OUTPUT_FORMATS[item.format.kind] : null;
  if (!target || item.status === 'error') return '';
  const base = baseNameOf(item.file.name);
  if (item.status === 'needs-choice') return `${base}.${target.plain} / .${target.macro}`;
  return `${base}.${item.keepMacros ? target.macro : target.plain}`;
}

function statusText(item) {
  switch (item.status) {
    case 'waiting-engine':
      return t('statusWaitingEngine');
    case 'converting':
      return t('statusConverting');
    case 'needs-choice':
      return t('statusNeedsChoice');
    case 'done':
      return t('statusDone', { size: formatBytes(item.result.blob.size) });
    case 'error':
      return t(item.error.key, item.error.params);
    default:
      return t('statusQueued');
  }
}

function itemNotes(item) {
  const notes = [];
  if (item.format?.template && item.status !== 'error') notes.push(t('templateNote'));
  if (item.status === 'done' && item.hasMacros) {
    if (item.result.macrosLost) notes.push(t('macrosLost', { format: item.result.format }));
    else notes.push(t(item.keepMacros ? 'macrosKept' : 'macrosRemoved'));
  }
  return notes;
}

function renderItem(item) {
  const el = item.element;
  const kind = item.format?.kind;
  const target = kind ? OUTPUT_FORMATS[kind] : null;
  el.dataset.status = item.status;

  const icon = el.querySelector('.file-icon');
  icon.textContent = KIND_ICON[kind] ?? '?';
  icon.className = `file-icon${kind ? ` kind-${kind}` : ''}`;

  el.querySelector('.file-source').textContent = item.file.name;
  const targetName = expectedTargetName(item);
  el.querySelector('.file-target').textContent = targetName;
  el.querySelector('.file-arrow').hidden = !targetName;
  el.querySelector('.file-status').textContent = statusText(item);

  const notes = itemNotes(item);
  const note = el.querySelector('.file-note');
  note.hidden = notes.length === 0;
  note.textContent = notes.join(' ');
  note.classList.toggle('note-warning', item.status === 'done' && item.hasMacros && (item.keepMacros || item.result.macrosLost));

  const choice = el.querySelector('.macro-choice');
  choice.hidden = item.status !== 'needs-choice';
  if (target) {
    choice.querySelector('.macro-title').textContent = t('macroTitle');
    choice.querySelector('.macro-remove').textContent = t('macroRemove', target);
    choice.querySelector('.macro-keep').textContent = t('macroKeep', target);
    choice.querySelector('.macro-remove-hint').textContent = t('macroRemoveHint');
    choice.querySelector('.macro-keep-hint').textContent = t('macroKeepHint');
  }

  const download = el.querySelector('.file-download');
  download.hidden = item.status !== 'done';
  if (item.result) {
    download.href = item.result.url;
    download.download = item.result.name;
    download.textContent = t('download');
  }
  const retry = el.querySelector('.file-retry');
  retry.hidden = !(item.status === 'error' && item.error.key === 'errorEngine');
  retry.textContent = t('retry');
  const remove = el.querySelector('.file-remove');
  remove.setAttribute('aria-label', `${t('remove')}: ${item.file.name}`);
  remove.title = t('remove');
}

// ---------------------------------------------------------------------------
// Cache management: only program files are ever stored.

async function clearCache() {
  const keys = await caches.keys();
  if (!keys.length) {
    ui.cacheStatus.textContent = t('cacheEmpty');
    return;
  }
  const before = (await navigator.storage?.estimate?.())?.usage ?? 0;
  await Promise.all(keys.map((key) => caches.delete(key)));
  const after = (await navigator.storage?.estimate?.())?.usage ?? 0;
  engineCached = false;
  renderFirstLoadHint();
  ui.cacheStatus.textContent = t('cacheCleared', { size: formatBytes(Math.max(0, before - after)) });
}

// ---------------------------------------------------------------------------
// Texts and language

function applyTexts() {
  document.documentElement.lang = lang;
  document.title = t('pageTitle');
  document.querySelector('meta[name="description"]').content = t('pageDescription');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  for (const button of document.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
  ui.cacheStatus.textContent = '';
  renderTechText();
  renderEngine();
  for (const item of items) renderItem(item);
}

function setLanguage(next) {
  lang = next;
  t = translator(lang);
  const url = new URL(location.href);
  url.searchParams.set('lang', lang);
  history.replaceState(null, '', url);
  applyTexts();
}

// ---------------------------------------------------------------------------
// Start-up

function showFatal(key) {
  ui.fatal.textContent = t(key);
  ui.fatal.hidden = false;
  ui.dropzone.classList.add('dropzone-disabled');
  ui.chooseFiles.disabled = true;
}

function enableFileInput() {
  ui.fileInput.accept = ACCEPT_ATTRIBUTE;
  ui.chooseFiles.disabled = false;
  ui.chooseFiles.addEventListener('click', (event) => {
    event.stopPropagation();
    ui.fileInput.click();
  });
  ui.dropzone.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => {
    addFiles([...ui.fileInput.files]);
    ui.fileInput.value = '';
  });
  ui.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.dropzone.classList.add('dropzone-active');
  });
  ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('dropzone-active'));
  ui.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropzone.classList.remove('dropzone-active');
    addFiles([...event.dataTransfer.files]);
  });
  ui.downloadAll.addEventListener('click', downloadAll);
  ui.clearList.addEventListener('click', clearList);
}

async function main() {
  for (const button of document.querySelectorAll('[data-lang]')) {
    button.addEventListener('click', () => setLanguage(button.dataset.lang));
  }
  ui.clearCache.addEventListener('click', clearCache);
  // Dropping a file outside the drop zone must not make the browser open (navigate to) it.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  ui.chooseFiles.disabled = true;
  applyTexts();

  const supported =
    'serviceWorker' in navigator && 'Worker' in self && typeof WebAssembly === 'object' &&
    'DecompressionStream' in self && 'BroadcastChannel' in self && 'caches' in self;
  if (!supported) {
    showFatal('fatalUnsupported');
    return;
  }
  if (!(await ensureIsolation())) {
    showFatal('fatalIsolation');
    return;
  }
  enableFileInput();
  await loadManifest();
}

main();
