import type { HostMethod, HostParams, HostResult } from '@orquestra/shared';
import type { HostGate } from '../host-gate';

type RequestClient = {
  request<M extends HostMethod>(method: M, params: HostParams<M>, workspaceId?: string): Promise<HostResult<M>>;
};

export function createPortalLifecycle<T extends RequestClient>(
  gate: HostGate<T>,
  hasPortal: (workspaceId: string, id: string) => boolean,
) {
  return {
    async register(workspaceId: string, id: string): Promise<void> {
      const activeHost = await gate.requireReady();
      if (!hasPortal(workspaceId, id)) return;
      await activeHost.request('portal.register', { id, title: 'Navegador' }, workspaceId);
      if (!hasPortal(workspaceId, id)) {
        await activeHost.request('portal.unregister', { id }, workspaceId).catch(() => {});
      }
    },
    async unregister(workspaceId: string, id: string): Promise<void> {
      const activeHost = gate.current();
      if (activeHost) await activeHost.request('portal.unregister', { id }, workspaceId);
    },
  };
}
