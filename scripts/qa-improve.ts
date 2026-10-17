/**
 * Rulebook improvement by hand (the server runs the same cycle automatically every QA_IMPROVE_EVERY captures).
 *   npx tsx scripts/qa-improve.ts --dry-run [--no-llm]     show what the next automatic change would be (writes nothing)
 *   npx tsx scripts/qa-improve.ts --apply  [--no-llm]      run one real cycle now (ignores the N-captures gate)
 *   npx tsx scripts/qa-improve.ts --rollback [N]           go back to version N (default: the parent), reject the active one
 *   npx tsx scripts/qa-improve.ts --apply-proposal <file>  apply an "ask the user" proposal (only after the user agreed)
 *   npx tsx scripts/qa-improve.ts --status                 active version, versions, recent changes, open proposals
 */
import '../server/loadEnv';
import { applyProposalFile, defaultPaths, listProposals, manualRollback, ollamaTextLlm, readChanges, runCycle } from '../server/qa/improver';
import { listVersions, readActive, getRulebook } from '../server/generation/rulebook';

const has = (f: string) => process.argv.includes(f);
const val = (f: string) => process.argv[process.argv.indexOf(f) + 1];
const llm = has('--no-llm') ? null : ollamaTextLlm();

if (has('--status') || process.argv.length <= 2) {
  console.log(JSON.stringify({ active: readActive() ?? { version: getRulebook().version }, versions: listVersions(), proposals: listProposals().filter((p) => p.status === 'open').map((p) => p.file), recentChanges: readChanges(defaultPaths(), 5) }, null, 2));
} else if (has('--rollback')) {
  const to = Number(val('--rollback'));
  console.log(manualRollback({ to: Number.isInteger(to) && to > 0 ? to : undefined, reason: 'manual rollback (scripts/qa-improve.ts)' }));
} else if (has('--apply-proposal')) {
  console.log(applyProposalFile(val('--apply-proposal')));
} else {
  const dryRun = has('--dry-run');
  const r = await runCycle({ dryRun, force: true, llm });
  console.log(JSON.stringify(r, null, 2));
}
