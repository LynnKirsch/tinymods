import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'LynnKirsch/tinymods';
const verifyBranch = 'ci/optima-verify-next';
const verifyRef = 'refs/heads/' + verifyBranch;
const mainRef = 'refs/heads/main';
const workflow = 'optima-verify.yml';
const shaPattern = /^[0-9a-f]{40}$/;

export const requiredSteps = [
  'Checkout verification branch',
  'Install locked dependencies',
  'Generate Next types and check TypeScript',
  'Check AVIF speed and Worker/fallback options',
  'AVIF Worker and controlled fallback tests',
  'Image Optimizer tests',
  'HTML Content Editor core and repository tests',
  'HTML Content Editor fixture-dependent integration tests',
  'Shared navigation and help tests',
  'Build current Next.js static export',
  'Verify exported pages, Worker chunk and codec binaries',
  'Chrome browser acceptance (local static export, no external sends)',
  'Current Next HTML and public product context tests',
  'Report outcomes and browser acceptance',
];

function readGit(...args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        // Older Git versions lack GIT_NO_LAZY_FETCH. Local reads need no transports.
        ...(args[0] === 'ls-remote' ? {} : { GIT_ALLOW_PROTOCOL: '' }),
      },
    });
  } catch (error) {
    // Exit 1 alone is the ordinary negative answer from merge-base.
    if (args[0] === 'merge-base' && error.status === 1) return null;
    throw new Error('Git read failed (' + args[0] + ')');
  }
}

async function readGitHub(endpoint) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    if (!token) {
      // gh supplies its existing credentials without printing them.
      return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
      }));
    }
    const response = await fetch('https://api.github.com' + endpoint, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch {
    throw new Error('GitHub API unavailable. Check gh login or GH_TOKEN/GITHUB_TOKEN with Actions read access.');
  }
}

function remoteRefs(git) {
  const refs = new Map();
  for (const line of git('ls-remote', '--refs', 'origin', mainRef, verifyRef).trim().split(/\r?\n/)) {
    const [sha, ref] = line.split('\t');
    if (!shaPattern.test(sha) || ![mainRef, verifyRef].includes(ref) || refs.has(ref)) {
      throw new Error('Invalid remote refs');
    }
    refs.set(ref, sha);
  }
  if (refs.size !== 2) throw new Error('Remote main or Verify is missing');
  return refs;
}

const localFiles = /^(?:agents\.md|project\.md|optima-ui-design-system\.md|video\.html|tests\/fixtures\/html-content-editor\/(?:3d карточки\.html|дизайн-система ильино\.css|код слайдера\.html|модальное окно\.html|скрипт слайдера\.js))$/iu;
const localFolders = /(?:^|\/)(?:\.local-fixtures|\.playwright-mcp|references|node_modules|\.next|out|dist|avif-research|experiments|png-to-svg|svg-curve-editor|frontend-composer)(?:\/|$)/i;
const localArtifacts = /(?:^|\/)(?:\.env(?:\..*)?|agents\.md)$|\.(?:log|pem|key)$/i;
const rootMedia = /^[^/]+\.(?:png|jpe?g|webp|avif|gif|heic|svg|bmp|tiff?|mp4|mov|webm)$/i;

function changedFiles(git, production, candidate) {
  const records = git('diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', production, candidate, '--');
  if (!records) return [];
  const fields = records.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Invalid Git diff output');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [status, path] = fields.slice(index, index + 2);
    if (!/^[ADMT]$/.test(status) || !path) throw new Error('Invalid Git diff entry');
    changes.push({ status, path });
  }
  return changes;
}

