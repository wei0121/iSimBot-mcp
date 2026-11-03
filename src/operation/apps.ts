import type { ToolDefinition } from '../mcp/tool-definition.js';

export const appsTools: ToolDefinition[] = [
  {
    definition: {
      name: 'install_app',
      description: 'Install an app on the connected device',
      inputSchema: {
        type: 'object',
        properties: {
          appPath: {
            type: 'string',
            description: 'Path to .app bundle',
          },
        },
        required: ['appPath'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.installApp(args.appPath as string);
      return { success: true, message: 'App installed successfully' };
    },
  },
  {
    definition: {
      name: 'launch_app',
      description: 'Launch an app by bundle ID and wait for its process to report Running (up to 10 seconds). Does not guarantee UI or network content is ready.',
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle ID (e.g., com.example.app)',
          },
        },
        required: ['bundleId'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.launchApp(args.bundleId as string);
      return { success: true, message: `App ${args.bundleId} launched` };
    },
  },
  {
    definition: {
      name: 'terminate_app',
      description: 'Terminate a running app',
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle ID',
          },
        },
        required: ['bundleId'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.terminateApp(args.bundleId as string);
      return { success: true, message: `App ${args.bundleId} terminated` };
    },
  },
  {
    definition: {
      name: 'uninstall_app',
      description: 'Uninstall an app from the device',
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: {
            type: 'string',
            description: 'App bundle ID',
          },
        },
        required: ['bundleId'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.uninstallApp(args.bundleId as string);
      return { success: true, message: `App ${args.bundleId} uninstalled` };
    },
  },
];
