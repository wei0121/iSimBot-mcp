import { stopClientRecording } from './recording.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

export const deviceTools: ToolDefinition[] = [
  {
    definition: {
      name: 'list_devices',
      description: 'List all available iOS simulators and devices',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    async execute(idbClient, args) {
      return await idbClient.listDevices();
    },
  },
  {
    definition: {
      name: 'boot_simulator',
      description: 'Boot a simulator by UDID',
      inputSchema: {
        type: 'object',
        properties: {
          udid: {
            type: 'string',
            description: 'Simulator UDID',
          },
        },
        required: ['udid'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.bootSimulator(args.udid as string);
      return { success: true, message: `Simulator ${args.udid} booted` };
    },
  },
  {
    definition: {
      name: 'shutdown_simulator',
      description: 'Shutdown a simulator by UDID',
      inputSchema: {
        type: 'object',
        properties: {
          udid: {
            type: 'string',
            description: 'Simulator UDID',
          },
        },
        required: ['udid'],
      },
    },
    async execute(idbClient, args) {
      const recording = await stopClientRecording(idbClient, 'device_shutdown');
      await idbClient.shutdownSimulator(args.udid as string);
      return { success: true, message: `Simulator ${args.udid} shut down`, ...(recording ? { recording } : {}) };
    },
  },
];
