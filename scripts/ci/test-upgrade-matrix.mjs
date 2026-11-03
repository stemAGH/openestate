// Guards the "upgrade from an earlier release" CI matrix (.github/workflows/ci.yml,
// job native-upgrade-from-previous-release). Fails if a variant is removed,
// renamed or pointed at another migration, if a variant has no step of its own,
// if a step or the job can be skipped or allowed to fail, or if a migration or
// release-notes file it names doesn't exist.
//
//   node scripts/ci/test-upgrade-matrix.mjs [path/to/ci.yml]
//
// Text checks only (no YAML parser is installed at the root); the layout they
// read is the one this file was written against.
import { readFileSync, existsSync } from 'node:fs';

const EXPECTED = {
  clean: { kind: 'clean', exercises: '' },
  'orphan-fk': { kind: 'orphan', exercises: '20261022000000_restore_foreign_keys' },
  'lock-fk': {
    kind: 'lock',
    exercises: '20261022000000_restore_foreign_keys',
    lock_table: 'users',
    recovery_notes: 'docs/releases/v0.8.4-release-notes.md',
  },
  'orphan-interest': { kind: 'orphan', exercises: '20261101000000_booking_interest_rule' },
  'lock-interest': {
    kind: 'lock',
    exercises: '20261101000000_booking_interest_rule',
    lock_table: 'bookings',
    recovery_notes: 'docs/releases/v0.9.0-release-notes.md',
  },
};

const file = process.argv[2] ?? '.github/workflows/ci.yml';
const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const errors = [];
const err = (m) => errors.push(m);

const start = text.indexOf('\n  native-upgrade-from-previous-release:\n');
if (start < 0) {
  console.log('FAIL - job native-upgrade-from-previous-release not found');
  process.exit(1);
}
const rest = text.slice(start + 1);
const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
const job = next < 0 ? rest : rest.slice(0, next + 1);
const [head, steps = ''] = job.split('\n    steps:\n');

// The job itself must always run and must fail when a variant fails.
if (/^    if:/m.test(head)) err('the job has an if: and can be skipped');
if (/continue-on-error/.test(job)) err('the job or a step uses continue-on-error');
if (!/fail-fast: false/.test(head)) err('the matrix is not fail-fast: false');
if (/^\s+exclude:/m.test(head)) err('the matrix has an exclude:');

// Matrix include entries.
const include = head.split('\n        include:\n')[1] ?? '';
const found = {};
let cur = null;
for (const line of include.split('\n')) {
  const v = line.match(/^ {10}- variant: (\S+)$/);
  const kv = line.match(/^ {12}([a-z_]+): ?"?([^"]*)"?$/);
  if (v) found[(cur = v[1])] = {};
  else if (kv && cur) found[cur][kv[1]] = kv[2];
  else if (/^ {0,9}\S/.test(line)) break;
}
const names = Object.keys(found).sort().join(',');
if (names !== Object.keys(EXPECTED).sort().join(',')) err(`matrix variants are [${names}], expected [${Object.keys(EXPECTED).sort().join(',')}]`);
for (const [name, want] of Object.entries(EXPECTED)) {
  const got = found[name];
  if (!got) continue;
  for (const [k, v] of Object.entries(want)) if ((got[k] ?? '') !== v) err(`${name}: ${k} is "${got[k] ?? ''}", expected "${v}"`);
  for (const k of Object.keys(got)) if (!(k in want)) err(`${name}: unexpected field ${k}`);
  if (want.exercises && !existsSync(`packages/db/prisma/migrations/${want.exercises}/migration.sql`)) err(`${name}: migration ${want.exercises} does not exist`);
  if (want.recovery_notes) {
    if (!existsSync(want.recovery_notes)) err(`${name}: ${want.recovery_notes} does not exist`);
    else if (!readFileSync(want.recovery_notes, 'utf8').includes('UPDATE _prisma_migrations SET rolled_back_at')) err(`${name}: ${want.recovery_notes} has no recovery command`);
  }
}

// Every step condition names a real variant or kind, and every non-clean
// variant is reached by at least one step of its own (by name or by kind).
const conds = [...steps.matchAll(/^ {8}if: (.+)$/gm)].map((m) => m[1].trim());
const kinds = new Set(Object.values(EXPECTED).map((e) => e.kind));
for (const c of conds) {
  for (const m of c.matchAll(/matrix\.variant == '([^']+)'/g)) if (!(m[1] in EXPECTED)) err(`a step runs only for unknown variant ${m[1]}`);
  for (const m of c.matchAll(/matrix\.kind == '([^']+)'/g)) if (!kinds.has(m[1])) err(`a step runs only for unknown kind ${m[1]}`);
}
for (const [name, want] of Object.entries(EXPECTED)) {
  if (want.kind === 'clean') continue;
  const own = conds.some((c) => c.includes(`matrix.variant == '${name}'`) || c.includes(`matrix.kind == '${want.kind}'`));
  if (!own) err(`${name}: no step runs for it`);
}
// The per-variant expectations in the shell steps must name every orphan and
// lock variant, or the case statements fall through to their error branch.
for (const [name, want] of Object.entries(EXPECTED)) {
  if (want.kind !== 'clean' && !new RegExp(`^\\s+${name}\\)`, 'm').test(steps)) err(`${name}: no case branch with its expectations`);
}

if (errors.length) {
  for (const e of errors) console.log(`FAIL - ${e}`);
  process.exit(1);
}
console.log(`ok - upgrade matrix: ${Object.keys(EXPECTED).join(', ')}`);
