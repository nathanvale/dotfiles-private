import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const laneEntry = readFileSync(resolve(here, '../references/lane-entry.md'), 'utf8');

function guidanceIsSafe(text) {
  return [
    /Continue to exact-page\s+inspection[\s\S]*command exits zero/,
    /`status: ok`[\s\S]*`route: pass`[\s\S]*`baseline: pass` or `baseline: warning`/,
    /`effective_policy_check_unavailable` is a non-blocking proof gap/,
    /Stop when health exits nonzero[\s\S]*baseline is\s+`fail`/,
    /Any nonzero inspect result stops adapter work[\s\S]*`page_list_unreadable`/,
  ].every((pattern) => pattern.test(text));
}

test('lane entry distinguishes a retained health warning from an inspect failure', () => {
  assert.equal(guidanceIsSafe(laneEntry), true);
});

test('the contract detects guidance that makes the policy warning blocking', () => {
  const unsafe = laneEntry.replace('is a non-blocking proof gap', 'stops the route');
  assert.notEqual(unsafe, laneEntry);
  assert.equal(guidanceIsSafe(unsafe), false);
});
