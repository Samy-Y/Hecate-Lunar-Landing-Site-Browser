/**
 * Binary tile fetcher: streamed download with progress + transparent gzip.
 * Works whether or not the static server applied Content-Encoding (gzip magic check).
 */
import type { FileEntry, NumArray } from './types';

export const DATA_ROOT = `${import.meta.env.BASE_URL}data/`;

export async function fetchBuffer(url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  let bytes: Uint8Array;
  if (res.body && onBytes) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      onBytes(value.length);
    }
    bytes = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.length;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(ds).arrayBuffer();
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function viewAs(dtype: FileEntry['dtype'], buf: ArrayBuffer): NumArray {
  switch (dtype) {
    case 'int16':
      return new Int16Array(buf);
    case 'uint16':
      return new Uint16Array(buf);
    case 'float32':
      return new Float32Array(buf);
    default:
      return new Uint8Array(buf);
  }
}

/** Apply scale/offset into a fresh Float32Array. */
export function toFloat(a: ArrayLike<number>, scale: number, offset = 0): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * scale + offset;
  return out;
}

export async function fetchEntry(entry: FileEntry, onBytes?: (n: number) => void): Promise<NumArray> {
  return viewAs(entry.dtype, await fetchBuffer(DATA_ROOT + entry.path, onBytes));
}
