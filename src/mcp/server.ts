/**
 * TestPilot MCP server. Transport: stdio by default, optional localhost HTTP.
 * stdout carries protocol messages only; logs go to stderr.
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  analyzePullRequest,
  generateRegressionTests,
  getRunStatus,
  getVerificationReport,
  repairRegressionTool,
  runRegressionTests,
  runTestpilotLoop
} from './tools';

export function createTestPilotServer(): McpServer {
  const server = new McpServer({ name: 'testpilot', version: '0.5.0' });

  server.registerTool(
    'analyze_pull_request',
    {
      title: 'Analyze a pull request',
      description:
        'Analyze a base..head change and report changed functions, callers and callers without tests. Use this first.',
      inputSchema: {
        repoPath: z.string().describe('Path to an allowlisted git repository.'),
        base: z.string().describe('Base revision (branch, tag or SHA).'),
        head: z.string().describe('Head revision (branch, tag or SHA).')
      }
    },
    async (args) => analyzePullRequest(args)
  );

  server.registerTool(
    'generate_regression_tests',
    {
      title: 'Generate regression tests',
      description:
        'Plan scenarios and generate base-validated Jest tests. Use after analyze_pull_request, or pass repoPath/base/head.',
      inputSchema: {
        runId: z.string().optional().describe('Run id returned by analyze_pull_request.'),
        repoPath: z.string().optional().describe('Repository path when no runId is given.'),
        base: z.string().optional().describe('Base revision when no runId is given.'),
        head: z.string().optional().describe('Head revision when no runId is given.'),
        provider: z
          .enum(['anthropic', 'openai', 'google'])
          .optional()
          .describe('LLM provider; defaults to the configured provider.'),
        maxScenarios: z.number().int().min(1).max(3).optional().describe('How many scenarios to generate.')
      }
    },
    async (args) => generateRegressionTests(args)
  );

  server.registerTool(
    'run_regression_tests',
    {
      title: 'Run regression tests',
      description:
        'Verify the generated test on base and head and return the verdict. Use after generation.',
      inputSchema: {
        runId: z.string().describe('Run id that already has generated tests.'),
        repeat: z.number().int().min(1).max(10).optional().describe('Runs per revision for flakiness detection.')
      }
    },
    async (args) => runRegressionTests(args)
  );

  server.registerTool(
    'repair_regression',
    {
      title: 'Repair a regression',
      description:
        'Propose and verify a guarded source fix. Only valid when the verdict is regression_caught.',
      inputSchema: {
        runId: z.string().describe('Run id whose verdict is regression_caught.'),
        maxAttempts: z.number().int().min(1).max(5).optional().describe('Repair attempts before giving up.')
      }
    },
    async (args) => repairRegressionTool(args)
  );

  server.registerTool(
    'get_verification_report',
    {
      title: 'Get verification report',
      description:
        'Return a summary object, or the full deterministic markdown report. Use to explain the result or post a PR comment.',
      inputSchema: {
        runId: z.string().describe('Run id to report on.'),
        format: z
          .enum(['summary', 'markdown'])
          .optional()
          .describe('summary (default) or markdown for the full report.')
      }
    },
    async (args) => getVerificationReport(args)
  );

  server.registerTool(
    'run_testpilot_loop',
    {
      title: 'Run the full TestPilot loop',
      description:
        'Run analyze, generate, verify and repair in the background. Returns immediately; poll get_run_status.',
      inputSchema: {
        repoPath: z.string().describe('Path to an allowlisted git repository.'),
        base: z.string().describe('Base revision.'),
        head: z.string().describe('Head revision.'),
        provider: z
          .enum(['anthropic', 'openai', 'google'])
          .optional()
          .describe('LLM provider; defaults to the configured provider.'),
        maxScenarios: z.number().int().min(1).max(3).optional().describe('Scenarios to generate.')
      }
    },
    async (args) => runTestpilotLoop(args)
  );

  server.registerTool(
    'get_run_status',
    {
      title: 'Get run status',
      description:
        'Poll a run started by run_testpilot_loop or any other tool: stage, status, elapsed time and verdict.',
      inputSchema: {
        runId: z.string().describe('Run id to poll.')
      }
    },
    async (args) => getRunStatus(args)
  );

  return server;
}

export interface McpServerOptions {
  http?: boolean;
  port?: number;
}

export interface RunningMcpServer {
  url?: string;
  close: () => Promise<void>;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<RunningMcpServer> {
  const server = createTestPilotServer();

  if (!options.http) {
    await server.connect(new StdioServerTransport());
    console.error('TestPilot MCP server running on stdio');
    return { close: () => server.close() };
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const httpServer: Server = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });

  const port = options.port ?? 4318;
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  console.error(`TestPilot MCP server running at http://127.0.0.1:${actualPort}`);

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await server.close();
    }
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  await startMcpServer({
    http: args.includes('--http'),
    port: portIndex >= 0 ? Number.parseInt(args[portIndex + 1], 10) : undefined
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}