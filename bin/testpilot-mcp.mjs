#!/usr/bin/env node
// Thin launcher for the TypeScript MCP server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const server = path.join(root, 'src', 'mcp', 'server.ts');

const child = spawn(tsx, [server, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
