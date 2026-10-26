/**
 * One structured LLM call per scenario, plus a static lint pass for generated
 * Jest tests and a strictly scoped writer for __testpilot__/ files.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { z } from 'zod';
import type { LanguageModelUsage } from 'ai';
import { generateStructured, type ProviderName } from '../llm/client';
import { buildGenerationPrompt, buildRepairPrompt } from '../llm/prompts';
import type { ContextPack } from './context';
import { scenarioFileName } from './naming';
import type { Scenario } from './plan';

export const GeneratedTestSchema = z.object({
  fileName: z.string().min(1),
  code: z.string().min(1),
  assumptions: z.array(z.string()),
  testsWhat: z.string()
});

export type GeneratedTest = z.infer<typeof GeneratedTestSchema>;

export interface GenerateTestOptions {
  pack: ContextPack;
  scenario: Scenario;
  previous?: { code: string; error: string };
  provider?: ProviderName;
  model?: string;
}

export interface GeneratedTestResult {
  test: GeneratedTest;
  prompt: string;
  system: string;
  provider: ProviderName;
  model: string;
  usage: LanguageModelUsage;
}

export async function generateTest(
  options: GenerateTestOptions
): Promise<GeneratedTestResult> {
  const promptPair = options.previous
    ? buildRepairPrompt(options.pack, options.scenario, options.previous)
    : buildGenerationPrompt(options.pack, options.scenario);

  const result = await generateStructured({
    provider: options.provider,
    model: options.model,
    system: promptPair.system,
    prompt: promptPair.prompt,
    schema: GeneratedTestSchema,
    temperature: 0.1
  });

  return {
    test: result.data,
    prompt: promptPair.prompt,
    system: promptPair.system,
    provider: result.provider,
    model: result.model,
    usage: result.usage
  };
}

export interface LintOptions {
  fileName: string;
  code: string;
  worktreeDir: string;
  expectedFileName?: string;
}

export interface LintResult {
  ok: boolean;
  errors: string[];
}

const FILE_NAME = /^__testpilot__\/[a-z0-9]+(?:-[a-z0-9]+)*\.testpilot\.test\.ts$/;

function importExists(specifier: string, fileName: string, worktreeDir: string): boolean {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fileName), specifier)
  );
  const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`];
  return candidates.some((candidate) => {
    if (candidate.startsWith('..')) {
      return existsSync(path.resolve(worktreeDir, candidate));
    }
    return existsSync(path.join(worktreeDir, candidate));
  });
}

export function lintGeneratedTest(options: LintOptions): LintResult {
  const errors: string[] = [];
  const normalized = options.fileName.split(path.sep).join('/');

  if (!FILE_NAME.test(normalized)) {
    errors.push(
      'fileName must match __testpilot__/<kebab-scenario>.testpilot.test.ts'
    );
  }
  if (options.expectedFileName && normalized !== options.expectedFileName) {
    errors.push(`fileName must be exactly ${options.expectedFileName}`);
  }
  if (/reference|regression-tests|__testpilot__/i.test(options.code)) {
    errors.push('code mentions forbidden reference/answer-key paths');
  }
  if (/\.(skip|only)\s*\(/.test(options.code)) {
    errors.push('code uses .skip or .only');
  }
  if (/toMatch(?:Inline)?Snapshot/.test(options.code)) {
    errors.push('snapshot assertions are not allowed');
  }

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(`/${normalized}`, options.code);

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier.startsWith('.')) {
      errors.push(`bare import "${specifier}" is not allowed`);
      continue;
    }
    if (!importExists(specifier, normalized, options.worktreeDir)) {
      errors.push(`import path does not exist: ${specifier}`);
    }
  }

  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  let expectCalls = 0;
  let describeCalls = 0;
  let testCalls = 0;

  for (const call of calls) {
    const callee = call.getExpression().getText();

    if (callee === 'expect') {
      expectCalls += 1;
      const firstArg = call.getArguments()[0]?.getText().trim();
      if (firstArg === 'true') errors.push('expect(true) is not a meaningful assertion');
    }
    if (callee === 'describe') describeCalls += 1;
    if (callee === 'it' || callee === 'test') testCalls += 1;
  }

  if (expectCalls === 0) errors.push('no expect() assertions found');
  if (describeCalls !== 1) errors.push(`expected exactly one describe block, found ${describeCalls}`);
  if (testCalls < 1 || testCalls > 3) {
    errors.push(`expected 1 to 3 it/test blocks, found ${testCalls}`);
  }

  return { ok: errors.length === 0, errors };
}

export interface WriteTestInput {
  repo: string;
  relativePath: string;
  source: string;
}

export async function writeGeneratedTest(input: WriteTestInput): Promise<string> {
  const relative = input.relativePath.split(path.sep).join('/');

  if (!relative.startsWith('__testpilot__/') || relative.includes('..')) {
    throw new Error(`Refusing to write outside __testpilot__/: ${input.relativePath}`);
  }

  const absolute = path.join(input.repo, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, input.source, 'utf8');
  return absolute;
}

export function expectedFileName(scenario: Scenario): string {
  return scenarioFileName(scenario.id);
}