import { setup } from './setting/client-config.js';
import { doctor } from './diagnostics/doctor.js';
import { version } from './version.js';

// undefined means no CLI command was supplied: start the MCP server.
export async function runCli(args: string[]): Promise<number | undefined> {
  if (args.length) {
    let exitCode = 0;
    try {
      if (args.length !== 1) throw new Error('Expected one command. Run isimbot --help.');
      switch (args[0]) {
        case '--help':
        case '-h':
          console.log(`isimbot — iSimBot-MCP, iOS Simulator MCP server
  Usage:
    isimbot            Start MCP server (stdio)
    isimbot --version  Show version
    isimbot --help     Show help
    isimbot doctor     Check local dependencies and configuration (read-only)
    isimbot setup      Choose Claude Code or Codex and add MCP configuration

  Configuration removal is intentionally not supported.`);
          break;
        case '--version':
        case '-v': console.log(version); break;
        case 'doctor': exitCode = await doctor() ? 0 : 1; break;
        case 'setup': await setup(); break;
        default: throw new Error(`Unknown command: ${args[0]}. Run isimbot --help.`);
      }
    } catch (error) {
      console.error((error as Error).message);
      exitCode = 1;
    }
    return exitCode;
  }

}
