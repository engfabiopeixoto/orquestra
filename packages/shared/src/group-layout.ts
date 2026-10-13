import type { CanvasGroup, GroupMember, Position, Size } from './workspace.js';

export const GROUP_HEADER = 48;
export const GROUP_PADDING = 24;
export const GROUP_MIN = { width: 320, height: 200 };
export type GroupRect = Position & Size;
export type GroupElement = GroupMember & { name: string; rect: GroupRect; locked: boolean };
export const groupNodeId = (id: string) => `__orq_group_${id}`;
export const memberKey = (member: GroupMember) => `${member.kind}:${member.id}`;
export function inferredGroupKind(members: GroupMember[], fallback: CanvasGroup['kind']): CanvasGroup['kind'] {
  if (!members.length) return fallback;
  if (members.some((member) => member.kind === 'flow')) return 'mixed';
  const terminals = members.some((member) => member.kind === 'terminal');
  const notes = members.some((member) => member.kind === 'note');
  return terminals && notes ? 'mixed' : terminals ? 'agents' : 'notes';
}
export function fitGroupRects(rects: GroupRect[], fallback: GroupRect): GroupRect {
  if (!rects.length) return fallback;
  const x = Math.min(...rects.map((rect) => rect.x)) - GROUP_PADDING;
  const y = Math.min(...rects.map((rect) => rect.y)) - GROUP_HEADER - GROUP_PADDING;
  return { x, y, width: Math.max(GROUP_MIN.width, Math.max(...rects.map((rect) => rect.x + rect.width)) + GROUP_PADDING - x), height: Math.max(GROUP_MIN.height, Math.max(...rects.map((rect) => rect.y + rect.height)) + GROUP_PADDING - y) };
}
export function expandGroupRects(group: GroupRect, rects: GroupRect[]): GroupRect {
  if (!rects.length) return group;
  const fit = fitGroupRects(rects, group);
  const x = Math.min(group.x, fit.x), y = Math.min(group.y, fit.y);
  return { x, y, width: Math.max(group.x + group.width, fit.x + fit.width) - x, height: Math.max(group.y + group.height, fit.y + fit.height) - y };
}
export function groupContains(group: CanvasGroup, rect: GroupRect): boolean {
  return rect.x >= group.position.x + GROUP_PADDING && rect.y >= group.position.y + GROUP_HEADER + GROUP_PADDING && rect.x + rect.width <= group.position.x + group.size.width - GROUP_PADDING && rect.y + rect.height <= group.position.y + group.size.height - GROUP_PADDING;
}
export function groupDropTarget(groups: CanvasGroup[], rect: GroupRect): string | null {
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  return [...groups].sort((a, b) => b.order - a.order).find((group) => x >= group.position.x && x <= group.position.x + group.size.width && y >= group.position.y + GROUP_HEADER && y <= group.position.y + group.size.height)?.id ?? null;
}
