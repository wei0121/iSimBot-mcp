import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const elementDetailSchema = {
  type: 'string', enum: ['number', 'list', 'changes'], default: 'changes',
};
export function resolveElementDetail(value: unknown): ElementDetail {
  if (value === undefined) return 'changes';
  if (typeof value !== 'string' || !elementDetailSchema.enum.includes(value)) throw new Error('elementDetail must be number, list or changes.');
  return value as ElementDetail;
}

export type ElementDetail = 'number' | 'list' | 'changes';
type Frame = { x: number; y: number; width: number; height: number };
type ChangeType = 'appeared' | 'moved' | 'disappeared' | 'updated';
interface Element {
  elementId: string | null;
  type: string | null;
  text: string | null;
  frame: Frame | null;
}
type Node = Record<string, unknown>;
const object = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null;
export function compactElement(node: Node): Element {
  const frame = node.frame;
  const valid = object(frame) && ['x', 'y', 'width', 'height'].every(k => typeof frame[k] === 'number' && Number.isFinite(frame[k]));
  const words = [...new Set([node.label, node.title, node.value].map(text).filter((s): s is string => s !== null))];
  return { elementId: text(node.identifier), type: text(node.type) ?? text(node.role),
    text: words.length ? words.join(' · ') : null,
    frame: valid ? { x: frame.x as number, y: frame.y as number, width: frame.width as number, height: frame.height as number } : null };
}
function sameFrame(a: Element, b: Element) {
  return a.frame === null || b.frame === null ? a.frame === b.frame
    : ['x', 'y', 'width', 'height'].every(k => a.frame![k as keyof Frame] === b.frame![k as keyof Frame]);
}
function contentKey(node: Node) {
  return JSON.stringify(['type', 'role', 'label', 'title', 'value', 'enabled'].map(k => node[k] ?? null));
}
function difference(current: Node[], previous: Node[]) {
  const now = current.map(compactElement), before = previous.map(compactElement);
  const counts = (items: Element[]) => {
    const result = new Map<string, number>();
    for (const item of items) if (item.elementId) result.set(item.elementId, (result.get(item.elementId) ?? 0) + 1);
    return result;
  };
  const currentCounts = counts(now), previousCounts = counts(before);
  const unique = new Map<string, number>();
  before.forEach((item, i) => { if (item.elementId && previousCounts.get(item.elementId) === 1 && currentCounts.get(item.elementId) === 1) unique.set(item.elementId, i); });
  const signature = (item: Element, raw: Node) => JSON.stringify([item, contentKey(raw)]);
  // Match exact snapshots first. For moved anonymous nodes require unique, nonempty
  // semantic content AND size across both complete snapshots, never proximity alone.
  const exact = new Map<string, number[]>();
  before.forEach((item, i) => {
    if (item.elementId && unique.has(item.elementId)) return;
    const key = signature(item, previous[i]);
    const entries = exact.get(key) ?? []; entries.push(i); exact.set(key, entries);
  });
  const mapping = new Map<number, number>();
  const matched = new Set<number>();
  now.forEach((item, i) => {
    const oldIndex = item.elementId && unique.has(item.elementId) ? unique.get(item.elementId)! : exact.get(signature(item, current[i]))?.shift();
    if (oldIndex !== undefined) { mapping.set(i, oldIndex); matched.add(oldIndex); }
  });
  const semanticKey = (item: Element, raw: Node) => item.text && item.frame ? JSON.stringify([item.elementId, contentKey(raw), item.frame.width, item.frame.height]) : null;
  const group = (items: Element[], raw: Node[]) => {
    const result = new Map<string, number[]>();
    items.forEach((item, i) => { const key = semanticKey(item, raw[i]); if (key) result.set(key, [...(result.get(key) ?? []), i]); });
    return result;
  };
  const oldGroups = group(before, previous), newGroups = group(now, current);
  for (const [key, indexes] of newGroups) {
    const old = oldGroups.get(key);
    if (indexes.length !== 1 || old?.length !== 1 || mapping.has(indexes[0]) || matched.has(old[0])) continue;
    mapping.set(indexes[0], old[0]); matched.add(old[0]);
  }
  const changes: Array<Element & { changeTypes: ChangeType[] }> = [];
  now.forEach((item, i) => {
    const oldIndex = mapping.get(i);
    if (oldIndex === undefined) { changes.push({ ...item, changeTypes: ['appeared'] }); return; }
    matched.add(oldIndex);
    const changeTypes: ChangeType[] = [];
    if (!sameFrame(item, before[oldIndex])) changeTypes.push('moved');
    if (contentKey(current[i]) !== contentKey(previous[oldIndex])) changeTypes.push('updated');
    if (changeTypes.length) changes.push({ ...item, changeTypes });
  });
  before.forEach((item, i) => { if (!matched.has(i)) changes.push({ ...item, changeTypes: ['disappeared'] }); });
  return changes;
}
function elements(metadata: CallToolResult['structuredContent']): Node[] | null {
  return Array.isArray(metadata?.elements) && metadata.elements.every(object) ? metadata.elements : null;
}
/** Presentation only: never mutate either saved snapshot. */
export function presentElements(raw: CallToolResult['structuredContent'], previous: CallToolResult['structuredContent'], detail: ElementDetail, hasPreviousCapture: boolean) {
  const { elements: _rawElements, elementsError, ...metadata } = raw ?? {};
  const current = elements(raw);
  if (detail === 'number') return { metadata, elementCount: current?.length ?? null, ...(elementsError ? { error: String(elementsError) } : {}) };
  if (detail === 'list') return { metadata, elements: current?.map(compactElement) ?? null, ...(elementsError ? { error: String(elementsError) } : {}) };
  if (!current) return { metadata, elements: null, error: elementsError ? String(elementsError) : 'Current capture accessibility elements are unavailable.' };
  if (!hasPreviousCapture) return { metadata, elements: current.map(node => ({ ...compactElement(node), changeTypes: ['appeared'] })) };
  const baseline = elements(previous);
  if (!baseline) return { metadata, elements: null, error: 'Previous capture accessibility elements are unavailable. Request elementDetail=list for the current snapshot.' };
  return { metadata, elements: difference(current, baseline) };
}

/** Public event identity is inherited from the top-level timeline. */
export function publicEvent<T extends { timeline?: unknown }>(record: T): Omit<T, 'timeline'> {
  const { timeline: _timeline, ...event } = record;
  return event;
}
