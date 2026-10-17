/**
 * Summarise logs/qa.jsonl: failure counts for the last N hours + flagged files.
 *   ./node_modules/.bin/tsx scripts/qa-summary.ts [hours=24] [minSeverity=2]
 */
import fs from 'fs';
import path from 'path';

const hours = Number(process.argv[2] ?? 24);
const minSeverity = Number(process.argv[3] ?? 2);
const logPath = path.join(process.cwd(), 'logs', 'qa.jsonl');
if (!fs.existsSync(logPath)) {
  console.log('no logs/qa.jsonl yet');
  process.exit(0);
}
const since = Date.now() - hours * 3600_000;
const rows = fs
  .readFileSync(logPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((r) => r && new Date(r.timestamp).getTime() >= since);

const kinds: Record<string, string> = {
  duplicated_person: 'duplicated person',
  limb_anomaly: 'limb anomaly',
  invented_object: 'invented object',
  face_or_hand_distortion: 'face/hand distortion',
  identity_changed: 'identity changed',
};
const counts: Record<string, number> = Object.fromEntries(Object.keys(kinds).map((k) => [k, 0]));
let images = 0;
const flagged: any[] = [];
for (const r of rows) {
  for (const v of r.verdicts ?? []) {
    images += 1;
    for (const k of Object.keys(kinds)) if (v[k] === true) counts[k] += 1;
    if (typeof v.severity === 'number' && v.severity >= minSeverity) {
      flagged.push({ ...v, captureId: r.captureId, source: r.source });
    }
  }
}
console.log(
  `QA, last ${hours}h: ${rows.length} captures, ${images} images, ${flagged.length} flagged (severity >= ${minSeverity})`
);
for (const [k, label] of Object.entries(kinds)) console.log(`  ${label.padEnd(22)} ${counts[k]}`);
if (flagged.length) {
  console.log('\nFlagged (review these):');
  for (const f of flagged) {
    const flags = Object.keys(kinds)
      .filter((k) => f[k] === true)
      .map((k) => kinds[k])
      .join(', ');
    console.log(`  [sev ${f.severity}] ${f.file}  (source ${f.source})`);
    console.log(`      ${flags || '-'} | ${f.reason ?? ''}`);
  }
}
