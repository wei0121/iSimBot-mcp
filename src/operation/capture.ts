import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { parseElements } from './accessibility-elements.js';
import { captureScreenshot, imageDescription, imageInputSchema, parseImageArguments } from './screenshot.js';

export const captureTools: ToolDefinition[] = [{
  definition: {
    name: 'capture',
    description: 'Capture the screen and all accessibility elements. Default mode logical (or saved setup mode). Top-level elements includes label, title, value, identifier, role, type, enabled, frame and center. Both mode includes one elements list alongside images. Element frames and centers ALWAYS use logical points: tap center with the same deviceId WITHOUT screenshotId. Image and accessibility reads are sequential, not atomic; centers do not guarantee visibility or tappability. Accessibility failure preserves images with elements:null and elementsError. ' + imageDescription,
    inputSchema: imageInputSchema('capture'),
  },
  responseType: 'mcp',
  async execute(client, args, settings): Promise<CallToolResult> {
    const { path, configuration } = parseImageArguments('capture', args);
    const result = await captureScreenshot(client, settings, path, configuration);
    try {
      result.structuredContent = { ...result.structuredContent, elements: parseElements(await client.describeUI()) };
    } catch (error) {
      result.structuredContent = { ...result.structuredContent, elements: null,
        elementsError: `Accessibility data unavailable: ${(error as Error).message}. Use the image or retry capture.` };
    }
    return result;
  },
}];
