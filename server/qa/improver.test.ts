import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyProposalFile,
  applyToRulebook,
  captureCount,
  catalogProposal,
  listProposals,
  manualRollback,
  parseLlmChanges,
  readState,
  runCycle,
  validateChanges,
  windowRows,
  type Change,
  type ImproverConfig,
  type ImproverPaths,
} from './improver';
import { buildV1, ensureRulebookFiles, getRulebook, loadRulebook, readActive } from '../generation/rulebook';
import type { DefectType, QaRow } from './localJudge';

const CFG: ImproverConfig = { every: 10, rollbackDelta: 0.05, minTypeCount: 3, quietRate: 0.03 };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-'));
  const paths: ImproverPaths = { rulebookDir: path.join(root, 'rulebook'), logsDir: path.join(root, 'logs'), qaFile: path.join(root, 'logs', 'qa-local.jsonl') };
  fs.mkdirSync(paths.logsDir, { recursive: true });
  process.env.RULEBOOK_DIR = paths.rulebookDir;
  ensureRulebookFiles(paths.rulebookDir);
  let clock = Date.parse('2030-01-01T00:00:00.000Z'); // after the real appliedAt written by ensureRulebookFiles
  const now = () => new Date(clock);
  const tick = (min = 1) => {
    clock += min * 60_000;
  };
  /** `n` captures x 3 scenes with the given rulebook version; `defects[i]` = defect types of capture i (all scenes of it). */
  const addCaptures = (version: number, n: number, defectOf: (i: number) => DefectType[]) => {
    const rows: QaRow[] = [];
    for (let i = 0; i < n; i++) {
      tick(1);
      const types = defectOf(i);
      for (const sceneKey of ['gen_a', 'gen_b', 'gen_c']) {
        const bad = sceneKey === 'gen_b' && types.length > 0;
        rows.push({
          time: now().toISOString(),
          captureId: `c-${version}-${i}-${clock}`,
          sceneKey,
          file: 'f.png',
          ok: !bad,
          score: bad ? 0.5 : 1,
          defects: bad ? types.map((type) => ({ type, where: 'desk', note: `${type} example` })) : [],
          model: 'm',
          elapsedMs: 3000,
          rulebookVersion: version,
        });
      }
    }
    fs.appendFileSync(paths.qaFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  return { paths, now, tick, addCaptures, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('wait until N captures of the active version are judged', async () => {
  const s = setup();
  s.addCaptures(1, 9, () => ['fabricated_object']);
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(r.action, 'wait');
  assert.match(r.detail, /9\/10/);
  s.cleanup();
});

test('quiet when the defect rate is low: nothing changes, the window restarts', async () => {
  const s = setup();
  s.addCaptures(1, 10, () => []);
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(r.action, 'quiet');
  assert.equal(readActive(s.paths.rulebookDir)?.version, 1);
  assert.ok(readState(s.paths).lastCycleAt);
  s.cleanup();
});

test('applies a small catalog change as the next version and records it (CHANGELOG, jsonl, active)', async () => {
  const s = setup();
  s.addCaptures(1, 10, (i) => (i < 5 ? ['fabricated_object'] : []));
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(r.action, 'applied');
  assert.equal(r.newVersion, 2);
  const v2 = loadRulebook(2, s.paths.rulebookDir)!;
  assert.equal(v2.parent, 1);
  assert.ok(r.proposal!.changes.length >= 1 && r.proposal!.changes.length <= 2);
  assert.deepEqual(r.proposal!.targets, ['fabricated_object']);
  // everything except the editable lists is identical to v1
  const v1 = buildV1();
  assert.deepEqual({ ...v2.imagePrompt, extraConstraints: [] }, { ...v1.imagePrompt, extraConstraints: [] });
  assert.deepEqual(v2.quality, v1.quality);
  assert.equal(v2.negative.base, v1.negative.base);
  assert.equal(readActive(s.paths.rulebookDir)?.version, 2);
  assert.equal(getRulebook().version, 2); // picked up without a restart
  const log = fs.readFileSync(path.join(s.paths.logsDir, 'rulebook-changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].from, 1);
  assert.equal(log[0].to, 2);
  assert.equal(log[0].kind, 'apply');
  assert.ok(log[0].defectStats.byType.fabricated_object);
  assert.match(fs.readFileSync(path.join(s.paths.rulebookDir, 'CHANGELOG.md'), 'utf8'), /## v2/);
  s.cleanup();
});

test('rollback: the new version is worse by >= 5 points -> back to the previous one, rejected, never proposed again', async () => {
  const s = setup();
  s.addCaptures(1, 10, (i) => (i < 4 ? ['fabricated_object'] : [])); // v1: 4/30 images defective = 13.3%
  const first = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(first.action, 'applied');
  const appliedChanges = first.proposal!.changes;
  s.tick(5);
  s.addCaptures(2, 10, (i) => (i < 8 ? ['fabricated_object'] : [])); // v2: 8/30 = 26.7% (+13 points)
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(r.action, 'rolledback');
  assert.equal(r.rollback?.to, 1);
  assert.equal(readActive(s.paths.rulebookDir)?.version, 1);
  assert.equal(getRulebook().version, 1);
  const st = readState(s.paths);
  assert.equal(st.rejected.length, 1);
  assert.equal(st.rejected[0].version, 2);
  assert.deepEqual(st.rejected[0].changes, appliedChanges);
  const log = fs.readFileSync(path.join(s.paths.logsDir, 'rulebook-changes.jsonl'), 'utf8');
  assert.match(log, /"kind":"rollback"/);
  // v2 is kept as a file, but the same change is not proposed again
  assert.ok(loadRulebook(2, s.paths.rulebookDir));
  s.tick(5);
  s.addCaptures(1, 10, (i) => (i < 4 ? ['fabricated_object'] : []));
  const next = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(next.action, 'applied');
  assert.equal(next.newVersion, 3);
  const a = JSON.stringify(appliedChanges);
  assert.notEqual(JSON.stringify(next.proposal!.changes), a);
  s.cleanup();
});

test('rollback also triggers on the targeted defect type alone; an improved version is validated and the cycle goes on', async () => {
  const s = setup();
  s.addCaptures(1, 10, (i) => (i < 5 ? ['floating'] : [])); // 5/30
  assert.equal((await runCycle({ paths: s.paths, config: CFG, now: s.now })).action, 'applied');
  s.tick(5);
  s.addCaptures(2, 10, (i) => (i < 2 ? ['floating'] : [])); // 2/30: better
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.ok(['quiet', 'applied', 'ask'].includes(r.action), r.action);
  assert.equal(readState(s.paths).validated['2'] !== undefined, true);
  assert.equal(readActive(s.paths.rulebookDir)?.version === 1, false);
  s.cleanup();
});

test('asks the user (proposal file, nothing applied) when the top defect is fabricated_person; one open proposal per type', async () => {
  const s = setup();
  s.addCaptures(1, 10, (i) => (i < 6 ? ['fabricated_person'] : []));
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(r.action, 'ask');
  assert.equal(readActive(s.paths.rulebookDir)?.version, 1);
  assert.ok(r.askFile);
  const md = fs.readFileSync(path.join(s.paths.logsDir, 'qa-proposals', r.askFile!), 'utf8');
  assert.match(md, /fabricated_person/);
  assert.equal(listProposals(s.paths).length, 1);
  s.tick(5);
  s.addCaptures(1, 10, (i) => (i < 6 ? ['fabricated_person'] : []));
  const again = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(again.action, 'wait');
  assert.equal(listProposals(s.paths).length, 1);
  s.cleanup();
});

test('asks the user when the same defect type did not improve over 3 versions in a row', async () => {
  const s = setup();
  for (let round = 0; round < 3; round++) {
    const v = round + 1;
    s.tick(5);
    s.addCaptures(v, 10, (i) => (i < 4 ? ['fabricated_object'] : [])); // always 13%: never improves
    const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
    assert.equal(r.action, 'applied', `round ${round}: ${r.action} ${r.detail}`);
  }
  s.tick(5);
  s.addCaptures(4, 10, (i) => (i < 4 ? ['fabricated_object'] : []));
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(r.action, 'ask');
  assert.match(r.detail, /fabricated_object did not improve over 3 versions/);
  assert.equal(readActive(s.paths.rulebookDir)?.version, 4);
  s.cleanup();
});

test('dry run: reports the proposal, ignores the N gate, writes nothing', async () => {
  const s = setup();
  s.addCaptures(1, 3, () => ['fabricated_object']);
  const r = await runCycle({ paths: s.paths, config: CFG, now: s.now, dryRun: true });
  assert.equal(r.action, 'dry-run');
  assert.ok((r.proposal?.changes.length ?? 0) > 0);
  assert.equal(readActive(s.paths.rulebookDir)?.version, 1);
  assert.equal(fs.existsSync(path.join(s.paths.logsDir, 'rulebook-changes.jsonl')), false);
  s.cleanup();
});

test('validateChanges: only editable additive items, person-free constraints, expression words and size make it an "ask"', () => {
  const rb = buildV1();
  const ok = validateChanges([{ path: 'negative.added', value: 'extra bag' }], rb);
  assert.deepEqual([ok.ok, ok.ask], [true, []]);
  assert.equal(validateChanges([{ path: 'imagePrompt.physicsRule' as any, value: 'x' }], rb).ask.length, 1);
  assert.equal(validateChanges([{ path: 'imagePrompt.extraConstraints', value: 'A person stands near the desk.' }], rb).ok, false); // G-01
  assert.ok(validateChanges([{ path: 'vlm.extraInstructions', value: 'Make the changes bigger and more dramatic.' }], rb).ask.length > 0);
  assert.ok(validateChanges([{ path: 'vlm.extraInstructions', value: 'Let people appear more often.' }], rb).ask.length > 0);
  const three: Change[] = [1, 2, 3].map((i) => ({ path: 'negative.added', value: `term ${i}` }));
  assert.ok(validateChanges(three, rb).ask.some((a) => /3 items/.test(a)));
  assert.equal(validateChanges([{ path: 'guard.guardRetries', value: 9 }], rb).ok, false);
  assert.equal(validateChanges([{ path: 'guard.guardRetries', value: 2 }], rb).ok, true);
  assert.equal(validateChanges([{ path: 'guard.extraObjectGroups', value: ['tote', 'totes'] }], rb).ok, true);
  assert.equal(validateChanges([{ path: 'guard.extraObjectGroups', value: ['bad<>'] }], rb).ok, false);
  const next = applyToRulebook(rb, [{ path: 'negative.added', value: 'extra bag' }], { note: 'n', now: new Date(0) });
  assert.equal(validateChanges([{ path: 'negative.added', value: 'extra bag' }], next).ok, false); // duplicates
});

test('catalog proposals cover every automatically handled type and skip rejected changes', () => {
  const rb = buildV1();
  for (const t of ['fabricated_object', 'missing_object', 'floating', 'implausible_placement', 'scale', 'screen_changed', 'anatomy', 'other'] as DefectType[]) {
    const p = catalogProposal([t], rb, []);
    assert.ok(p, t);
    assert.equal(validateChanges(p!.changes, rb).ask.length, 0, `${t}: catalog text must not touch expression`);
    assert.equal(validateChanges(p!.changes, rb).ok, true);
  }
  assert.equal(catalogProposal(['fabricated_person'], rb, []), null);
  const first = catalogProposal(['anatomy'], rb, [])!;
  assert.equal(catalogProposal(['anatomy'], rb, [{ version: 2, time: 't', reason: 'r', changes: first.changes }]), null);
});

test('LLM proposals are accepted only when they pass the schema and validation (else the catalog is used)', async () => {
  const rb = buildV1();
  assert.deepEqual(parseLlmChanges('{"changes":[{"path":"imagePrompt.extraConstraints","value":"Every object stays on a desk, a floor or a seat."}]}', rb, []), [{ path: 'imagePrompt.extraConstraints', value: 'Every object stays on a desk, a floor or a seat.' }]);
  assert.equal(parseLlmChanges('{"changes":[{"path":"negative.added","value":"laptops, white mug"}]}', rb, []), null, 'negative terms never come from the LLM');
  assert.equal(parseLlmChanges('{"changes":[{"path":"imagePrompt.physicsRule","value":"x y z"}]}', rb, []), null);
  assert.equal(parseLlmChanges('{"changes":[{"path":"vlm.extraInstructions","value":"Make it more dramatic."}]}', rb, []), null);
  assert.equal(parseLlmChanges('{"changes":[{"path":"imagePrompt.extraConstraints","value":"A man sits."}]}', rb, []), null);
  assert.equal(parseLlmChanges('nope', rb, []), null);
  assert.equal(parseLlmChanges('{"changes":[]}', rb, []), null);
  const s = setup();
  s.addCaptures(1, 10, (i) => (i < 5 ? ['fabricated_object'] : []));
  const good = await runCycle({ paths: s.paths, config: CFG, now: s.now, llm: async () => '{"changes":[{"path":"vlm.extraInstructions","value":"Never write about an object that is not visible in the photo."}]}' });
  assert.equal(good.proposal?.source, 'llm');
  assert.ok(loadRulebook(2, s.paths.rulebookDir)!.vlm.extraInstructions.includes('Never write about an object that is not visible in the photo.'));
  s.cleanup();
  const s2 = setup();
  s2.addCaptures(1, 10, (i) => (i < 5 ? ['fabricated_object'] : []));
  const bad = await runCycle({ paths: s2.paths, config: CFG, now: s2.now, llm: async () => 'garbage' });
  assert.equal(bad.proposal?.source, 'catalog');
  s2.cleanup();
});

test('manual rollback and applying a proposal file (user agreed)', async () => {
  const s = setup();
  s.addCaptures(1, 10, (i) => (i < 5 ? ['fabricated_object'] : []));
  await runCycle({ paths: s.paths, config: CFG, now: s.now });
  assert.equal(readActive(s.paths.rulebookDir)?.version, 2);
  const m = manualRollback({ paths: s.paths, now: s.now, reason: 'test' });
  assert.deepEqual(m, { from: 2, to: 1 });
  assert.equal(getRulebook().version, 1);
  assert.equal(readState(s.paths).rejected[0].version, 2);
  // an "ask" proposal gets applied only through the explicit call
  const dir = path.join(s.paths.logsDir, 'qa-proposals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p.md'), '# x\n\n```json\n[{"path":"negative.added","value":"approved term"}]\n```\n');
  const a = applyProposalFile('p.md', { paths: s.paths, now: s.now });
  assert.equal(a.version, 3);
  assert.ok(getRulebook().negative.added.includes('approved term'));
  assert.ok(fs.existsSync(path.join(dir, 'p.applied.md')));
  s.cleanup();
});

test('windowRows: version, start time, newest N captures; test captures excluded', () => {
  const mk = (id: string, time: string, version = 1, test = false): QaRow => ({ time, captureId: id, sceneKey: 'gen_a', file: 'f', ok: true, score: 1, defects: [], model: 'm', elapsedMs: 1, rulebookVersion: version, test });
  const rows = [mk('a', '2026-10-17T00:01:00Z'), mk('b', '2026-10-17T00:02:00Z'), mk('c', '2026-10-17T00:03:00Z'), mk('d', '2026-10-17T00:04:00Z', 2), mk('t', '2026-10-17T00:05:00Z', 1, true)];
  assert.equal(captureCount(windowRows(rows, 1)), 3);
  assert.deepEqual(windowRows(rows, 1, { captures: 2 }).map((r) => r.captureId), ['b', 'c']);
  assert.deepEqual(windowRows(rows, 1, { since: '2026-10-17T00:02:00Z' }).map((r) => r.captureId), ['b', 'c']);
  assert.deepEqual(windowRows(rows, 1, { before: '2026-10-17T00:02:00Z' }).map((r) => r.captureId), ['a']);
});
