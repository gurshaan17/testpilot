/**
 * End-to-end generation pipeline with deterministic stub LLM calls.
 * Proves worktrees, prompts, artifacts, base validation and head preview.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LanguageModelUsage } from 'ai';
import { analyzeRepo } from '../analysis/analyze';
import { generateTests } from './engine';
import type { PlanningResult, PlanOptions } from './plan';
import type { GeneratedTestResult, GenerateTestOptions } from './writeTest';

const repoPath = path.resolve('../demo-shop');

const usage: LanguageModelUsage = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 20, reasoningTokens: 0 }
};

const profileTest = `
import { reset, seed } from '../src/users/userRepository';
import { getPublicProfile } from '../src/users/userProfileService';

describe('public profile', () => {
  beforeEach(() => {
    reset();
    seed([
      {
        id: 'usr_1',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        passwordHash: 'correct-horse',
        active: true
      }
    ]);
  });

  it('returns the public display name', async () => {
    await expect(getPublicProfile('usr_1')).resolves.toEqual({
      id: 'usr_1',
      displayName: 'Ada Lovelace'
    });
  });
});
`;

function fakePlan(_options: PlanOptions): Promise<PlanningResult> {
  const scenario = {
    id: 'public-profile',
    title: 'public profile still resolves',
    risk: 'lean objects lose prototype methods',
    kind: 'contract' as const,
    expectedBehaviorOnBase: 'getPublicProfile returns the display name',
    howChangeMayViolateIt: 'lean() removes toPublicProfile',
    evidence: [{ file: 'src/users/userProfileService.ts', line: 6, note: 'call site' }],
    severity: 'high' as const,
    testable: true
  };

  return Promise.resolve({
    scenarios: [scenario],
    selected: [scenario],
    droppedEvidence: [],
    provider: 'anthropic',
    model: 'fake-model',
    usage,
    prompt: 'PLAN PROMPT',
    system: 'PLAN SYSTEM'
  });
}

function fakeGenerate(options: GenerateTestOptions): Promise<GeneratedTestResult> {
  return Promise.resolve({
    test: {
      fileName: `__testpilot__/${options.scenario.id}.testpilot.test.ts`,
      code: profileTest,
      assumptions: ['getPublicProfile uses instance methods'],
      testsWhat: 'public profile contract'
    },
    prompt: 'GENERATE PROMPT',
    system: 'GENERATE SYSTEM',
    provider: 'anthropic',
    model: 'fake-model',
    usage
  });
}

test('generation pipeline writes valid test, log and prompts', { timeout: 240_000 }, async () => {
  const report = await analyzeRepo({ repoPath, base: 'main', head: 'bug/user-lean' });
  const outRoot = await mkdtemp(path.join(tmpdir(), 'testpilot-engine-'));

  try {
    const run = await generateTests({
      repoPath,
      base: 'main',
      head: 'bug/user-lean',
      report,
      outRoot,
      deps: { planScenarios: fakePlan, generateTest: fakeGenerate }
    });

    assert.equal(run.provider, 'anthropic');
    assert.equal(run.model, 'fake-model');
    assert.equal(run.scenarios.length, 1);
    assert.equal(run.scenarios[0].status, 'valid');
    assert.equal(run.scenarios[0].attempts.length, 1);
    assert.equal(run.scenarios[0].attempts[0].step, null);
    assert.equal(run.scenarios[0].headPreview?.passed, false);

    const testFile = path.join(run.outDir, '__testpilot__/public-profile.testpilot.test.ts');
    assert.match(await readFile(testFile, 'utf8'), /getPublicProfile/);

    const logged = JSON.parse(await readFile(run.generationPath, 'utf8'));
    assert.equal(logged.promptVersion, 'v2');
    assert.equal(logged.scenarios[0].status, 'valid');
    assert.equal(logged.scenarios[0].headPreview.passed, false);
    assert.equal(logged.totalUsage.totalTokens, 60);

    const prompts = await readdir(path.join(run.outDir, 'prompts'));
    assert.equal(prompts.length, 2);
    assert.equal(run.prompts.length, 2);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});
