/**
 * TestPilot CLI entry point.
 * Parses `testpilot analyze --repo <path> --base <ref> --head <ref>` only;
 * wiring the pipeline together comes later.
 */

export interface AnalyzeOptions {
  command: 'analyze';
  repo: string;
  base: string;
  head: string;
}

const USAGE = 'Usage: testpilot analyze --repo <path> --base <ref> --head <ref>';

export function parseArgs(argv: string[]): AnalyzeOptions {
  const [command, ...rest] = argv;

  if (command !== 'analyze') {
    throw new Error(USAGE);
  }

  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];

    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(USAGE);
    }
    flags.set(flag.slice(2), value);
  }

  const repo = flags.get('repo');
  const base = flags.get('base');
  const head = flags.get('head');

  if (!repo || !base || !head) {
    throw new Error(USAGE);
  }

  return { command, repo, base, head };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  try {
    const options = parseArgs(argv);
    // The pipeline is intentionally not implemented in this skeleton.
    console.log(JSON.stringify(options, null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
