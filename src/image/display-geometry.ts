export interface DisplayGeometry { orientation: 1 | 2 | 3 | 4; width: number; height: number }
export function parseDisplayGeometry(stdout: string): DisplayGeometry {
  const value = JSON.parse(stdout);
  if (!value || ![1, 2, 3, 4].includes(value.orientation) || ![value.width, value.height].every(n => Number.isFinite(n) && n > 0 && n < 10000)) throw new Error('Invalid simulator display geometry.');
  return value;
}
export function imageRotation(orientation = 1): number { return ({ 1: 0, 2: 180, 3: 270, 4: 90 } as Record<number, number>)[orientation] ?? 0; }
export function parseHIDRotation(stdout: string): 0 | 90 | 180 | 270 {
  const displays = JSON.parse(stdout)?.result?.displays;
  if (!Array.isArray(displays)) throw new Error('Missing simulator display information.');
  const selected = displays.length === 1 ? displays[0] : displays.find(display => display.primary === true);
  const value = selected?.currentOrientation;
  if (!['rot0', 'rot90', 'rot180', 'rot270'].includes(value)) throw new Error('Unknown simulator HID display rotation.');
  return Number(value.slice(3)) as 0 | 90 | 180 | 270;
}
// App interface axes and Simulator display axes can differ even at rest (for
// example a portrait-locked app in a sideways Simulator window). idb consumes
// display-relative points, then performs its own display-to-framebuffer mapping.
export function hidPoint(x: number, y: number, display?: DisplayGeometry & { hidRotation?: number }): [number, number] {
  if (!display) return [x, y];
  if (![0, 90, 180, 270].includes(display.hidRotation!)) throw new Error('Missing confirmed HID display rotation.');
  const {orientation, width, height} = display;
  const screenWidth = orientation >= 3 ? height : width, screenHeight = orientation >= 3 ? width : height;
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= screenWidth || y >= screenHeight) throw new Error(`Point outside the current interface (${screenWidth}x${screenHeight}). Take a fresh capture.`);
  let fx = x, fy = y;
  if (orientation === 2) { fx = width - x; fy = height - y; }
  if (orientation === 3) { fx = width - y; fy = x; }
  if (orientation === 4) { fx = y; fy = height - x; }
  switch(display.hidRotation) {
    case 90: return [height - fy, fx];
    case 180: return [width - fx, height - fy];
    case 270: return [fy, width - fx];
    default: return [fx, fy];
  }
}
