/**
 * Machine check for the skin "screen-door" grid (HANDOVER 10-16: ImageSharpen amplified a 2 px periodic residue).
 * Skin-coloured 32 px tiles, Hann window, 2-D FFT: median over tiles of log10(power in the high band >= 0.375 cycles/px
 * / power in the mid band 0.1-0.25). Above -0.1 (whole image) or -0.6 (face rectangle only) = grid suspected.
 * Fewer than 3 skin tiles = no verdict. PNG only (8-bit RGB/RGBA, not interlaced); anything else = null.
 */
import zlib from 'node:zlib';

export const GRID_THRESHOLD_IMAGE = -0.1;
export const GRID_THRESHOLD_FACE = -0.6;
const TILE = 32;

export interface Pixels {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Buffer;
}

export function decodePng(buf: Buffer): Pixels | null {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) return null;
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || idat.length === 0) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) return null;
      out[dst + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

const HANN = Array.from({ length: TILE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (TILE - 1)));

function isSkin(r: number, g: number, b: number): boolean {
  return r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15 && r < 250;
}

/** log10(high/mid) of one tile; null when the tile is flat. */
function tileScore(px: Pixels, x0: number, y0: number): number | null {
  const re = new Float64Array(TILE * TILE);
  const im = new Float64Array(TILE * TILE);
  let mean = 0;
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const i = ((y0 + y) * px.width + x0 + x) * px.channels;
      const l = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
      re[y * TILE + x] = l;
      mean += l;
    }
  mean /= TILE * TILE;
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) re[y * TILE + x] = (re[y * TILE + x] - mean) * HANN[y] * HANN[x];
  const rr = new Float64Array(TILE);
  const ri = new Float64Array(TILE);
  for (let y = 0; y < TILE; y++) {
    rr.set(re.subarray(y * TILE, (y + 1) * TILE));
    ri.fill(0);
    fft(rr, ri);
    re.set(rr, y * TILE);
    im.set(ri, y * TILE);
  }
  for (let x = 0; x < TILE; x++) {
    for (let y = 0; y < TILE; y++) {
      rr[y] = re[y * TILE + x];
      ri[y] = im[y * TILE + x];
    }
    fft(rr, ri);
    for (let y = 0; y < TILE; y++) {
      re[y * TILE + x] = rr[y];
      im[y * TILE + x] = ri[y];
    }
  }
  let hi = 0;
  let nHi = 0;
  let mid = 0;
  let nMid = 0;
  for (let ky = 0; ky < TILE; ky++)
    for (let kx = 0; kx < TILE; kx++) {
      const fx = (kx > TILE / 2 ? kx - TILE : kx) / TILE;
      const fy = (ky > TILE / 2 ? ky - TILE : ky) / TILE;
      const f = Math.hypot(fx, fy);
      const p = re[ky * TILE + kx] ** 2 + im[ky * TILE + kx] ** 2;
      if (f >= 0.375) {
        hi += p;
        nHi++;
      } else if (f >= 0.1 && f <= 0.25) {
        mid += p;
        nMid++;
      }
    }
  if (!nHi || !nMid || mid <= 0 || hi <= 0) return null;
  return Math.log10(hi / nHi / (mid / nMid));
}

export interface GridResult {
  tiles: number;
  /** Median log10(high/mid) over the skin tiles; null when fewer than 3 tiles. */
  score: number | null;
  suspected: boolean;
}

/** `rect` restricts the check to a face rectangle (stricter threshold). */
export function gridScore(png: Buffer, rect?: { x: number; y: number; width: number; height: number }): GridResult | null {
  const px = decodePng(png);
  if (!px) return null;
  const scores: number[] = [];
  const x1 = rect ? Math.min(px.width, rect.x + rect.width) : px.width;
  const y1 = rect ? Math.min(px.height, rect.y + rect.height) : px.height;
  for (let y = rect ? Math.max(0, rect.y) : 0; y + TILE <= y1; y += TILE)
    for (let x = rect ? Math.max(0, rect.x) : 0; x + TILE <= x1; x += TILE) {
      let skin = 0;
      for (let j = 0; j < TILE; j += 2)
        for (let i = 0; i < TILE; i += 2) {
          const k = ((y + j) * px.width + x + i) * px.channels;
          if (isSkin(px.data[k], px.data[k + 1], px.data[k + 2])) skin++;
        }
      if (skin < 0.7 * (TILE / 2) ** 2) continue;
      const s = tileScore(px, x, y);
      if (s !== null) scores.push(s);
    }
  if (scores.length < 3) return { tiles: scores.length, score: null, suspected: false };
  scores.sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  return { tiles: scores.length, score: Math.round(median * 1000) / 1000, suspected: median > (rect ? GRID_THRESHOLD_FACE : GRID_THRESHOLD_IMAGE) };
}
