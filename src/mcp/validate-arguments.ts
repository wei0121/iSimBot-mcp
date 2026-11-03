import type { ToolDefinition } from './tool-definition.js';

// Existing chainable tools use flat primitive schemas. Validate the whole chain
// before starting, so a typo late in a chain cannot cause earlier side effects.
export function validateArguments(tool: ToolDefinition, args: Record<string, unknown>): void {
  const schema = tool.definition.inputSchema;
  for (const key of schema.required || []) {
    if (!(key in args)) throw new Error(`${tool.definition.name}: missing argument ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties?.[key] as Record<string, unknown> | undefined;
    if (!rule) throw new Error(`${tool.definition.name}: unknown argument ${key}`);
    if (rule.type === 'integer' ? !Number.isInteger(value) : rule.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== rule.type) {
      throw new Error(`${tool.definition.name}: invalid argument ${key}`);
    }
    if (typeof value === 'number' && ((typeof rule.minimum === 'number' && value < rule.minimum) || (typeof rule.maximum === 'number' && value > rule.maximum))) throw new Error(`${tool.definition.name}: ${key} must be between ${rule.minimum} and ${rule.maximum}; received ${value}.`);
    if (typeof value === 'string' && (value.includes('\0') || (key !== 'text' && !value.trim()))) throw new Error(`${tool.definition.name}: invalid argument ${key}`);
    if (['udid', 'bundleId'].includes(key) && typeof value === 'string' && value.startsWith('-')) throw new Error(`${tool.definition.name}: invalid argument ${key}`);
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) throw new Error(`${tool.definition.name}: invalid ${key}`);
  }
}

