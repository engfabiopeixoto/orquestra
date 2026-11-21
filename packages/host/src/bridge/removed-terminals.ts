import type { Rect } from '../placement.js';
import type { OpenProject, RemovedTerminalTracker } from './context.js';

const REMOVED_TERMINAL_TTL_MS = 30 * 60_000;

/** Guarda posição e grupo de terminais removidos por 30 min para reutilização ao recriar pelo mesmo nome. */
export function createRemovedTerminalTracker(): RemovedTerminalTracker {
  const removed = new Map<string, { rect: Rect; groupId: string | null; expiresAt: number }>();

  return {
    remember(project: OpenProject | null, name: string): void {
      if (!project) return;
      const now = Date.now();
      for (const [key, entry] of removed) {
        if (entry.expiresAt <= now) removed.delete(key);
      }
      const rect = project.state.rectOf(name);
      if (!rect) return;
      const elementId = project.state.elementIdOf(name);
      const groupId = elementId
        ? project.state.grouping
            .list()
            .find((group) => group.members.some((member) => member.kind === 'terminal' && member.id === elementId))?.id ?? null
        : null;
      removed.set(name, { rect: { ...rect }, groupId, expiresAt: now + REMOVED_TERMINAL_TTL_MS });
    },

    peek(name: string): { rect: Rect; groupId: string | null } | null {
      const entry = removed.get(name);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        removed.delete(name);
        return null;
      }
      return { rect: entry.rect, groupId: entry.groupId };
    },

    forget(name: string): void {
      removed.delete(name);
    },

    clear(): void {
      removed.clear();
    },
  };
}
