/**
 * Mechanical check (2026-10-21): a person must stay where and how big they are in NOW. QA found far / small / edge-cropped people
 * pulled to the near desk and enlarged (a tiny far person drawn 300 px tall at the front desk).
 * Boxes are [x1,y1,x2,y2] in pixels of their own image.
 */
export interface Dims { width: number; height: number }
export const PERSON_FRAME_LIMITS = { maxGrow: 1.6, minShrink: 0.55, maxShift: 0.25 };

export function personFrameShift(source: number[], sourceDims: Dims, output: number[], outputDims: Dims, limits = PERSON_FRAME_LIMITS): string | null {
  const ok = (b: number[], d: Dims) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[3] > b[1] && b[2] > b[0] && d.width > 0 && d.height > 0;
  if (!ok(source, sourceDims) || !ok(output, outputDims)) return null;
  const sh = (source[3] - source[1]) / sourceDims.height, oh = (output[3] - output[1]) / outputDims.height;
  const scx = (source[0] + source[2]) / 2 / sourceDims.width, ocx = (output[0] + output[2]) / 2 / outputDims.width;
  const ratio = oh / sh, shift = Math.abs(ocx - scx);
  if (ratio > limits.maxGrow) return `the person is ${ratio.toFixed(1)}x taller in the output than in the input (${Math.round(oh * 100)}% vs ${Math.round(sh * 100)}% of the frame height)`;
  if (ratio < limits.minShrink) return `the person is only ${ratio.toFixed(2)}x of the input size`;
  if (shift > limits.maxShift) return `the person moved ${Math.round(shift * 100)}% of the frame width sideways`;
  return null;
}
