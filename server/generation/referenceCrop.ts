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

/** Matches the deployed ImageScale node's 16384-pixel edge limit; never distorts a reference. */
export function referenceScaleSize(width:number,height:number):{width:number;height:number}{
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw Error('Invalid reference dimensions');
  const scaledWidth=Math.max(64,Math.round(width*768/height/8)*8);
  if(!Number.isSafeInteger(scaledWidth)||scaledWidth>16384)throw Error('Reference aspect ratio exceeds the ComfyUI ImageScale 16384-pixel limit');
  return {width:scaledWidth,height:768};
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

/** Visible face/hair bounds from recognition, normalized to 0..1000. */
export function parseHeadBox(raw: unknown): [number,number,number,number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1000)) return undefined;
  const [x0,y0,x1,y1]=raw;
  if(x1-x0<16 || y1-y0<16) return undefined;
  return [x0,y0,x1,y1];
}
export function headCropFor(raw: unknown,width:number,height:number):CropRect|undefined {
  const box=parseHeadBox(raw);if(!box)return undefined;
  const [x0,y0,x1,y1]=box;
  const left=Math.max(0,Math.floor(x0*width/1000));
  const top=Math.max(0,Math.floor(y0*height/1000));
  const w=Math.max(64,Math.ceil((x1-x0)*width/8000)*8);
  const h=Math.max(64,Math.ceil((y1-y0)*height/8000)*8);
  if(w>width||h>height)return undefined;
  return {x:Math.min(left,width-w),y:Math.min(top,height-h),width:w,height:h};
}

/**
 * G-13 behind-view identity reference: the full head + shoulders + torso of the recent person (never a tight head crop,
 * where coloured hair tips can dominate and the image model paints the whole hair in the tip colour). Built around the
 * recorded head_box (head about 1/7 of the figure height, three head widths wide); the position-third crop when no
 * usable head_box exists.
 */
export function figureCropFor(headBox: unknown, position: string, width: number, height: number): CropRect {
  const box = parseHeadBox(headBox);
  if (!box) return cropRectFor(position, width, height);
  const [bx0, by0, bx1, by1] = box.map((v, i) => (v * (i % 2 === 0 ? width : height)) / 1000);
  const hw = bx1 - bx0, hh = by1 - by0, cx = (bx0 + bx1) / 2;
  const half = Math.max(hw * 1.6, width * 0.11);
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(width, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(by0 - hh * 0.3));
  const y1 = Math.min(height, Math.ceil(by0 + hh * 7.5));
  const w = Math.min(width, Math.max(64, Math.floor((x1 - x0) / 8) * 8));
  const h = Math.min(height, Math.max(64, Math.floor((y1 - y0) / 8) * 8));
  return { x: Math.max(0, Math.min(x0, width - w)), y: Math.max(0, Math.min(y0, height - h)), width: w, height: h };
}
