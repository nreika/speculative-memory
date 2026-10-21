import {sharedOllamaContextLength} from "./sharedOllamaContext";
/** Display gate: every source person must appear exactly once in a generated image. */
export interface PeopleIntegrity {
  ok: boolean | null;
  sourceCount: number | null;
  outputToSource: number[];
  reason: string;
  caption?: string;
  /** Set when the rejection is not a people-count problem (e.g. "extra_hand": a person shows 3+ hands). */
  defect?: string;
}

export function parsePeopleIntegrity(raw: unknown, expected: number): PeopleIntegrity {
  const unknown = (reason: string): PeopleIntegrity => ({ ok: null, sourceCount: null, outputToSource: [], reason });
  if (!Number.isInteger(expected) || expected < 0 || expected > 8) return unknown('Invalid source count');
  let value: any;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return unknown('Invalid identity answer'); }
  if (!Number.isInteger(value?.sourceCount) || !Array.isArray(value?.outputToSource) || value.outputToSource.some((n: unknown) => !Number.isInteger(n))) return unknown('Incomplete identity answer');
  const indices: number[] = value.outputToSource;
  const sourceCount = value.sourceCount;
  // A second copy of one person is rejected even when the total count happens to match.
  const ok = sourceCount === expected && indices.length === expected && new Set(indices).size === expected && indices.every(n => n >= 0 && n < expected);
  return { ok, sourceCount, outputToSource: indices, reason: ok ? 'Every original person appears once' : 'Person count, identity or uniqueness mismatch' };
}

