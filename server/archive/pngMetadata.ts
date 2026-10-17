/**
 * Dependency-free PNG text metadata: insert tEXt/iTXt chunks right after IHDR and read them back.
 *
 * Values that fit Latin-1 are written as tEXt (the PNG standard text chunk); anything else
 * (e.g. Japanese scenario text) is written as an uncompressed UTF-8 iTXt chunk, because tEXt
 * cannot carry it. Both are returned by readPngText.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const isLatin1 = (s: string) => /^[\u0000-ÿ]*$/.test(s);

function textChunk(keyword: string, value: string): Buffer {
  // PNG keywords: 1-79 Latin-1 chars, no leading/trailing/double spaces.
  const key = keyword.replace(/[^\x20-\x7e]/g, '_').slice(0, 79) || 'Comment';
  if (isLatin1(value) && !value.includes('\u0000')) {
    return makeChunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
  }
  // iTXt: keyword\0 compressionFlag(0) compressionMethod(0) language\0 translatedKeyword\0 text(UTF-8)
  return makeChunk(
    'iTXt',
    Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(value, 'utf8')])
  );
}

/** Returns a copy of `png` with the given text entries inserted after IHDR. Throws on a non-PNG. */
export function embedPngText(png: Buffer, entries: Record<string, string | number | undefined | null>): Buffer {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('embedPngText: not a PNG');
  }
  const ihdrLen = png.readUInt32BE(8);
  if (png.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('embedPngText: IHDR missing');
  const insertAt = 8 + 4 + 4 + ihdrLen + 4;
  const chunks = Object.entries(entries)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => textChunk(k, String(v)));
  return Buffer.concat([png.subarray(0, insertAt), ...chunks, png.subarray(insertAt)]);
}

/** Reads every tEXt / uncompressed iTXt entry of a PNG (later duplicates win). */
export function readPngText(png: Buffer): Record<string, string> {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('readPngText: not a PNG');
  const out: Record<string, string> = {};
  let pos = 8;
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('latin1');
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) out[data.subarray(0, nul).toString('latin1')] = data.subarray(nul + 1).toString('latin1');
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && data[nul + 1] === 0) {
        // skip compression flag/method, language\0, translated keyword\0
        let p = nul + 3;
        p = data.indexOf(0, p) + 1;
        p = data.indexOf(0, p) + 1;
        out[data.subarray(0, nul).toString('latin1')] = data.subarray(p).toString('utf8');
      }
    }
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  return out;
}
