import { screenshotTools } from '../operation/screenshot.js';
import { createOperationChain } from '../operation/operation-chain.js';
import { settingsTools } from '../setting/setup.js';
import { deviceTools } from '../operation/device.js';
import { gesturesTools } from '../operation/gestures.js';
import { inputTools } from '../operation/input.js';
import { appsTools } from '../operation/apps.js';
import { inspectionTools } from '../operation/inspection.js';
import { locationTools } from '../operation/location.js';
import type { ToolDefinition } from './tool-definition.js';

export const tools: ToolDefinition[] = [
  ...deviceTools,
  ...gesturesTools,
  ...inputTools,
  ...appsTools,
  ...screenshotTools,
  ...inspectionTools,
  ...locationTools,
  ...settingsTools,
];

tools.push(createOperationChain(tools));
