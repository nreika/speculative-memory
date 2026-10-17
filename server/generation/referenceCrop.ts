/**
 * Rough reference crop of a described person: the position label from the people description
 * ("left front", "center background", "right") becomes a rectangle (third of the frame + padding).
 * No detector is involved; the crop is cut and enlarged inside ComfyUI (ImageCrop + ImageScale).
 * Kept separate so a lightweight "reference frame" feature can reuse it.
 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Image size (width, height) from a JPEG or PNG buffer, or null. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Horizontal third (0 left, 1 center, 2 right) and vertical band from a free-text position label. */
export function parsePosition(label: string): { col: 0 | 1 | 2 | null; row: "front" | "back" | "mid" } {
  const t = String(label || "").toLowerCase();
  const col = /\bleft\b/.test(t) ? 0 : /\bright\b/.test(t) ? 2 : /\b(center|centre|middle)\b/.test(t) ? 1 : null;
  const row = /\b(front|foreground|near|close)\b/.test(t) ? "front" : /\b(back|background|behind|far|rear)\b/.test(t) ? "back" : "mid";
  return { col, row };
}

/** Rectangle in pixels for a position label; the whole frame when the label says nothing useful. */
export function cropRectFor(position: string, width: number, height: number): CropRect {
  const { col, row } = parsePosition(position);
  if (col === null) return { x: 0, y: 0, width, height };
  const pad = 0.08;
  const x0 = Math.max(0, Math.round(width * (col / 3 - pad)));
  const x1 = Math.min(width, Math.round(width * ((col + 1) / 3 + pad)));
  const yTop = row === "front" ? 0.3 : row === "back" ? 0.1 : 0.2;
  const yBottom = row === "front" ? 1 : row === "back" ? 0.75 : 0.9;
  const y0 = Math.round(height * yTop);
  const y1 = Math.round(height * yBottom);
  // ComfyUI crop sizes are safest as multiples of 8
  const w = Math.max(64, Math.floor((x1 - x0) / 8) * 8);
  const h = Math.max(64, Math.floor((y1 - y0) / 8) * 8);
  return { x: Math.min(x0, width - w), y: Math.min(y0, height - h), width: w, height: h };
}
