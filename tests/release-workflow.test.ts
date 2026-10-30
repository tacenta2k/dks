import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// js-yaml is already present in the locked dependency graph (used by the
// packaging toolchain). Load it through createRequire so this test does not
// add a runtime dependency or require separate YAML type packages.
const nodeRequire = createRequire(import.meta.url);
const { load: loadYaml } = nodeRequire('js-yaml') as {
  load: (content: string) => unknown;
};

type YamlMap = Record<string, unknown>;

type WorkflowStep = YamlMap & {
  name?: string;
  uses?: string;
  run?: string;
  with?: YamlMap;
  env?: Record<string, string>;
};

const root = resolve(__dirname, '..');
const workflowPath = resolve(root, '.github/workflows/release.yml');
const workflowText = readFileSync(workflowPath, 'utf8');
const workflow = asMap(loadYaml(workflowText), 'workflow document');
const jobs = asMap(workflow.jobs, 'workflow jobs');
const releaseJob = asMap(jobs.release, 'release job');
const steps = asArray(releaseJob.steps, 'release job steps') as WorkflowStep[];

function isMap(value: unknown): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asMap(value: unknown, label: string): YamlMap {
  expect(isMap(value), `${label} should be a YAML mapping`).toBe(true);
  return value as YamlMap;
}

function asArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} should be a YAML sequence`).toBe(true);
  return value as unknown[];
}

function workflowOn(document: YamlMap): YamlMap {
  // Some YAML 1.1 parsers expose the unquoted `on` key as boolean true.
  // GitHub Actions accepts the normal spelling in the workflow file.
  const trigger = document.on ?? document[String(true)];
  return asMap(trigger, 'workflow trigger');
}

function stepIndex(predicate: (step: WorkflowStep) => boolean, description: string): number {
  const index = steps.findIndex(predicate);
  expect(index, `missing workflow step: ${description}`).toBeGreaterThanOrEqual(0);
  return index;
}

function runIncludes(step: WorkflowStep, text: string): boolean {
  return typeof step.run === 'string' && step.run.includes(text);
}

describe('one-click Release DKS workflow', () => {
  it('is manual-only with the requested version bump choices', () => {
    expect(workflow.name).toBe('Release DKS');

    const on = workflowOn(workflow);
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);

    const dispatch = asMap(on.workflow_dispatch, 'workflow_dispatch trigger');
    const inputs = asMap(dispatch.inputs, 'workflow_dispatch inputs');
    expect(Object.keys(inputs)).toEqual(['bump', 'dry_run']);

    const bump = asMap(inputs.bump, 'bump input');
    expect(bump.type).toBe('choice');
    expect(bump.required).toBe(true);
    expect(bump.default).toBe('patch');
    expect(bump.options).toEqual(['patch', 'minor', 'major', 'none']);
  });

  it('uses one non-cancelling Windows job with only contents: write', () => {
    expect(workflow.concurrency).toEqual({
      group: 'release-dks',
      'cancel-in-progress': false,
    });
    expect(workflow.permissions).toEqual({ contents: 'write' });
    expect(Object.keys(jobs)).toEqual(['release']);
    expect(releaseJob['runs-on']).toBe('windows-2022');
    expect(releaseJob.permissions).toBeUndefined();
    expect(releaseJob.env).toEqual({
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
  });

  it('checks out full history from main and sets up the pinned Node and Python toolchains', () => {
    const checkoutIndex = stepIndex(
      (step) => step.uses === 'actions/checkout@v7',
      'actions/checkout',
    );
    const guardIndex = stepIndex(
      (step) => step.name === 'Require main branch',
      'main branch guard',
    );
    const setupNodeIndex = stepIndex(
      (step) => step.uses === 'actions/setup-node@v7',
      'actions/setup-node',
    );
    const setupPythonIndex = stepIndex(
      (step) => step.uses === 'actions/setup-python@v7',
      'actions/setup-python',
    );
    const configureToolchainIndex = stepIndex(
      (step) => step.name === 'Configure node-gyp toolchain',
      'node-gyp toolchain configuration',
    );
    const diagnosticsIndex = stepIndex(
      (step) => step.name === 'Show native build toolchain',
      'native build diagnostics',
    );
    const installIndex = stepIndex(
      (step) => runIncludes(step, 'npm ci'),
      'npm ci',
    );

    expect(checkoutIndex).toBe(0);
    expect(steps[checkoutIndex].with).toMatchObject({ 'fetch-depth': 0 });
    expect(guardIndex).toBeGreaterThan(checkoutIndex);
    expect(steps[guardIndex].run).toContain('refs/heads/main');
    expect(steps[guardIndex].run).toContain('must be run from the main branch');
    expect(steps[guardIndex].run).toContain('git switch main');
    expect(setupNodeIndex).toBeGreaterThan(guardIndex);
    expect(steps[setupNodeIndex].with).toMatchObject({
      'node-version-file': '.nvmrc',
      cache: 'npm',
    });
    expect(readFileSync(resolve(root, '.nvmrc'), 'utf8').trim()).toBe('20.19.0');

    expect(setupPythonIndex).toBeGreaterThan(setupNodeIndex);
    expect(steps[setupPythonIndex].id).toBe('setup-python');
    expect(steps[setupPythonIndex].with).toMatchObject({
      'python-version': '3.11',
    });

    expect(configureToolchainIndex).toBeGreaterThan(setupPythonIndex);
    expect(steps[configureToolchainIndex].env).toEqual({
      SELECTED_PYTHON: '${{ steps.setup-python.outputs.python-path }}',
    });
    expect(steps[configureToolchainIndex].run).toContain('Test-Path -LiteralPath $env:SELECTED_PYTHON');
    expect(steps[configureToolchainIndex].run).toContain(
      '"npm_config_python=$env:SELECTED_PYTHON" | Out-File -FilePath $env:GITHUB_ENV',
    );
    expect(steps[configureToolchainIndex].run).toContain(
      '"npm_config_msvs_version=2022" | Out-File -FilePath $env:GITHUB_ENV',
    );

    expect(diagnosticsIndex).toBeGreaterThan(configureToolchainIndex);
    expect(diagnosticsIndex).toBeLessThan(installIndex);
    expect(steps[diagnosticsIndex].env).toEqual({
      SELECTED_PYTHON: '${{ steps.setup-python.outputs.python-path }}',
    });
    const diagnostics = steps[diagnosticsIndex].run ?? '';
    expect(diagnostics).toContain('node --version');
    expect(diagnostics).toContain('npm --version');
    expect(diagnostics).toContain('python --version');
    expect(diagnostics).toContain('& $env:SELECTED_PYTHON --version');
    expect(diagnostics).toContain('v20.19.0');
    expect(diagnostics).toContain('^Python 3\\.11\\.');
    expect(diagnostics).toContain('$env:npm_config_python');
    expect(diagnostics).toContain('$env:npm_config_msvs_version');
    expect(diagnostics).toContain('vswhere.exe');
    expect(diagnostics).toContain("'[17.0,18.0)'");
    expect(diagnostics).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
    expect(diagnostics).toContain('cl.exe');
    expect(diagnostics).not.toContain('Get-Content .env');
    expect(diagnostics).not.toContain('Get-ChildItem Env:');
    expect(workflowText).not.toContain('hostedtoolcache');
  });

  it('installs, typechecks, and tests with the Node native binding before packaging', () => {
    const installIndex = stepIndex(
      (step) => runIncludes(step, 'npm ci'),
      'npm ci',
    );
    const typecheckIndex = stepIndex(
      (step) => runIncludes(step, 'npm run typecheck'),
      'typecheck',
    );
    const testIndex = stepIndex(
      (step) => runIncludes(step, 'npm test -- --testTimeout=60000'),
      'test suite',
    );
    const releaseIndex = stepIndex(
      (step) => runIncludes(step, 'npm run release'),
      'release packaging',
    );

    expect(steps[installIndex].run).toContain("require('better-sqlite3')");
    expect(steps[installIndex].run).toContain('npm rebuild better-sqlite3');
    expect(installIndex).toBeLessThan(typecheckIndex);
    expect(typecheckIndex).toBeLessThan(testIndex);
    expect(testIndex).toBeLessThan(releaseIndex);

    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const releaseScript = packageJson.scripts.release;
    expect(releaseScript).toContain('npm run verify:native');
    expect(releaseScript).toContain('electron-builder --config electron-builder.yml --publish always');
    expect(releaseScript.indexOf('npm run verify:native'))
      .toBeLessThan(releaseScript.indexOf('electron-builder'));
  });

  it('bumps and pushes the version before writing build secrets and packaging', () => {
    const versionIndex = stepIndex(
      (step) => step.name === 'Resolve version and tag',
      'version bump',
    );
    const envIndex = stepIndex(
      (step) => step.name === 'Write Vite build environment',
      'Vite environment',
    );
    const pushIndex = stepIndex(
      (step) => runIncludes(step, 'git push origin main --follow-tags'),
      'push version commit and tag',
    );
    const releaseIndex = stepIndex(
      (step) => runIncludes(step, 'npm run release'),
      'release packaging',
    );

    expect(steps[versionIndex].run).toContain('github-actions[bot]');
    expect(steps[versionIndex].run).toContain(
      'npm version ${{ inputs.bump }} -m "chore(release): v%s"',
    );
    expect(steps[versionIndex].id).toBe('version');

    expect(steps[envIndex].env).toEqual({
      VITE_SUPABASE_URL: '${{ secrets.VITE_SUPABASE_URL }}',
      VITE_SUPABASE_PUBLISHABLE_KEY: '${{ secrets.VITE_SUPABASE_PUBLISHABLE_KEY }}',
    });
    expect(steps[envIndex].run).toContain('Missing required repository secret(s)');
    expect(steps[envIndex].run).toContain('WriteAllLines');
    expect(steps[envIndex].run).not.toMatch(/Write-Host.*VITE_SUPABASE/);

    expect(versionIndex).toBeLessThan(envIndex);
    expect(envIndex).toBeLessThan(pushIndex);
    expect(pushIndex).toBeLessThan(releaseIndex);
  });

  it('publishes an already-tagged version with bump=none without moving the tag', () => {
    const versionIndex = stepIndex(
      (step) => step.name === 'Resolve version and tag',
      'version resolution',
    );
    const versionRun = steps[versionIndex].run ?? '';

    // v0.1.6 and v0.1.11 were tagged before their GitHub release existed.
    // Re-publishing that version must reuse the tag, never recreate or move it.
    expect(versionRun).toContain('$existing = git tag -l $tag');
    expect(versionRun).toContain('git rev-list -n 1 $tag');
    expect(versionRun).toContain('reusing it as-is (not recreated, not moved)');
    // And it must build THAT commit: a later main must not be published under
    // the old version/tag (ancestor-only checks allowed exactly that).
    expect(versionRun).toContain('if ($tagCommit -ne $head)');
    expect(versionRun).toContain('bump=none reuses tag');
    expect(versionRun).toContain('A release must build the tagged commit');
    expect(versionRun).not.toContain('cannot publish existing version twice');
    // The tag is only CREATED in the else branch (no existing tag).
    const existingBranch = versionRun.slice(
      versionRun.indexOf('$existing = git tag -l $tag'),
      versionRun.indexOf('} else {', versionRun.indexOf('$existing = git tag -l $tag')),
    );
    expect(existingBranch).not.toContain('git tag -a');
    expect(existingBranch).toContain('$tagCommit -ne $head');

    // A tag is never moved or force-pushed.
    expect(versionRun).not.toContain('git tag -f');
    expect(versionRun).not.toContain('--force');

    // The version still comes from package.json (bump=none = no new commit).
    expect(versionRun).toContain("node -p \"require('./package.json').version\"");
  });

  it('verifies the exact draft assets before publishing and reporting success', () => {
    const releaseIndex = stepIndex(
      (step) => runIncludes(step, 'npm run release'),
      'release packaging',
    );
    const verifyIndex = stepIndex(
      (step) => step.name === 'Verify draft release assets',
      'draft release verification',
    );
    const publishIndex = stepIndex(
      (step) => runIncludes(step, 'gh release edit'),
      'release publication',
    );
    // The workflow uploads two artifacts (the release build log and the
    // installer); this asserts the INSTALLER one comes after publishing.
    const artifactIndex = stepIndex(
      (step) => step.uses === 'actions/upload-artifact@v4'
        && String((step.with as Record<string, unknown> | undefined)?.name ?? '').includes('installer'),
      'installer artifact upload',
    );
    const summaryIndex = stepIndex(
      (step) => step.name === 'Write job summary',
      'job summary',
    );

    const verifyRun = steps[verifyIndex].run ?? '';
    expect(verifyRun).toContain('gh release view');
    expect(verifyRun).toContain('isDraft');
    expect(verifyRun).toContain('"$($env:INSTALLER_NAME).blockmap"');
    expect(verifyRun).toContain('"latest.yml"');
    expect(verifyRun).toContain('gh release download');
    expect(verifyRun).toContain('^version:');
    expect(verifyRun).toContain('INSTALLER_NAME');
    // Bug 2: latest.yml must be from the SAME electron-builder run as the exe — verify sha512/size + byte identity.
    expect(verifyRun).toContain('localLatestYml');
    expect(verifyRun).toContain('sha512');
    expect(verifyRun).toContain('installerSize');

    expect(releaseIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(publishIndex);
    expect(steps[publishIndex].run).toContain('--draft=false');
    expect(steps[publishIndex].run).toContain('--latest');
    expect(steps[publishIndex].run).not.toContain('--prerelease');
    expect(publishIndex).toBeLessThan(artifactIndex);
    expect(artifactIndex).toBeLessThan(summaryIndex);

    expect(steps[artifactIndex].with).toMatchObject({
      path: 'release/${{ steps.version.outputs.installer }}',
      // A missing installer is a warning here, not a second failure: this step
      // can only run after the packaging step reported success.
      'if-no-files-found': 'warn',
    });
    expect(steps[summaryIndex].run).toContain('GITHUB_STEP_SUMMARY');
    expect(steps[summaryIndex].env).toMatchObject({
      RELEASE_VERSION: '${{ steps.version.outputs.version }}',
      INSTALLER_NAME: '${{ steps.version.outputs.installer }}',
    });
    expect(steps[summaryIndex].env?.RELEASE_URL).toContain('/releases/tag/');
  });

  it('references only the approved Actions secrets and contains no literal credentials', () => {
    const referencedSecrets = [...workflowText.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1]);
    expect(new Set(referencedSecrets)).toEqual(new Set([
      'GITHUB_TOKEN',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    ]));

    expect(workflowText).not.toMatch(/gh[pousr]_[A-Za-z0-9_]{20,}/);
    expect(workflowText).not.toMatch(/github_pat_[A-Za-z0-9_]+/);
    expect(workflowText).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(workflowText).not.toMatch(/service[_-]?role/i);
    expect(workflowText).not.toMatch(/RESEND_API_KEY|DB_PASSWORD|DATABASE_PASSWORD/);
    const credentialAssignments = workflowText
      .split(/\r?\n/)
      .filter((line) => /^\s*(?:GH_TOKEN|GITHUB_TOKEN|VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY):/.test(line));
    expect(credentialAssignments).toHaveLength(3);
    for (const assignment of credentialAssignments) {
      expect(assignment).toMatch(/:\s*\$\{\{\s*secrets\./);
    }
  });
});

describe('electron-builder release safety', () => {
  it('still uploads GitHub releases as drafts with the packaged native-module guards', () => {
    const builder = asMap(
      loadYaml(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')),
      'electron-builder configuration',
    );
    const publish = asMap(builder.publish, 'electron-builder publish configuration');

    expect(publish).toMatchObject({
      provider: 'github',
      owner: 'tacenta2k',
      repo: 'dks',
      releaseType: 'draft',
    });
    expect(builder.afterPack).toBe('scripts/after-pack.cjs');
    expect(builder.asarUnpack).toContain('node_modules/better-sqlite3/**');
  });
});

/**
 * Release state lookup (v0.1.11 recovery).
 *
 * v0.1.11 was tagged but its release run failed while packaging, so the tag
 * exists and no GitHub release does. Re-running with bump=none is the intended
 * recovery — but only if the workflow (a) builds the tagged commit and (b)
 * refuses to overwrite a release that already exists. A failed API call must
 * never be read as "no release yet".
 */
describe('release state confirmation', () => {
  const index = stepIndex(
    (step) => step.name === 'Confirm release state for the tag',
    'release state confirmation',
  );
  const run = steps[index].run ?? '';

  it('runs before anything is built or published', () => {
    const versionIndex = stepIndex((step) => step.name === 'Resolve version and tag', 'version resolution');
    const releaseIndex = stepIndex((step) => runIncludes(step, 'npm run release'), 'release packaging');
    expect(versionIndex).toBeLessThan(index);
    expect(index).toBeLessThan(releaseIndex);
  });

  it('treats only HTTP 404 as "no release exists"', () => {
    expect(run).toContain('releases/tags/$tag');
    expect(run).toContain('$status -eq 404');
    expect(run).toContain('No release exists for $tag (HTTP 404)');
    // Any other answer (auth, rate limit, outage) stops the release.
    expect(run).toContain('Could not determine the HTTP status');
    expect(run).toContain('Unexpected HTTP $status');
    expect(run).toContain('exit 1');
  });

  it('refuses to publish over an existing published release and allows completing a draft', () => {
    expect(run).toContain('if (-not $release.draft)');
    expect(run).toContain('already exists and is PUBLISHED');
    expect(run).toContain('Nothing was built or published');
    expect(run).toContain('this run will complete it');
  });
});

describe('release failure diagnostics', () => {
  it('names the file holder while the packaging output still exists', () => {
    const releaseIndex = stepIndex((step) => runIncludes(step, 'npm run release'), 'release packaging');
    const run = steps[releaseIndex].run ?? '';
    // rcedit's "Unable to commit changes" does not say who held the file, and
    // the log is the only place the release can explain itself afterwards.
    expect(run).toContain('npm run release 1>%RELEASE_LOG% 2>&1');
    expect(steps[releaseIndex].env).toMatchObject({ RELEASE_LOG: expect.stringContaining('release-build.log') });
    expect(run).toContain('holder-lookup.cjs release/win-unpacked/DKS.exe');
    const failureBranch = run.slice(run.indexOf('if ($code -ne 0)'));
    expect(failureBranch).toContain('holder-lookup.cjs');
    expect(failureBranch.indexOf('holder-lookup.cjs')).toBeLessThan(
      failureBranch.indexOf('last 120 lines'),
    );
  });
});

/**
 * Dry run (Option B before publishing v0.1.11).
 *
 * A dry run must exercise the release sequence — build, verify:native, then
 * electron-builder — while changing nothing: `--publish never`, no tag push,
 * no release verification or publication. Anything that could publish has to
 * be conditionally skipped, not merely "usually fast".
 */
describe('dry run', () => {
  const inputs = asMap(workflowOn(workflow).workflow_dispatch, 'workflow_dispatch inputs');
  const inputMap = asMap(inputs.inputs, 'workflow inputs');

  it('is an explicit boolean input, off by default', () => {
    const dryRun = asMap(inputMap.dry_run, 'dry_run input');
    expect(dryRun.type).toBe('boolean');
    expect(dryRun.default).toBe(false);
    expect(dryRun.required).toBe(false);
  });

  it('packages with --publish never instead of npm run release', () => {
    const releaseIndex = stepIndex((step) => runIncludes(step, 'npm run release'), 'release packaging');
    const run = steps[releaseIndex].run ?? '';
    expect(run).toContain('if ("${{ inputs.dry_run }}" -eq "true")');
    expect(run).toContain('npx electron-builder --config electron-builder.yml --publish never');
    expect(run).toContain('npm run verify:native');
    expect(run).toContain('npm run build 1>%RELEASE_LOG% 2>&1');
    // The publish path is the else branch, unchanged.
    const elseBranch = run.slice(run.indexOf('} else {'));
    expect(elseBranch).toContain('npm run release 1>%RELEASE_LOG% 2>&1');
    expect(elseBranch).not.toContain('--publish never');
  });

  it('never pushes a tag, verifies assets or publishes in a dry run', () => {
    for (const name of ['Push version commit and tag', 'Verify draft release assets', 'Publish verified release']) {
      const index = stepIndex((step) => step.name === name, name);
      expect(String(steps[index].if ?? '')).toContain('inputs.dry_run != true');
    }
    // The upload steps are evidence, not publication: they still run.
    const uploadLog = stepIndex((step) => step.name === 'Upload release build log', 'log upload');
    expect(String(steps[uploadLog].if ?? '')).toBe('always()');
  });

  it('does not create a local tag in a dry run, and says what a real run would do', () => {
    const versionIndex = stepIndex((step) => step.name === 'Resolve version and tag', 'version resolution');
    const run = steps[versionIndex].run ?? '';
    const dryBranchStart = run.indexOf('} elseif ($dryRun) {');
    expect(dryBranchStart).toBeGreaterThan(-1);
    const dryBranch = run.slice(dryBranchStart, run.indexOf('} else {', dryBranchStart));
    expect(dryBranch).toContain('DRY RUN: tag $tag does not exist');
    expect(dryBranch).toContain('TAG_ACTION=dry-run-would-create');
    expect(dryBranch).not.toContain('git tag -a');
  });

  it('posts the packaging evidence where an API-only reader can see it', () => {
    const index = stepIndex((step) => step.name === 'Post release build evidence', 'evidence comment');
    expect(String(steps[index].if ?? '')).toBe('always()');
    const run = steps[index].run ?? '';
    expect(run).toContain('commits/${{ github.sha }}/comments');
    // The log path comes from the step env (RELEASE_LOG), not a literal.
    expect(run).toContain('$log = $env:RELEASE_LOG');
    expect(run).toContain('PACKAGING_EXIT');
    expect(run).toContain('TAG_ACTION');
  });

  it('the job summary never claims a publication happened in a dry run', () => {
    const index = stepIndex((step) => step.name === 'Write job summary', 'job summary');
    const run = steps[index].run ?? '';
    expect(run).toContain('DRY RUN — nothing was published');
    expect(run.indexOf('DRY RUN')).toBeLessThan(run.indexOf('# DKS release published'));
  });
});

/**
 * Regressions from the first dry run (30 Oct 2026).
 *
 * The dry run stopped before packaging for three workflow-only reasons — none
 * of them in the product code:
 *
 *  1. "Confirm release state" decided to proceed on the 404, then the step
 *     still exited 1, because a `gh api` 404 sets `$LASTEXITCODE = 1` and the
 *     pwsh wrapper ends with `exit $LASTEXITCODE`.
 *  2. The resolve step printed "would create it at ." — `$head` was only
 *     assigned in a branch that a missing tag never reached.
 *  3. The evidence/summary steps threw "Value cannot be null" from
 *     `Test-Path $log` when the packaging step never ran.
 */
describe('dry-run workflow regressions', () => {
  const stateIndex = stepIndex(
    (step) => step.name === 'Confirm release state for the tag',
    'release state confirmation',
  );
  const stateRun = steps[stateIndex].run ?? '';
  const versionRun = steps[stepIndex((step) => step.name === 'Resolve version and tag', 'version resolution')].run ?? '';
  const evidenceIndex = stepIndex((step) => step.name === 'Post release build evidence', 'evidence comment');
  const evidenceRun = steps[evidenceIndex].run ?? '';
  const summaryRun = steps[stepIndex((step) => step.name === 'Write job summary', 'job summary')].run ?? '';

  /** Text of one PowerShell branch of a step, up to the next branch marker. */
  function branch(text: string, marker: string, nextMarkers: string[]): string {
    const start = text.indexOf(marker);
    expect(start, `missing branch: ${marker}`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + marker.length);
    const ends = nextMarkers
      .map((next) => rest.indexOf(next))
      .filter((position) => position >= 0);
    return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
  }

  it('reads the HTTP status instead of gh\'s exit code', () => {
    expect(stateRun).toContain('gh api --include');
    expect(stateRun).toMatch(/HTTP\/\[0-9\.\]\+/);
    // The old code branched on $LASTEXITCODE, which any 404 makes non-zero.
    expect(stateRun).not.toMatch(/\$code = \$LASTEXITCODE/);
  });

  it('404 — proceeds and exits 0', () => {
    const notFound = branch(stateRun, 'elseif ($status -eq 404) {', ['} else {']);
    expect(notFound).toContain('No release exists for $tag (HTTP 404)');
    expect(notFound).not.toContain('exit 1');

    // The step's last statement is an explicit `exit 0`, so the pwsh wrapper's
    // `exit $LASTEXITCODE` (1, from the 404) can never decide the step's result.
    const statements = stateRun
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(statements.at(-1)).toBe('exit 0');
  });

  it('published release — fails, and never proceeds to build', () => {
    const published = branch(stateRun, 'if (-not $release.draft) {', ['Write-Host "Draft release']);
    expect(published).toContain('already exists and is PUBLISHED');
    expect(published).toContain('exit 1');
    // The proceed line lives in the *else* of the draft check, so a published
    // release can never reach `exit 0`.
    expect(published).not.toContain('exit 0');
  });

  it('unexpected status — fails instead of assuming "no release yet"', () => {
    const unexpected = branch(stateRun, '} else {', ['\n          # Proceed path']);
    expect(unexpected).toContain('Unexpected HTTP $status');
    expect(unexpected).toContain('exit 1');
  });

  it('resolves HEAD once, before any branch can use it, and refuses an empty value', () => {
    const headIndex = versionRun.indexOf('$head = (git rev-parse HEAD).Trim()');
    const firstBranch = versionRun.indexOf('if ("${{ inputs.bump }}" -eq "none")');
    expect(headIndex).toBeGreaterThanOrEqual(0);
    expect(headIndex).toBeLessThan(firstBranch);
    // Assigned exactly once: a second assignment would re-open the gap.
    expect(versionRun.match(/\$head = /g)).toHaveLength(1);
    // Guarded before use.
    expect(versionRun).toContain('IsNullOrWhiteSpace($head)');
    expect(versionRun.indexOf('IsNullOrWhiteSpace($head)')).toBeLessThan(
      versionRun.indexOf('would create it at $head'),
    );
  });

  it('the evidence step tolerates a build step that never ran', () => {
    // The log path is defined in this step; it is not inherited from packaging.
    expect(steps[evidenceIndex].env).toMatchObject({ RELEASE_LOG: expect.stringContaining('release-build.log') });
    // Null-guarded before Test-Path, which rejects a null -Path.
    expect(evidenceRun).toContain('IsNullOrWhiteSpace($log)');
    expect(evidenceRun.indexOf('IsNullOrWhiteSpace($log)')).toBeLessThan(
      evidenceRun.indexOf('Test-Path -LiteralPath $log'),
    );
    expect(evidenceRun).toContain('build step did not run');
    // Never the unguarded form that threw "Value cannot be null".
    expect(evidenceRun).not.toMatch(/Test-Path \$log\b/);
  });

  it('the job summary tolerates missing outputs', () => {
    expect(String(steps[stepIndex((step) => step.name === 'Write job summary', 'job summary')].if ?? '')).toBe('always()');
    expect(summaryRun).toContain('build step did not run');
    expect(summaryRun).toContain('unknown (resolve step did not finish)');
    // The dry-run claim is unconditional for a dry run, and unreachable otherwise.
    const dryBranch = branch(summaryRun, 'if ($dryRun) {', ['} else {']);
    expect(dryBranch).toContain('nothing was published');
    expect(dryBranch).not.toContain('# DKS release published');
  });

  it('the installer artifact only uploads after a successful packaging step', () => {
    const artifactIndex = stepIndex(
      (step) => step.uses === 'actions/upload-artifact@v4'
        && String((step.with as Record<string, unknown> | undefined)?.name ?? '').includes('installer'),
      'installer artifact upload',
    );
    expect(String(steps[artifactIndex].if ?? '')).toContain("steps.package.outputs.exit == '0'");
    expect(steps[artifactIndex].with).toMatchObject({ 'if-no-files-found': 'warn' });
    // ...which requires the packaging step to publish that output.
    const packageIndex = stepIndex((step) => runIncludes(step, 'npm run release'), 'release packaging');
    expect(steps[packageIndex].id).toBe('package');
    expect(steps[packageIndex].run).toContain('"exit=$code" | Out-File -FilePath $env:GITHUB_OUTPUT');
  });
});

/**
 * GitHub parses `${{ … }}` anywhere in a workflow value, including inside a
 * `run:` block. A stray, unclosed opener makes GitHub reject the whole file
 * ("workflow file issue") even though the YAML itself is valid — which is
 * exactly how the release step harness failed to start the first time.
 */
describe('no stray workflow expressions', () => {
  const workflowDir = resolve(root, '.github/workflows');
  const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));

  it.each(files)('%s has no unclosed ${{', (file) => {
    const text = readFileSync(resolve(workflowDir, file), 'utf8');
    const offenders = text
      .split('\n')
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => {
        const openers = [...line.matchAll(/\$\{\{/g)];
        if (openers.length === 0) return false;
        // Every opener needs a closing brace pair after it on the same line.
        return openers.some((match) => !line.slice(match.index + 3).includes('}}'));
      });
    expect(offenders.map(({ line, index }) => `${file}:${index}: ${line.trim()}`)).toEqual([]);
  });
});
