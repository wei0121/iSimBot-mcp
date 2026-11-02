export class ToolError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown>) {
    super(message);
  }
}

export function errorResult(error: unknown) {
  return { success: false, error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ToolError ? error.details : {}) };
}
