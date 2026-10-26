import { readFileSync } from 'node:fs';
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
    expect(Object.keys(inputs)).toEqual(['bump']);

    const bump = asMap(inputs.bump, 'bump input');
    expect(bump.type).toBe('choice');
    expect(bump.required).toBe(true);
    expect(bump.default).toBe('patch');
    expect(bump.options).toEqual(['patch', 'minor', 'major']);
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
      (step) => step.name === 'Bump version and create tag',
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
    const artifactIndex = stepIndex(
      (step) => step.uses === 'actions/upload-artifact@v4',
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

    expect(releaseIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(publishIndex);
    expect(steps[publishIndex].run).toContain('--draft=false');
    expect(steps[publishIndex].run).toContain('--latest');
    expect(steps[publishIndex].run).not.toContain('--prerelease');
    expect(publishIndex).toBeLessThan(artifactIndex);
    expect(artifactIndex).toBeLessThan(summaryIndex);

    expect(steps[artifactIndex].with).toMatchObject({
      path: 'release/${{ steps.version.outputs.installer }}',
      'if-no-files-found': 'error',
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