export async function releaseCheck(args, { git = readGit, api = readGitHub, write = console.log } = {}) {
  try {
    if (args.length > 1 || (args.length === 1 && !shaPattern.test(args[0]))) {
      throw new Error('Use npm run release:check -- <full SHA>, or omit the SHA to check local Verify');
    }
    const localVerify = git('rev-parse', '--verify', verifyRef).trim();
    const candidate = args[0] ?? localVerify;
    if (!shaPattern.test(candidate)) throw new Error('Invalid local Verify SHA');
    write('Candidate SHA: ' + candidate);
    if (candidate !== localVerify) throw new Error('Candidate differs from local Verify');

    const origin = git('remote', 'get-url', 'origin').trim();
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)LynnKirsch\/tinymods(?:\.git)?$/i.test(origin)) {
      throw new Error('Unexpected origin repository');
    }
    const refs = remoteRefs(git);
    const production = refs.get(mainRef);
    write('Production SHA (remote main): ' + production);
    if (refs.get(verifyRef) !== candidate) throw new Error('Remote Verify differs from candidate');
    write('Verify SHA: success');

    if (git('merge-base', '--is-ancestor', production, candidate) === null) {
      throw new Error('Remote main cannot fast-forward to candidate');
    }
    write('Fast-forward: success');
    const changes = changedFiles(git, production, candidate);
    write('Changed files: ' + changes.length);
    for (const { status, path } of changes) write('  ' + status + ' ' + JSON.stringify(path));
    const forbidden = changes.find(({ status, path }) => status !== 'D' &&
      [localFiles, localFolders, localArtifacts, rootMedia].some(pattern => pattern.test(path)));
    if (forbidden) throw new Error('Forbidden release path: ' + JSON.stringify(forbidden.path));
    write('Release paths: success');

    const actions = '/repos/' + repository + '/actions';
    const query = new URLSearchParams({ branch: verifyBranch, head_sha: candidate, event: 'push', per_page: '1' });
    const runsEndpoint = actions + '/workflows/' + workflow + '/runs?' + query;
    const latestRun = async () => {
      const result = await api(runsEndpoint);
      if (!Array.isArray(result?.workflow_runs)) throw new Error('Invalid GitHub workflow response');
      const [run] = result.workflow_runs;
      if (!run) throw new Error('No Optima Verify run for this SHA');
      if (run.head_sha !== candidate || run.head_branch !== verifyBranch || run.event !== 'push' ||
          run.path !== '.github/workflows/' + workflow) throw new Error('Optima Verify run identity mismatch');
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        throw new Error('Latest Optima Verify run is not successful');
      }
      if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        throw new Error('Invalid GitHub run ID or attempt');
      }
      return run;
    };

    const run = await latestRun();
    const result = await api(actions + '/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100');
    if (!Array.isArray(result?.jobs) || result.total_count !== result.jobs.length) {
      throw new Error('Incomplete GitHub job results');
    }
    const jobs = result.jobs.filter(job => job.name === 'verify');
    const [job] = jobs;
    if (jobs.length !== 1 || job.head_sha !== candidate || job.head_branch !== verifyBranch ||
        job.run_id !== run.id || job.run_attempt !== run.run_attempt ||
        job.status !== 'completed' || job.conclusion !== 'success' || !Array.isArray(job.steps)) {
      throw new Error('The verify job is missing, mismatched or unsuccessful');
    }
    const checks = requiredSteps.map(name => {
      const matches = job.steps.filter(step => step.name === name);
      const passed = matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success';
      write('  ' + name + ': ' + (passed ? 'success' : 'missing or unsuccessful'));
      return { name, passed };
    });
    const failed = checks.find(check => !check.passed);
    if (failed) throw new Error('Required step did not pass: ' + failed.name);

    const currentRun = await latestRun();
    if (currentRun.id !== run.id || currentRun.run_attempt !== run.run_attempt) {
      throw new Error('Optima Verify run changed during the check');
    }
    const current = remoteRefs(git);
    if (current.get(mainRef) !== production) throw new Error('Remote main changed during the check');
    if (current.get(verifyRef) !== candidate || git('rev-parse', '--verify', verifyRef).trim() !== candidate) {
      throw new Error('Verify changed during the check');
    }
    write('Optima Verify: https://github.com/' + repository + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt);
    write('READY FOR RELEASE');
    return 0;
  } catch (error) {
    write('BLOCKED — ' + error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await releaseCheck(process.argv.slice(2));
}
