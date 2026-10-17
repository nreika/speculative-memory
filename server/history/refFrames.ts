/**
 * Lightweight "reference frames": recent frames that showed a person are kept (downscaled) outside the repo and two of
 * them with a different orientation than the current frame are passed to ComfyUI as image2 / image3, so the edit
 * keeps the same face, hair and clothes. No face embedding: the orientation comes from the VLM's people description
 * (facing / position) or, failing that, from keywords in the scene description.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { imageSize, parsePosition } from "../generation/referenceCrop";
import type { SceneHistoryEntry } from "./sceneHistory";

export const DEFAULT_REF_FRAMES_DIR = "C:\\Users\\nmrei\\GitHub\\speculative-memory_data\\ref-frames";

export function refFramesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.REF_FRAMES_ENABLED ?? "false").trim().toLowerCase() === "true";
}
function num(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : def;
}
export function refFramesMax(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.REF_FRAMES_MAX, 2, 1, 2); // image2 + image3 are the only free slots
}
export function refFramesWindowMin(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.REF_FRAMES_WINDOW_MIN, 10, 1, 24 * 60);
}
export function refFramesMaxPx(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.REF_FRAMES_MAX_PX, 768, 64, 4096);
}
export function refFramesDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.REF_FRAMES_DIR || "").trim() || DEFAULT_REF_FRAMES_DIR;
}

// ---------------------------------------------------------------- orientation

export type Facing = "front" | "away" | "left" | "right" | "unknown";
export interface Orientation {
  facing: Facing;
  /** Horizontal third of the person (0 left, 1 center, 2 right) or null. */
  col: 0 | 1 | 2 | null;
  /** e.g. "away@left", "front@center", "unknown". */
  label: string;
}

function facingFromWord(w: string): Facing {
  const t = w.toLowerCase();
  if (/\b(away|behind|back)\b/.test(t)) return "away";
  if (/\b(camera|forward|front|toward|towards)\b/.test(t)) return "front";
  if (/\bleft\b/.test(t)) return "left";
  if (/\bright\b/.test(t)) return "right";
  return "unknown";
}

function facingFromText(text: string): Facing {
  const t = text.toLowerCase();
  if (/(facing away|from behind|back to (the )?camera|backs? (are |is )?turned|turned away|seen from the back)/.test(t)) return "away";
  if (/(facing (the )?camera|toward(s)? the camera|looking at the camera|facing forward|faces? the camera)/.test(t)) return "front";
  if (/(profile|facing left|turned left|looking left|to the left)/.test(t)) return "left";
  if (/(facing right|turned right|looking right|to the right)/.test(t)) return "right";
  return "unknown";
}

export function classifyOrientation(entry: {
  people?: Array<{ position?: string; facing?: string; pose?: string }>;
  sceneDescription?: string;
  observation?: string;
}): Orientation {
  let facing: Facing = "unknown";
  let col: 0 | 1 | 2 | null = null;
  for (const p of entry.people ?? []) {
    const f = facingFromWord(p.facing ?? "") !== "unknown" ? facingFromWord(p.facing ?? "") : facingFromWord(p.pose ?? "");
    if (f !== "unknown") {
      facing = f;
      col = parsePosition(p.position ?? "").col;
      break;
    }
  }
  if (facing === "unknown") facing = facingFromText(`${entry.sceneDescription ?? ""} ${entry.observation ?? ""}`);
  if (col === null && entry.people?.[0]?.position) col = parsePosition(entry.people[0].position).col;
  const colName = col === 0 ? "left" : col === 1 ? "center" : col === 2 ? "right" : "";
  return { facing, col, label: facing === "unknown" && !colName ? "unknown" : `${facing}${colName ? "@" + colName : ""}` };
}

// ------------------------------------------------------------------ selection

export interface RefFrameChoice {
  captureId: string;
  /** Path relative to the ref-frames dir. */
  file: string;
  time: string;
  orientation: string;
  reason: string;
}

function difference(a: Orientation, b: Orientation): number {
  let d = 0;
  if (a.facing !== b.facing) d += a.facing === "unknown" || b.facing === "unknown" ? 1 : 2;
  if (a.col !== null && b.col !== null && a.col !== b.col) d += 1;
  return d;
}

/**
 * Up to `max` candidates (person present, inside the window, own capture excluded, file known): the first is the one
 * that differs most from the current frame, the next ones differ from the current frame and from those already chosen;
 * ties prefer the frame further apart in time.
 */
