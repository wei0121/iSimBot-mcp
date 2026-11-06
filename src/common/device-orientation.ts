export const deviceOrientations = ['portrait', 'portrait_upside_down', 'landscape_left', 'landscape_right'] as const;
export type DeviceOrientation = typeof deviceOrientations[number];
export function validateOrientation(value: unknown): asserts value is DeviceOrientation {
  if (typeof value !== 'string' || !deviceOrientations.includes(value as DeviceOrientation)) {
    throw new Error(`orientation must be one of: ${deviceOrientations.join(', ')}.`);
  }
}
export function parseOrientation(stdout: string): string {
  const value = JSON.parse(stdout);
  if (!value || typeof value.orientation !== 'string' || !['UNKNOWN', 'PORTRAIT', 'PORTRAIT_UPSIDE_DOWN', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT', 'FACE_UP', 'FACE_DOWN'].includes(value.orientation)) throw new Error('Invalid device orientation readback.');
  return value.orientation.toLowerCase();
}
