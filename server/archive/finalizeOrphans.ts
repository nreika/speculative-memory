/**
 * A run cut by a restart leaves <id>_prompts.json with status "running" and no README / images behind.
 * At start-up every such folder older than `minAgeMs` is marked "aborted" (nothing is deleted).
 */
import fs from 'node:fs';
import path from 'node:path';

export function finalizeOrphanGenerations(root: string, options: { now?: number; minAgeMs?: number; days?: number } = {}): number {
  const now = options.now ?? Date.now(), minAge = options.minAgeMs ?? 120_000, days = options.days ?? 2;
  let fixed = 0;
  let dayDirs: string[] = [];
  try { dayDirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-days); } catch { return 0; }
  for (const day of dayDirs) {
    let ids: string[] = [];
    try { ids = fs.readdirSync(path.join(root, day)); } catch { continue; }
    for (const id of ids) {
      const dir = path.join(root, day, id), file = path.join(dir, id + '_prompts.json');
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs < minAge) continue;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (doc?.status !== 'running') continue;
        if (fs.existsSync(path.join(dir, id + '_README.txt'))) continue;
        doc.status = 'aborted';
        doc.abortedNote = 'Run cut off (server restart); finalized at start-up';
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
        fs.renameSync(tmp, file);
        fixed += 1;
      } catch { /* an unreadable folder is left alone */ }
    }
  }
  return fixed;
}
