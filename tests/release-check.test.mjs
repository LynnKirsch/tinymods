import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseCheck, requiredSteps } from '../scripts/release-check.mjs';

const main = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const other = 'c'.repeat(40);
const branch = 'ci/optima-verify-next';
const verifyRef = 'refs/heads/' + branch;
const mainRef = 'refs/heads/main';
const actions = '/repos/LynnKirsch/tinymods/actions';
const chrome = 'Chrome browser acceptance (local static export, no external sends)';

function scenario() {
  const run = {
    id: 42, run_attempt: 2, head_sha: candidate, head_branch: branch,
    event: 'push', path: '.github/workflows/optima-verify.yml', status: 'completed', conclusion: 'success',
  };
  const job = {
    name: 'verify', run_id: 42, run_attempt: 2, head_sha: candidate, head_branch: branch,
    status: 'completed', conclusion: 'success',
    steps: requiredSteps.map(name => ({ name, status: 'completed', conclusion: 'success' })),
  };
  const state = {
    local: [candidate, candidate], remote: [candidate, candidate], production: [main, main],
    ancestor: true, diff: ['A', 'tests/fixtures/html-content-editor/logical-components.html', 'M', 'app/page.tsx', ''].join('\0'),
    runs: [run, run], job, apiError: false,
  };
  let refReads = 0;
  let localReads = 0;
  let runReads = 0;
  const output = [];
  const git = (...args) => {
    switch (args[0]) {
      case 'rev-parse':
        assert.deepEqual(args, ['rev-parse', '--verify', verifyRef]);
        return state.local[localReads++] + '\n';
      case 'remote':
        assert.deepEqual(args, ['remote', 'get-url', 'origin']);
        return 'https://github.com/LynnKirsch/tinymods.git\n';
      case 'ls-remote': {
        assert.deepEqual(args, ['ls-remote', '--refs', 'origin', mainRef, verifyRef]);
        const index = refReads++;
        return state.production[index] + '\t' + mainRef + '\n' + state.remote[index] + '\t' + verifyRef + '\n';
      }
      case 'merge-base':
        assert.deepEqual(args, ['merge-base', '--is-ancestor', state.production[0], candidate]);
        return state.ancestor ? '' : null;
      case 'diff':
        assert.deepEqual(args, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', state.production[0], candidate, '--']);
        return state.diff;
      default:
        throw new Error('Unexpected Git command: ' + args[0]);
    }
  };
  const api = async endpoint => {
    if (state.apiError) throw new Error('API unavailable');
    const [path, query] = endpoint.split('?');
    if (path === actions + '/workflows/optima-verify.yml/runs') {
      assert.deepEqual(Object.fromEntries(new URLSearchParams(query)),
        { branch, head_sha: candidate, event: 'push', per_page: '1' });
      const current = state.runs[runReads++];
      return { workflow_runs: current ? [current] : [] };
    }
    assert.equal(endpoint, actions + '/runs/42/attempts/2/jobs?per_page=100');
    return { total_count: 1, jobs: [state.job] };
  };
  return {
    state, run, job, output,
    check: (args = []) => releaseCheck(args, { git, api, write: line => output.push(line) }),
  };
}

test('reports the exact release, every step and the real diff including a synthetic HTML fixture', async () => {
  const { check, output } = scenario();
  assert.equal(await check([candidate]), 0);
  assert.ok(output.includes('Candidate SHA: ' + candidate));
  assert.ok(output.includes('Production SHA (remote main): ' + main));
  assert.ok(output.includes('Optima Verify: https://github.com/LynnKirsch/tinymods/actions/runs/42/attempts/2'));
  assert.ok(output.includes('  ' + chrome + ': success'));
  assert.ok(output.includes('  A "tests/fixtures/html-content-editor/logical-components.html"'));
  assert.equal(output.at(-1), 'READY FOR RELEASE');
});

for (const [name, setup, reason] of [
  ['remote SHA mismatch', ({ state }) => { state.remote[0] = other; }, /Remote Verify differs/],
  ['local SHA mismatch', ({ state }) => { state.local[0] = other; return [candidate]; }, /differs from local Verify/],
  ['no matching CI', ({ state }) => { state.runs = []; }, /No Optima Verify run/],
  ['stale SHA', ({ run }) => { run.head_sha = other; }, /identity mismatch/],
  ['wrong branch', ({ run }) => { run.head_branch = 'main'; }, /identity mismatch/],
  ['wrong workflow', ({ run }) => { run.path = '.github/workflows/deploy-pages.yml'; }, /identity mismatch/],
  ['API failure', ({ state }) => { state.apiError = true; }, /API unavailable/],
  ['main advances during preflight', ({ state }) => { state.production[1] = other; }, /Remote main changed/],
  ['Verify advances during preflight', ({ state }) => { state.remote[1] = other; }, /Verify changed/],
  ['cannot fast-forward', ({ state }) => { state.ancestor = false; }, /cannot fast-forward/],
  ['forbidden file', ({ state }) => { state.diff = 'A\0tests/fixtures/html-content-editor/3d карточки.html\0'; }, /Forbidden release path/],
  ['missing Chrome', ({ job }) => { job.steps = job.steps.filter(step => step.name !== chrome); }, /Required step did not pass: Chrome/],
  ['skipped Chrome in a successful workflow', ({ job }) => { job.steps.find(step => step.name === chrome).conclusion = 'skipped'; }, /Required step did not pass: Chrome/],
  ['wrong job SHA', ({ job }) => { job.head_sha = other; }, /verify job is missing, mismatched or unsuccessful/],
  ['wrong job attempt', ({ job }) => { job.run_attempt = 1; }, /verify job is missing, mismatched or unsuccessful/],
  ['CI is retried during preflight', ({ state, run }) => { state.runs[1] = { ...run, run_attempt: 3 }; }, /run changed during/],
]) {
  test(name + ' blocks the release', async () => {
    const context = scenario();
    const args = setup(context) ?? [];
    assert.equal(await context.check(args), 1);
    assert.match(context.output.at(-1), /^BLOCKED — /);
    assert.match(context.output.at(-1), reason);
    assert.ok(!context.output.includes('READY FOR RELEASE'));
  });
}

for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
  test('blocks a workflow with conclusion ' + conclusion, async () => {
    const { check, run, output } = scenario();
    run.conclusion = conclusion;
    if (conclusion === null) run.status = 'in_progress';
    assert.equal(await check(), 1);
    assert.match(output.at(-1), /^BLOCKED — Latest Optima Verify run is not successful/);
  });
}
