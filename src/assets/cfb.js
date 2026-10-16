// Minimal reader for the Compound File Binary format (the container of .doc, .xls and .ppt files)
// plus VBA macro detection. Spec: [MS-CFB], [MS-DOC], [MS-XLS], [MS-PPT].

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;
const MAX_REGULAR_SECTOR = 0xfffffffa;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

export function isCompoundFile(bytes) {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

// Returns { entries, children(index), readStream(entry) } or null if the data is not a valid compound file.
export function readCompoundFile(bytes) {
  if (!isCompoundFile(bytes)) return null;
  try {
    return parse(bytes);
  } catch {
    return null;
  }
}

function parse(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset) => view.getUint32(offset, true);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('bad sector size');
  const miniStreamCutoff = u32(0x38);
  const sectorOffset = (sector) => (sector + 1) * sectorSize;
  const sectorCount = Math.ceil(bytes.length / sectorSize);

  // Collect FAT sector numbers from the header DIFAT and the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const sector = u32(0x4c + i * 4);
    if (sector <= MAX_REGULAR_SECTOR) fatSectors.push(sector);
  }
  let difatSector = u32(0x44);
  for (let guard = 0; difatSector <= MAX_REGULAR_SECTOR && guard < sectorCount; guard++) {
    const base = sectorOffset(difatSector);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const sector = u32(base + i * 4);
      if (sector <= MAX_REGULAR_SECTOR) fatSectors.push(sector);
    }
    difatSector = u32(base + perSector * 4);
  }

  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((sector, n) => {
    const base = sectorOffset(sector);
    for (let i = 0; i < sectorSize / 4; i++) fat[n * (sectorSize / 4) + i] = u32(base + i * 4);
  });

  const chain = (start, table) => {
    const sectors = [];
    for (let s = start; s !== END_OF_CHAIN && s <= MAX_REGULAR_SECTOR; s = table[s]) {
      if (sectors.length > table.length || s >= table.length) throw new Error('broken chain');
      sectors.push(s);
    }
    return sectors;
  };

  const readChain = (start, size) => {
    const out = new Uint8Array(size);
    let pos = 0;
    for (const sector of chain(start, fat)) {
      if (pos >= size) break;
      const base = sectorOffset(sector);
      const len = Math.min(sectorSize, size - pos, bytes.length - base);
      if (len <= 0) throw new Error('sector out of range');
      out.set(bytes.subarray(base, base + len), pos);
      pos += len;
    }
    return out;
  };

  // Directory entries (128 bytes each).
  const dirSectors = chain(u32(0x30), fat);
  const entries = [];
  for (const sector of dirSectors) {
    const base = sectorOffset(sector);
    for (let off = 0; off < sectorSize; off += 128) {
      const e = base + off;
      if (e + 128 > bytes.length) break;
      const nameLength = Math.min(view.getUint16(e + 0x40, true), 64);
      let name = '';
      for (let i = 0; i + 2 < nameLength; i += 2) name += String.fromCharCode(view.getUint16(e + i, true));
      entries.push({
        name,
        type: bytes[e + 0x42],
        left: u32(e + 0x44),
        right: u32(e + 0x48),
        child: u32(e + 0x4c),
        start: u32(e + 0x74),
        size: u32(e + 0x78),
      });
    }
  }
  const root = entries[0];
  if (!root || root.type !== TYPE_ROOT) throw new Error('missing root entry');

  // Mini stream (holds streams smaller than the cutoff, 64-byte sectors).
  let miniFat = null;
  let miniStream = null;
  const loadMini = () => {
    if (miniStream) return;
    const miniFatSectors = chain(u32(0x3c), fat);
    miniFat = new Uint32Array(miniFatSectors.length * (sectorSize / 4));
    miniFatSectors.forEach((sector, n) => {
      const base = sectorOffset(sector);
      for (let i = 0; i < sectorSize / 4; i++) miniFat[n * (sectorSize / 4) + i] = u32(base + i * 4);
    });
    miniStream = readChain(root.start, root.size);
  };

  const readStream = (entry) => {
    if (entry.type !== TYPE_STREAM) return null;
    if (entry.size >= miniStreamCutoff) return readChain(entry.start, entry.size);
    loadMini();
    const out = new Uint8Array(entry.size);
    let pos = 0;
    for (const sector of chain(entry.start, miniFat)) {
      if (pos >= entry.size) break;
      const base = sector * miniSectorSize;
      const len = Math.min(miniSectorSize, entry.size - pos);
      if (base + len > miniStream.length) throw new Error('mini sector out of range');
      out.set(miniStream.subarray(base, base + len), pos);
      pos += len;
    }
    return out;
  };

  // Children of a storage are kept in a red-black tree; walk it iteratively.
  const children = (index) => {
    const result = [];
    const stack = [entries[index]?.child];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined || id === NO_STREAM || id >= entries.length || seen.has(id)) continue;
      seen.add(id);
      const entry = entries[id];
      result.push(entry);
      stack.push(entry.left, entry.right);
    }
    return result;
  };

  return { entries, children, readStream };
}