export function selectRefFrames(
  entries: SceneHistoryEntry[],
  current: { captureId: string; orientation: Orientation },
  opts: { max: number; windowMin: number; now?: number }
): RefFrameChoice[] {
  const now = opts.now ?? Date.now();
  const since = now - opts.windowMin * 60_000;
  const seen = new Set<string>();
  const cands = entries
    .filter((e) => {
      const t = Date.parse(e.time);
      if (!e.hasPerson || !e.refFrameFile || e.captureId === current.captureId) return false;
      if (!Number.isFinite(t) || t < since || t > now + 60_000) return false;
      if (seen.has(e.refFrameFile)) return false;
      seen.add(e.refFrameFile);
      return true;
    })
    .map((e) => ({ e, t: Date.parse(e.time), o: classifyOrientation(e) }));
  const chosen: typeof cands = [];
  const out: RefFrameChoice[] = [];
  while (out.length < opts.max && chosen.length < cands.length) {
    let best: { c: (typeof cands)[number]; score: number; apart: number } | null = null;
    for (const c of cands) {
      if (chosen.includes(c)) continue;
      const score = difference(c.o, current.orientation) * 10 + chosen.reduce((s, x) => s + difference(c.o, x.o), 0) * 3;
      const apart = chosen.length ? Math.min(...chosen.map((x) => Math.abs(x.t - c.t))) : now - c.t;
      if (!best || score > best.score || (score === best.score && apart > best.apart)) best = { c, score, apart };
    }
    if (!best) break;
    chosen.push(best.c);
    const diff = difference(best.c.o, current.orientation);
    const mins = Math.max(0, Math.round((now - best.c.t) / 60_000));
    out.push({
      captureId: best.c.e.captureId,
      file: best.c.e.refFrameFile!,
      time: best.c.e.time,
      orientation: best.c.o.label,
      reason: `${diff > 0 ? "differs from now" : "same orientation as now"} (now ${current.orientation.label} / ref ${best.c.o.label}), ${mins} min ago`,
    });
  }
  return out;
}

// ------------------------------------------------------------------- imaging

/** Downscale a JPEG/PNG so its long side is at most maxPx (JPEG out); returns the input if already small or on failure. */
export async function resizeToMaxPx(buf: Buffer, maxPx: number): Promise<Buffer> {
  const size = imageSize(buf);
  if (size && Math.max(size.width, size.height) <= maxPx) return buf;
  if (process.platform !== "win32") return buf;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refpx-"));
  const inFile = path.join(dir, "in.bin");
  const outFile = path.join(dir, "out.jpg");
  try {
    fs.writeFileSync(inFile, buf);
    const script =
      "Add-Type -AssemblyName System.Drawing;" +
      `$i=[System.Drawing.Image]::FromFile('${inFile}');` +
      `$s=[Math]::Min(1.0,${maxPx}/[Math]::Max($i.Width,$i.Height));` +
      "$w=[Math]::Max(1,[int][Math]::Round($i.Width*$s));$h=[Math]::Max(1,[int][Math]::Round($i.Height*$s));" +
      "$b=New-Object System.Drawing.Bitmap($w,$h);$g=[System.Drawing.Graphics]::FromImage($b);" +
      "$g.InterpolationMode='HighQualityBicubic';$g.DrawImage($i,0,0,$w,$h);$g.Dispose();$i.Dispose();" +
      `$b.Save('${outFile}',[System.Drawing.Imaging.ImageFormat]::Jpeg);$b.Dispose()`;
    await new Promise<void>((resolve, reject) => {
      const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      const timer = setTimeout(() => { p.kill(); reject(new Error("resize timed out")); }, 15_000);
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`resize exit ${code}`)); });
    });
    return fs.readFileSync(outFile);
  } catch (err) {
    console.error("[ref] resize failed, using the original:", (err as Error).message);
    return buf;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "frame";
}

/** Saves a downscaled copy of the frame as <dir>/<YYYY-MM-DD>/<captureId>.jpg and returns the relative path (or null). */
export async function saveRefFrame(
  frame: Buffer,
  captureId: string,
  time: string,
  opts: { dir?: string; maxPx?: number } = {}
): Promise<string | null> {
  try {
    const dir = opts.dir ?? refFramesDir();
    const d = new Date(time);
    const day = Number.isNaN(d.getTime()) ? new Date() : d;
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const rel = `${date}/${safeName(captureId)}.jpg`;
    const small = await resizeToMaxPx(frame, opts.maxPx ?? refFramesMaxPx());
    fs.mkdirSync(path.join(dir, date), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), small);
    return rel;
  } catch (err) {
    console.error("[ref] save failed (continuing):", (err as Error).message);
    return null;
  }
}

/** Reads the chosen frames as JPEG/PNG data URLs (re-shrunk if the limit shrank since they were saved). */
export async function loadRefFrameDataUrls(
  choices: RefFrameChoice[],
  opts: { dir?: string; maxPx?: number } = {}
): Promise<Array<{ choice: RefFrameChoice; dataUrl: string }>> {
  const dir = opts.dir ?? refFramesDir();
  const out: Array<{ choice: RefFrameChoice; dataUrl: string }> = [];
  for (const choice of choices) {
    try {
      const abs = path.resolve(dir, choice.file);
      if (!abs.startsWith(path.resolve(dir))) continue;
      const buf = await resizeToMaxPx(fs.readFileSync(abs), opts.maxPx ?? refFramesMaxPx());
      const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
      out.push({ choice, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
    } catch {
      /* file missing: skip */
    }
  }
  return out;
}

/** Moves everything in the ref-frames dir (except _archive) to <dir>/_archive/<Tokyo time>/ (never deletes). */
export function resetRefFrames(dir = refFramesDir(), now = new Date()): string | null {
  if (!fs.existsSync(dir)) return null;
  const items = fs.readdirSync(dir).filter((n) => n !== "_archive");
  if (items.length === 0) return null;
  const tokyo = new Date(now.getTime() + 9 * 3600_000).toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const dest = path.join(dir, "_archive", `${tokyo}_JST`);
  fs.mkdirSync(dest, { recursive: true });
  for (const n of items) fs.renameSync(path.join(dir, n), path.join(dest, n));
  return dest;
}
