import type { ErrorCode, HostMethod, HostParams, HostResult } from '@orquestra/shared';
import type { CommandResponse } from '../../shared/bridge';
import { activeWorkspaceId, workspaceGeneration } from './workspace-context';

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export type CommandApi = {
  command<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>;
};

export function createCommandApi(invoke: (method: string, params: unknown, workspaceId?: string) => Promise<CommandResponse>, workspace: () => string | undefined = activeWorkspaceId): CommandApi {
  return {
    async command(method, params) {
      const id = workspace();
      const generation = workspaceGeneration();
      const scoped = /^(terminal\.|note\.|edge\.|layout\.|prompt\.|files\.|persona\.|group\.|flow\.|portal\.)/.test(method);
      const response = id ? await invoke(method, params, id) : await invoke(method, params);
      if (!response.ok) throw new CommandError(response.error.code, response.error.message);
      if (scoped && (id !== activeWorkspaceId() || generation !== workspaceGeneration())) throw new CommandError('APP_UNAVAILABLE', 'A operação foi concluída no workspace de origem.');
      // O principal já validou com o schema do contrato (HostProcess.request).
      return response.result as never;
    },
  };
}
