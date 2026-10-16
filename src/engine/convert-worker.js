// Conversion worker: runs LibreOffice (compiled to WebAssembly) and converts documents.
// Documents only ever exist in this worker's in-memory file system and are deleted
// right after each conversion. Nothing is sent over the network.
//
// Everything is wrapped in a function scope because soffice.js is loaded into the same
// global scope via importScripts() and declares a large number of globals itself.
(() => {
  'use strict';

  const BASE_URL = new URL('./', self.location.href).href;
  const DEBUG = new URL(self.location.href).searchParams.has('debug');

  // LibreOfficeKit document types → output formats (plain / with macros).
  const TARGETS = {
    0: { plain: 'docx', macro: 'docm' }, // text
    1: { plain: 'xlsx', macro: 'xlsm' }, // spreadsheet
    2: { plain: 'pptx', macro: 'pptm' }, // presentation
  };

  let engine = null;
  let lok = 0;
  let ready = null;

  class ConversionError extends Error {
    constructor(code, detail) {
      super(detail ? `${code}: ${detail}` : code);
      this.code = code;
    }
  }

  function startEngine() {
    return new Promise((resolve, reject) => {
      self.Module = {
        mainScriptUrlOrBlob: BASE_URL + 'soffice.js',
        locateFile: (path) => BASE_URL + path,
        print: DEBUG ? console.log.bind(console) : () => {},
        printErr: DEBUG ? console.warn.bind(console) : () => {},
        onRuntimeInitialized: resolve,
        onAbort: (what) => reject(new ConversionError('engine-abort', String(what))),
      };
      try {
        importScripts(BASE_URL + 'soffice.js');
      } catch (error) {
        reject(error);
      }
    }).then(() => {
      engine = self.Module;
      engine.ENV.MAX_CONCURRENCY = '1';
      engine.FS.mkdirTree('/tmp/in');
      engine.FS.mkdirTree('/tmp/out');
      lok = engine.ccall('libreofficekit_hook', 'number', ['string'], ['/instdir/program']);
      if (!lok) throw new ConversionError('engine-init');
      // In a browser worker there is no separate event loop thread: process LibreOffice's
      // internal events synchronously, otherwise loading a document never finishes.
      engine.ccall('lok_enableSyncEvents', null, [], []);
    });
  }

  function lastError() {
    return engine.ccall('lok_getError', 'string', ['number'], [lok]) || '';
  }

  // The ZIP central directory stores file names uncompressed, so a byte search is enough.
  const VBA_PROJECT = new TextEncoder().encode('vbaProject.bin');
  function containsVbaProject(bytes) {
    for (let i = bytes.indexOf(VBA_PROJECT[0]); i !== -1; i = bytes.indexOf(VBA_PROJECT[0], i + 1)) {
      if (i + VBA_PROJECT.length > bytes.length) return false;
      if (VBA_PROJECT.every((b, j) => bytes[i + j] === b)) return true;
    }
    return false;
  }

  function convert({ data, ext, keepMacros }) {
    const FS = engine.FS;
    // Fixed internal names: the original file name never enters the engine.
    const inPath = `/tmp/in/document.${/^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin'}`;
    const created = [inPath];
    let doc = 0;
    try {
      FS.writeFile(inPath, new Uint8Array(data));
      doc = engine.ccall('lok_documentLoad', 'number', ['number', 'string'], [lok, 'file://' + inPath]);
      if (!doc) throw new ConversionError('load-failed', lastError());

      const type = engine.ccall('lok_documentGetDocumentType', 'number', ['number'], [doc]);
      const target = TARGETS[type];
      if (!target) throw new ConversionError('unsupported-type', String(type));

      const save = (format) => {
        const outPath = `/tmp/out/document.${format}`;
        created.push(outPath);
        const ok = engine.ccall('lok_documentSaveAs', 'number', ['number', 'string', 'string', 'string'], [doc, 'file://' + outPath, format, '']);
        if (!ok) throw new ConversionError('save-failed', lastError());
        const out = FS.readFile(outPath);
        if (!out.length) throw new ConversionError('save-failed', 'empty output');
        return out.slice(); // copy out of the engine's memory
      };

      let format = keepMacros ? target.macro : target.plain;
      let out = save(format);
      let macrosLost = false;
      if (keepMacros && !containsVbaProject(out)) {
        // The engine could not carry the macros over: deliver an honest macro-free file instead.
        macrosLost = true;
        format = target.plain;
        out = save(format);
      }
      return { format, data: out.buffer, macrosLost };
    } finally {
      if (doc) engine.ccall('lok_documentDestroy', null, ['number'], [doc]);
      for (const path of created) {
        try {
          FS.unlink(path);
        } catch {
          // file was never written
        }
      }
    }
  }

  self.onmessage = async ({ data: message }) => {
    const { id, type } = message;
    try {
      if (type === 'init') {
        ready ??= startEngine();
        await ready;
        self.postMessage({ id, ok: true });
      } else if (type === 'convert') {
        await ready;
        const result = convert(message);
        self.postMessage({ id, ok: true, ...result }, [result.data]);
      }
    } catch (error) {
      self.postMessage({ id, ok: false, code: error?.code || 'engine-crash', message: String(error?.message || error) });
    }
  };
})();
