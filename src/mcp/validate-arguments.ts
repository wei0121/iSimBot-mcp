import type { ToolDefinition } from './tool-definition.js';

// Validate primitive/object shapes and tool-specific constraints for the whole chain
// before starting, so a typo late in a chain cannot cause earlier side effects.
export function validateArguments(tool: Pick<ToolDefinition, 'definition' | 'validate'>, args: Record<string, unknown>): void {
  const schema = tool.definition.inputSchema;
  for (const key of schema.required || []) {
    if (!(key in args)) throw new Error(`${tool.definition.name}: missing argument ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties?.[key] as Record<string, unknown> | undefined;
    if (!rule) throw new Error(`${tool.definition.name}: unknown argument ${key}`);
    if (rule.type === 'object' ? value === null || typeof value !== 'object' || Array.isArray(value) : rule.type === 'integer' ? !Number.isInteger(value) : rule.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== rule.type) {
      throw new Error(`${tool.definition.name}: invalid argument ${key}`);
    }
    if (typeof value === 'number' && ((typeof rule.minimum === 'number' && value < rule.minimum) || (typeof rule.maximum === 'number' && value > rule.maximum))) throw new Error(`${tool.definition.name}: ${key} must be between ${rule.minimum} and ${rule.maximum}; received ${value}.`);
    if (typeof value === 'string' && (value.includes('\0') || (key !== 'text' && !value.trim()))) throw new Error(`${tool.definition.name}: invalid argument ${key}`);
    if (['udid', 'bundleId'].includes(key) && typeof value === 'string' && value.startsWith('-')) throw new Error(`${tool.definition.name}: invalid argument ${key}`);
    if (rule.format === 'uri' && typeof value === 'string') {
      if (/[\s\x00-\x1f\x7f]/.test(value)) throw new Error(`${tool.definition.name}: ${key} must be an absolute URL; encode spaces and control characters.`);
      try { new URL(value); } catch { throw new Error(`${tool.definition.name}: ${key} must be an absolute URL with a scheme.`); }
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) throw new Error(`${tool.definition.name}: invalid ${key}`);
  }
  tool.validate?.(args);
}

