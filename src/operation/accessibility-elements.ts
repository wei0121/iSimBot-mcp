type Node = Record<string, unknown>;
const object = (value: unknown): value is Node => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;

export function parseElements(raw: string) {
  let tree: unknown;
  try { tree = JSON.parse(raw); } catch { throw new Error('Invalid accessibility JSON from idb. Retry describe_ui to inspect the backend response.'); }
  if (!Array.isArray(tree) && !object(tree)) throw new Error('Unsupported accessibility tree: expected an array or element object.');
  const pending: unknown[] = Array.isArray(tree) ? [...tree].reverse() : [tree];
  const results: Node[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!object(node)) throw new Error('Unsupported accessibility tree: element must be an object.');
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error('Unsupported accessibility children: expected an array.');
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
    }
    const f = node.frame;
    const validFrame = object(f) && ['x', 'y', 'width', 'height'].every(k => typeof f[k] === 'number' && Number.isFinite(f[k])) && (f.width as number) > 0 && (f.height as number) > 0;
    const frame = validFrame ? { x: f.x as number, y: f.y as number, width: f.width as number, height: f.height as number } : null;
    results.push({ label: text(node.AXLabel), title: text(node.title), value: text(node.AXValue), identifier: text(node.AXUniqueId), role: text(node.role), type: text(node.type), enabled: typeof node.enabled === 'boolean' ? node.enabled : null,
      frame, center: frame ? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 } : null });
  }
  return results;
}