export async function inspectPeopleIntegrity(source: string, output: string, expected: number, signal?: AbortSignal): Promise<PeopleIntegrity> {
  const bare = (value: string) => value.match(/^data:image\/[^;]+;base64,(.+)$/)?.[1];
  const images = [bare(source), bare(output)];
  if (images.some(x => !x)) throw new Error('Invalid identity check image');
  const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  // First count the output by itself: asking the small VLM to map an empty image
  // against another image can invent a person to satisfy the mapping request.
  const countResponse = await fetch(url + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.VLM_MODEL, images: [images[1]], stream: false, think: false, keep_alive: '5m',
      prompt: 'Count real human bodies visible in this single photo, including cropped people at the edges. Chairs, curtains, bags, mannequins, posters and screens are not real people. Return JSON {"person":true or false,"count":integer}. If no real human body is visible, return {"person":false,"count":0}.',
      format: 'json', options: { temperature: 0, num_predict: 64, num_ctx: sharedOllamaContextLength() } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  if (!countResponse.ok) throw new Error('Output person count HTTP ' + countResponse.status);
  const countAnswer = await countResponse.json() as {response?:string;done_reason?:string};
  const count = JSON.parse(countAnswer.response || '{}').count;
  if (countAnswer.done_reason === 'length' || !Number.isInteger(count) || count < 0 || count > 8) throw new Error('Output person count unknown');
  if (count !== expected) return {ok:false,sourceCount:expected,outputToSource:Array(count).fill(-1),reason:`Expected ${expected} people, found ${count}`};
  if (expected < 2) return {ok:true,sourceCount:expected,outputToSource:expected ? [0] : [],reason:'Single-image count confirms no duplicate or extra person'};
  const response = await fetch(url + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.VLM_MODEL, images, stream: false, think: false, keep_alive: '5m',
      prompt: 'IMAGE 1 is the original. IMAGE 2 is an edited image. Inventory all real visible people, including cropped bodies at the edges. Exclude people shown on screens or posters. Number IMAGE 1 people from left to right, starting at 0. For EACH visible person in IMAGE 2, return the matching IMAGE 1 person index. Match individual identity, clothes, hair and location together; matching shirt colour alone is insufficient. If one original person appears twice, repeat their index twice. Use -1 for an added, unmatched or uncertain person. A missing original has no entry. Return sourceCount for IMAGE 1, and outputToSource in IMAGE 2 left-to-right order. No action descriptions.',
      format: { type: 'object', properties: { sourceCount: { type: 'integer', minimum: 0, maximum: 8 }, outputToSource: { type: 'array', maxItems: 12, items: { type: 'integer', minimum: -1, maximum: 7 } } }, required: ['sourceCount','outputToSource'], additionalProperties: false },
      options: { temperature: 0, num_predict: 192, num_ctx: sharedOllamaContextLength() } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error('Identity check HTTP ' + response.status);
  const result = await response.json() as { response?: string; done_reason?: string };
  return parsePeopleIntegrity(result.done_reason === 'length' ? null : result.response, expected);
}

const IDENTITY_CORRECTION = 'Render each original individual exactly once. Keep the original person-to-clothes and person-to-belongings assignments. Fully erase each moved body from its previous position. The reference portraits identify the existing people only.';

/** Short defect label of a rejected verdict (archive/skip reason): its own defect, else "identity". */
export function rejectionDefect(verdict: PeopleIntegrity): string {
  return verdict.defect || 'identity';
}

/**
 * Correction appended to the second attempt, naming every defect the first rejection reported (2026-10-19 TSC-003 L003:
 * the person drawn from behind covered the blue backpack on the chair; one output was shifted/tilted). Built from
 * verdict.defect and the notes in verdict.reason (withBelongings/withFraming/withHandCount append theirs to it).
 */
export function targetedCorrection(verdict: PeopleIntegrity, opts: { expectedPeople?: number; plannedAction?: string; sizeAnchor?: string } = {}): string {
  const reason = verdict.reason || '';
  const has = (d: string) => verdict.defect === d || reason.includes(d + ':');
  const parts: string[] = [];
  if (has('missing_belongings')) {
    const items = (reason.match(/missing_belongings: not visible in the output: ([^;]+)/)?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const named = items.length ? 'The ' + items.join(' and the ') : 'Every bag, jacket and personal item on the furniture';
    parts.push(`${named} must remain fully visible exactly where ${items.length === 1 ? 'it is' : 'they are'} in the input` + (opts.expectedPeople === 0 ? '; do not move, cover or remove ' + (items.length === 1 ? 'it.' : 'them.') : `; the person stands beside ${items.length === 1 ? 'it' : 'them'}, not in front of ${items.length === 1 ? 'it' : 'them'}.`));
  }
  if (has('framing_drift')) parts.push('Keep the exact framing, scale and rotation of the input; do not zoom, shift or tilt the camera.');
  if (has('incoherent_body')) parts.push('Draw each person as ONE coherent body: the face on the front of the head, the arms attached at the shoulders and bending naturally for the torso; never a face on the back of the head and never an arm coming out of the back.');
  if (has('person_too_large') && opts.sizeAnchor) parts.push(opts.sizeAnchor);
  if (has('person_moved')) parts.push('The person keeps exactly the same position, size and distance from the camera as in the input: do not move, enlarge or re-centre them; only the pose changes.');
  if (has('duplicate_object')) {
    const named = (reason.match(/duplicate_object: [^(]*\(([^)]*)\)/)?.[1] ?? '').split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
    parts.push((named.length ? 'The ' + named.join(' and the ') + ' appears exactly once; its old place is empty. ' : '') + 'Every object appears exactly once: the object that is moved is no longer at its old place (that spot is empty); never draw the same bottle, mug or notebook twice.');
  }
  if (has('face_on_back_view')) parts.push('The person is seen from behind: keep the back of the head toward the camera. No face, eyes, nose or mouth may appear anywhere on this person.');
  if (has('action_not_shown') && opts.plannedAction) parts.push('The requested action must be clearly visible in the pose: ' + opts.plannedAction.trim().slice(0, 300));
  if (has('extra_hand')) parts.push('Each person has exactly two hands and two arms; no extra hand, arm or finger anywhere.');
  const identity = !verdict.defect || /Expected \d+ people|Person count, identity or uniqueness mismatch|Single-person inventory/.test(reason);
  if (identity) parts.push(opts.expectedPeople === 0 ? 'No person may appear anywhere in the image.' : IDENTITY_CORRECTION);
  return parts.join(' ');
}

export type UniquePeopleResult =
  | { image: string; verdict: PeopleIntegrity; attempts: number; skipped?: undefined; actionMismatch?: true }
  | { skipped: true; defect: string; verdict: PeopleIntegrity; attempts: number; image?: undefined };

/**
 * Generate, inspect, retry once with a correction naming the defect. A rejected image is never returned.
 * onExhausted "skip" (production scene loop, 2026-10-19): after the last REJECTION (ok:false) return a skip result so the
 * capture continues without this scene; an unknown verdict (ok:null) skips as 'inspection_unavailable'. onExhausted 'throw' still throws.
 */
export async function generateUniquePeople(args: {
  generate: (attempt: number, correction: string) => Promise<string>;
  inspect: (image: string) => Promise<PeopleIntegrity>;
  rejected: (image: string, verdict: PeopleIntegrity, attempt: number) => void;
  maxAttempts?:1|2;
  /** The planned action (prediction_prompt): asked of the inspection; passed to the correction of the retry. */
  plannedAction?: string;
  /** Retry sentence for a person drawn too large / too close (empty-room recent-person scenes). */
  sizeAnchor?: string;
  expectedPeople?: number;
  onExhausted?: 'throw' | 'skip';
  signal?: AbortSignal;
}): Promise<UniquePeopleResult> {
  let limit=args.maxAttempts??2;
  let last: PeopleIntegrity | undefined, lastImage = '';
  for (let attempt = 0; attempt < limit; attempt++) {
    args.signal?.throwIfAborted();
    const correction = attempt && last ? targetedCorrection(last, { expectedPeople: args.expectedPeople, plannedAction: args.plannedAction, sizeAnchor: args.sizeAnchor }) : '';
    const image = await args.generate(attempt, correction);
    lastImage = image;
    let verdict: PeopleIntegrity;
    try { verdict = await args.inspect(image); }
    catch (error) {
      args.signal?.throwIfAborted();
      verdict = { ok: null, sourceCount: null, outputToSource: [], reason: String(error) };
    }
    args.signal?.throwIfAborted();
    if (verdict.ok === true) return { image, verdict, attempts: attempt + 1 };
    args.rejected(image, verdict, attempt + 1);
    last = verdict;
    // 2026-10-21: a body that does not hang together, or a planned action that is not visible, gets ONE rebuild even where the
    // engine normally runs a single attempt (turbo).
    if (attempt + 1 >= limit && limit < 2 && (verdict.defect === 'incoherent_body' || verdict.defect === 'action_not_shown' || verdict.defect === 'face_on_back_view' || verdict.defect === 'duplicate_object' || verdict.defect === 'person_too_large' || verdict.defect === 'person_moved')) limit = 2;
  }
  // The only rejection that still publishes: the action was not drawn after the rebuild. The caller replaces the subtitle by what is visible.
  if (args.onExhausted === 'skip' && last?.ok === false && last.defect === 'action_not_shown' && lastImage) {
    return { image: lastImage, verdict: { ...last, ok: true }, attempts: limit, actionMismatch: true };
  }
  if (args.onExhausted === 'skip' && last?.ok === false) return { skipped: true, defect: rejectionDefect(last), verdict: last, attempts: limit };
  // 2026-10-20: an inspection that cannot decide (ok:null) skips the scene too; the capture keeps the previous image instead of failing.
  if (args.onExhausted === 'skip' && last) return { skipped: true, defect: 'inspection_unavailable', verdict: last, attempts: limit };
  throw new Error(`Person identity check failed after ${limit} attempts; no image published`);
}
