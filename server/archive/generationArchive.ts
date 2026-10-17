/**
 * Per-capture archive: one folder with the source frame, the generated images (PNG text
 * metadata embedded) and the full prompts. Purely additive: every method swallows its own
 * errors so a full disk or a bad path can never stop a generation.
 *
 *   <root>/<YYYY-MM-DD>/<generationId>/<generationId>_NOW.jpg | _A.png | _B.png | _prompts.json | _README.txt
 *
 * generationId = the source frame's capture timestamp (captures/record_<id>.<ext>).
 */
import fs from 'node:fs';
import path from 'node:path';
import { embedPngText } from './pngMetadata';

export const DEFAULT_ARCHIVE_DIR = 'C:\\Users\\nmrei\\GitHub\\speculative-memory_data\\generations';

export function archiveRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GENERATION_ARCHIVE_DIR || '').trim() || DEFAULT_ARCHIVE_DIR;
}

/** "record_2026-10-15_06-08-12.jpg" -> "2026-10-15_06-08-12" (null if it does not match). */
export function generationIdFromFilename(filename: string | null | undefined): string | null {
  const m = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.[A-Za-z0-9]+$/.exec(filename || '');
  return m ? m[1] : null;
}

export interface ArchiveContext {
  generationId: string;
  captureId: string;
  source: string;
  capturedAt: string;
  backend: string;
  vlmModel: string;
  imageModel: string;
  /** Actual per-step backends ('local' | 'gemini'), after any fallback. */
  vlmBackend?: string;
  imageBackend?: string;
  params: { sceneDistancesSec: number[]; presence: number; tone: number; imageCount: number };
  /** Rulebook version in force for this generation (rulebook/active.json). */
  rulebookVersion?: number | null;
}

export interface ArchiveScene {
  sceneKey: string;
  distanceSec: number;
  label: string;
  predictionPrompt: string;
  scenarioDescription: string;
  imagePromptFull: string | null;
  /** TD sceneExtras entry for this scene ("must include"), if any. */
  sceneExtra?: string | null;
  /** Whether the extra was judged to be reflected in the scenario text (null = not checked). */
  sceneExtraReflected?: boolean | null;
  /** The recent person was drawn from behind (empty frame + recent-person allowance). */
  behindView?: boolean;
  /** The same-scale / original-place sentence was part of the image prompt. */
  scaleRule?: boolean;
  /** Reference crop (pixels) used for that person, or null when the whole frame was passed. */
  referenceCrop?: { x: number; y: number; width: number; height: number } | null;
  negativePrompt: string | null;
  seed: number | null;
  /** First-pass denoise when lowered (obstructed captures); null = production default 1.0. */
  denoise?: number | null;
  elapsedMs: number;
  /** Actual image backend / model of this scene; referenceImage: recent-person reference photo 'attached' | 'none'. */
  imageBackend?: string;
  imageModel?: string;
  referenceImage?: string | null;
  /** Recent person frames attached as image2/image3 (REF_FRAMES_ENABLED), with why each was chosen. */
  refFrames?: Array<{ captureId: string; file: string; time: string; orientation: string; reason: string }>;
}

