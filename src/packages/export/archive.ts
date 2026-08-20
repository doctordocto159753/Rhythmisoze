/**
 * Small deterministic ZIP writer for the local export bundle.
 *
 * Audio/MIDI are already compressed or compact, so STORE avoids a new runtime
 * dependency and avoids blocking the main thread on redundant compression.
 */

export interface ArchiveEntry {
  name: string;
  data: Blob | Uint8Array | string;
}

interface PreparedEntry {
  name: Uint8Array;
  bytes: Uint8Array;
  crc: number;
  offset: number;
}

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;

export async function createExportArchive(entries: readonly ArchiveEntry[]): Promise<Blob> {
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const safeName = safeArchivePath(entry.name);
    const name = encoder.encode(safeName);
    const bytes = await toBytes(entry.data);
    const localSize = 30 + name.length + bytes.length;
    prepared.push({ name, bytes, crc: crc32(bytes), offset });
    offset += localSize;
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  for (const entry of prepared) {
    const local = new Uint8Array(30 + entry.name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, ZIP_VERSION, true);
    localView.setUint16(6, UTF8_FLAG, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, entry.crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    localParts.push(local, entry.bytes);

    const central = new Uint8Array(46 + entry.name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, ZIP_VERSION, true);
    centralView.setUint16(6, ZIP_VERSION, true);
    centralView.setUint16(8, UTF8_FLAG, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint16(16, 0x0021, true);
    centralView.setUint32(18, entry.crc, true);
    centralView.setUint32(22, entry.bytes.length, true);
    centralView.setUint32(26, entry.bytes.length, true);
    centralView.setUint16(30, entry.name.length, true);
    centralView.setUint32(42, entry.offset, true);
    central.set(entry.name, 46);
    centralParts.push(central);
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, prepared.length, true);
  endView.setUint16(10, prepared.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);

  const parts = [...localParts, ...centralParts, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return new Blob([output.buffer], { type: 'application/zip' });
}

function safeArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map((part) => part.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter(Boolean);
  return parts.join('/') || 'file';
}

async function toBytes(data: ArchiveEntry['data']): Promise<Uint8Array> {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(await data.arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
