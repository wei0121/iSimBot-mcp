import type { ToolDefinition } from '../mcp/tool-definition.js';

export const locationTools: ToolDefinition[] = [
  {
    definition: {
      name: 'set_location',
      description: 'Set GPS location for the simulator',
      inputSchema: {
        type: 'object',
        properties: {
          latitude: {
            type: 'number',
            description: 'Latitude',
          },
          longitude: {
            type: 'number',
            description: 'Longitude',
          },
        },
        required: ['latitude', 'longitude'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.setLocation(args.latitude as number, args.longitude as number);
      return {
        success: true,
        message: `Location set to (${args.latitude}, ${args.longitude})`,
      };
    },
  },
];
