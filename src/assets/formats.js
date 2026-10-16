// Supported legacy input formats and the modern formats they are converted to.
// Only formats that the bundled LibreOffice WebAssembly build can actually read are listed.

export const INPUT_FORMATS = {
  // Word
  doc: { kind: 'text', cfb: true },
  dot: { kind: 'text', cfb: true, template: true },
  rtf: { kind: 'text' },
  // Excel
  xls: { kind: 'sheet', cfb: true },
  xlt: { kind: 'sheet', cfb: true, template: true },
  // Lotus 1-2-3 / Microsoft Works spreadsheets
  wk1: { kind: 'sheet' },
  wk3: { kind: 'sheet' },
  wk4: { kind: 'sheet' },
  wks: { kind: 'sheet' },
  123: { kind: 'sheet' },
  // PowerPoint
  ppt: { kind: 'slides', cfb: true },
  pps: { kind: 'slides', cfb: true },
  pot: { kind: 'slides', cfb: true, template: true },
};

export const OUTPUT_FORMATS = {
  text: { plain: 'docx', macro: 'docm' },
  sheet: { plain: 'xlsx', macro: 'xlsm' },
  slides: { plain: 'pptx', macro: 'pptm' },
};

export const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
};

export const ACCEPT_ATTRIBUTE = Object.keys(INPUT_FORMATS).map((ext) => `.${ext}`).join(',');

export function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function baseNameOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function formatFor(filename) {
  return INPUT_FORMATS[extensionOf(filename)] ?? null;
}