/** Human-readable time position of a scene: "+150s", "2分30秒先の未来", "2 minutes 30 seconds into the future". */
export function temporalLabels(distanceSec: number) {
  const abs = Math.abs(Math.round(distanceSec));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const ja = (m ? `${m}分` : '') + (s || !m ? `${s}秒` : '');
  const en = [m ? `${m} minute${m === 1 ? '' : 's'}` : '', s || !m ? `${s} second${s === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' ');
  if (abs === 0) return { temporalOffset: '+0s', temporalLabelJa: '現在', temporalLabelEn: 'now' };
  const future = distanceSec > 0;
  return {
    temporalOffset: `${future ? '+' : '-'}${abs}s`,
    temporalLabelJa: future ? `${ja}先の未来` : `${ja}前の過去`,
    temporalLabelEn: `${en} into the ${future ? 'future' : 'past'}`,
  };
}

export const sceneLetter = (index: number) => String.fromCharCode(65 + index);

export class GenerationArchive {
  readonly dir: string;
  private readonly startedAt = Date.now();
  private readonly doc: Record<string, any>;
  private readonly scenes: any[] = [];
  private readonly errors: string[] = [];
  private readonly timings: Record<string, number> = {};
  private sourceFile: string | null = null;

  constructor(private readonly ctx: ArchiveContext, root: string = archiveRootDir()) {
    this.dir = path.join(root, ctx.generationId.slice(0, 10), ctx.generationId);
    this.doc = {
      // Reserved names for the continuous image QA (rulebook G-11 / G-13); not produced by the generator itself.
      reservedQaClasses: ['arms_raised', 'hair_mismatch'],
      generationId: ctx.generationId,
      captureId: ctx.captureId,
      source: ctx.source,
      capturedAt: ctx.capturedAt,
      backend: ctx.backend,
      vlmBackend: ctx.vlmBackend ?? null,
      vlmModel: ctx.vlmModel,
      imageBackend: ctx.imageBackend ?? null,
      imageModel: ctx.imageModel,
      params: ctx.params,
      rulebookVersion: ctx.rulebookVersion ?? null,
      refFramesEnabled: process.env.REF_FRAMES_ENABLED?.trim().toLowerCase() === 'true',
      vlm: null,
      nowText: '',
      scenes: this.scenes,
      timings: this.timings,
      errors: this.errors,
      status: 'running',
    };
    this.safe(() => fs.mkdirSync(this.dir, { recursive: true }));
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch (error) {
      console.error('generationArchive: write failed (generation continues):', error);
    }
  }

  private name(suffix: string) {
    return `${this.ctx.generationId}_${suffix}`;
  }

  saveSource(buffer: Buffer, extension: string) {
    this.safe(() => {
      const ext = extension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'jpg';
      this.sourceFile = this.name(`NOW.${ext}`);
      fs.writeFileSync(path.join(this.dir, this.sourceFile), buffer);
      this.doc.sourceFile = this.sourceFile;
      this.flush();
    });
  }

  /** NOW text (scene recognition of the frame) shown on the phone page. */
  setNowText(text: string) {
    (this.doc as any).nowText = text;
  }

  /** Phone captures: loose copies in the captures dir, deleted together with the folder (retention). */
  noteCaptureFiles(files: string[]) {
    this.safe(() => fs.writeFileSync(path.join(this.dir, this.name('mobile.json')), JSON.stringify({ captureFiles: files }), 'utf8'));
  }

  /** ~200-char Japanese history summary shown under NOW (server/history/historySummary.ts). */
  setHistorySummary(summary: string) {
    (this.doc as any).historySummary = summary;
  }

  setVlm(vlm: { promptFull: string | null; rawResponse: string | null; parsedScenarios: unknown; elapsedMs?: number; guard?: unknown; history?: unknown }) {
    this.doc.vlm = { promptFull: vlm.promptFull, rawResponse: vlm.rawResponse, parsedScenarios: vlm.parsedScenarios, ...(vlm.guard ? { guard: vlm.guard } : {}), ...(vlm.history ? { history: vlm.history } : {}) } as typeof this.doc.vlm;
    if (vlm.elapsedMs !== undefined) this.timings.vlmMs = vlm.elapsedMs;
    this.safe(() => {
      this.flush();
      fs.writeFileSync(
        path.join(this.dir, this.name('vlm.txt')),
        [
          `生成ID: ${this.ctx.generationId}  VLM: ${this.ctx.vlmBackend ?? '?'} / ${this.ctx.vlmModel}`,
          '',
          '=== VLM に送ったプロンプト全文 ===',
          vlm.promptFull ?? '(未記録)',
          '',
          '=== VLM の生応答 ===',
          vlm.rawResponse ?? '(未記録)',
          '',
        ].join('\n'),
        'utf8'
      );
    });
  }

  addScene(index: number, scene: ArchiveScene, image: Buffer, extension: string) {
    const letter = sceneLetter(index);
    const ext = extension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
    const file = this.name(`${letter}.${ext}`);
    const t = temporalLabels(scene.distanceSec);
    this.safe(() => {
      let out = image;
      if (ext === 'png') {
        try {
          out = embedPngText(image, {
            GenerationId: this.ctx.generationId,
            CaptureId: this.ctx.captureId,
            Scene: letter,
            SceneKey: scene.sceneKey,
            DistanceSec: scene.distanceSec,
            TemporalOffset: t.temporalOffset,
            TemporalLabelJa: t.temporalLabelJa,
            TemporalLabelEn: t.temporalLabelEn,
            SourceTimestamp: this.ctx.generationId,
            PredictionPrompt: scene.predictionPrompt,
            ImagePrompt: scene.imagePromptFull ?? '(not recorded)',
            NegativePrompt: scene.negativePrompt ?? '',
            VlmBackend: this.ctx.vlmBackend ?? '',
            VlmModel: this.ctx.vlmModel,
            ImageBackend: this.ctx.imageBackend ?? '',
            ImageModel: this.ctx.imageModel,
            Software: 'speculative-memory',
          });
        } catch (error) {
          console.error('generationArchive: PNG metadata embed failed, saving plain image:', error);
        }
      }
      fs.writeFileSync(path.join(this.dir, file), out);
    });
    this.safe(() => {
      fs.writeFileSync(
        path.join(this.dir, this.name(`${letter}_prompt.txt`)),
        [
          `${this.ctx.generationId}  シーン ${letter}  ${t.temporalLabelJa} / ${t.temporalOffset} / ${t.temporalLabelEn}`,
          '',
          '=== シナリオ (scenario_description) ===',
          scene.scenarioDescription,
          '',
          '=== 予測プロンプト (prediction_prompt) ===',
          scene.predictionPrompt,
          '',
          '=== 画像プロンプト全文 (ComfyUI へ渡した正のプロンプト) ===',
          scene.imagePromptFull ?? '(未記録)',
          '',
          '=== ネガティブプロンプト ===',
          scene.negativePrompt ?? '(未記録)',
          '',
          `画像: ${this.ctx.imageBackend ?? '?'} / ${this.ctx.imageModel}`,
          `VLM: ${this.ctx.vlmBackend ?? '?'} / ${this.ctx.vlmModel}`,
          `seed: ${scene.seed ?? '(未記録)'}`,
          `生成時刻: ${new Date().toISOString()} (所要 ${scene.elapsedMs} ms)`,
          '',
        ].join('\n'),
        'utf8'
      );
    });
    this.scenes.push({ letter, ...scene, ...t, rulebookVersion: this.ctx.rulebookVersion ?? null, file, promptFile: this.name(`${letter}_prompt.txt`) });
    this.timings[`scene${letter}Ms`] = scene.elapsedMs;
    this.safe(() => this.flush());
  }

  fail(error: unknown, kind: 'failed' | 'cancelled' = 'failed') {
    this.errors.push(String((error as any)?.message ?? error));
    this.finish(kind);
  }

  finish(status: 'completed' | 'failed' | 'cancelled' = 'completed') {
    this.doc.status = status;
    this.timings.totalMs = Date.now() - this.startedAt;
    this.safe(() => {
      this.flush();
      fs.writeFileSync(path.join(this.dir, this.name('README.txt')), this.readme(), 'utf8');
    });
  }

  private flush() {
    fs.writeFileSync(path.join(this.dir, this.name('prompts.json')), JSON.stringify(this.doc, null, 2), 'utf8');
  }

  private readme(): string {
    const fmt = (s: number) => `${s >= 0 ? '+' : '-'}${Math.abs(s)}秒`;
    const lines = [
      `生成ID: ${this.ctx.generationId}`,
      `撮影ID: ${this.ctx.captureId} / 入力元: ${this.ctx.source} / 状態: ${this.doc.status}`,
      `バックエンド: ${this.ctx.backend} / 認識(VLM): ${this.ctx.vlmBackend ?? '?'} ${this.ctx.vlmModel} / 画像生成: ${this.ctx.imageBackend ?? '?'} ${this.ctx.imageModel}`,
      `距離: ${this.ctx.params.sceneDistancesSec.map(fmt).join(', ')} / presence ${this.ctx.params.presence} / tone ${this.ctx.params.tone}`,
      '',
      `${this.sourceFile ?? this.name('NOW.jpg')} = 元画像(NOW)`,
      '',
    ];
    for (const s of this.scenes) {
      lines.push(
        `■ ${s.letter} (${s.sceneKey})  ${fmt(s.distanceSec)}  ${s.temporalLabelJa} / ${s.temporalLabelEn}  ${s.file}`,
        `  シナリオ: ${s.scenarioDescription}`,
        `  予測プロンプト: ${s.predictionPrompt}`,
        `  画像プロンプト冒頭: ${(s.imagePromptFull ?? '(未記録)').replace(/\s+/g, ' ').slice(0, 300)}`,
        ''
      );
    }
    if (this.errors.length) lines.push('エラー:', ...this.errors.map((e) => `  - ${e}`), '');
    lines.push(`全文は ${this.name('prompts.json')} を参照。PNG には tEXt/iTXt でも同じ情報が入っている。`);
    return lines.join('\n') + '\n';
  }
}