// Returns true if a legacy Word/Excel/PowerPoint file contains a VBA project.
// Embedded objects (e.g. an Excel sheet inside a Word file) are deliberately ignored.
export function hasVbaMacros(bytes) {
  const cfb = readCompoundFile(bytes);
  if (!cfb) return false;
  const top = cfb.children(0);
  const storage = (name) => top.some((e) => e.type === TYPE_STORAGE && e.name === name);

  // Word 97+: "Macros" storage; Excel 97+: "_VBA_PROJECT_CUR"; Excel 5/95: "_VBA_PROJECT".
  if (storage('Macros') || storage('_VBA_PROJECT_CUR') || storage('_VBA_PROJECT')) return true;

  // PowerPoint keeps the VBA project inside the "PowerPoint Document" stream, referenced from
  // a VBAInfoContainer record in the DocInfoListContainer of the DocumentContainer.
  const pptStream = top.find((e) => e.type === TYPE_STREAM && e.name === 'PowerPoint Document');
  if (pptStream) {
    const data = cfb.readStream(pptStream);
    return data ? pptHasVbaInfo(data) : false;
  }
  return false;
}

const RT_DOCUMENT = 0x03e8;
const RT_DOC_INFO_LIST = 0x07d0;
const RT_VBA_INFO = 0x03ff;
const RT_VBA_INFO_ATOM = 0x0400;

function pptHasVbaInfo(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Calls visit(type, start, end) for each record in [start, end); stops early if visit returns true.
  const records = (start, end, visit) => {
    let pos = start;
    while (pos + 8 <= end) {
      const type = view.getUint16(pos + 2, true);
      const recordEnd = pos + 8 + view.getUint32(pos + 4, true);
      if (recordEnd > end) return false;
      if (visit(type, pos + 8, recordEnd)) return true;
      pos = recordEnd;
    }
    return false;
  };
  // VBAInfoAtom: persistIdRef (u32), fHasMacros (u32), version (u32). PowerPoint also writes
  // empty containers (persistIdRef = 0, fHasMacros = 0) into files without macros.
  const vbaInfoHasMacros = (start, end) =>
    records(start, end, (type, atomStart, atomEnd) =>
      type === RT_VBA_INFO_ATOM &&
      atomEnd - atomStart >= 8 &&
      view.getUint32(atomStart, true) !== 0 &&
      view.getUint32(atomStart + 4, true) !== 0);
  const isVbaInfo = (type, start, end) => type === RT_VBA_INFO && vbaInfoHasMacros(start, end);

  return records(0, data.length, (type, start, end) =>
    type === RT_DOCUMENT &&
    records(start, end, (childType, childStart, childEnd) =>
      isVbaInfo(childType, childStart, childEnd) ||
      (childType === RT_DOC_INFO_LIST && records(childStart, childEnd, isVbaInfo))));
}
