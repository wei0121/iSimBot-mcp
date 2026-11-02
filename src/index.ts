#!/usr/bin/env node
import { runCli } from './cli.js';

try {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  } else {
    const { startServer } = await import('./mcp/server.js');
    await startServer();
  }
} catch (error) {
  console.error('Fatal error:', error);
  process.exitCode = 1;
}
