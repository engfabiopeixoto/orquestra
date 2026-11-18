import type { TerminalInfo } from '@orquestra/shared/host-protocol';

export type TerminalStateKind = 'waiting' | 'busy' | 'background' | 'idle' | 'starting' | 'exited';

export function effectiveTerminalState(terminal: TerminalInfo): TerminalStateKind {
  if (terminal.unloaded || terminal.state === 'exited') return 'exited';
  if (terminal.state === 'waiting') return 'waiting';
  if (terminal.state === 'busy' || terminal.queued > 0) return 'busy';
  if (terminal.state === 'starting') return 'starting';
  if (terminal.state === 'background') return 'background';
  return 'idle';
}

const PRIORITY: Record<TerminalStateKind, number> = {
  waiting: 0,
  busy: 1,
  starting: 2,
  background: 3,
  idle: 4,
  exited: 5,
};

/** Mantém terminais "esperando você" sempre no topo da lista. */
export function sortTerminalsForMobile(terminals: TerminalInfo[]): TerminalInfo[] {
  return [...terminals].sort((a, b) => {
    const diff = PRIORITY[effectiveTerminalState(a)] - PRIORITY[effectiveTerminalState(b)];
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, 'pt-BR');
  });
}

export function terminalStateLabel(terminal: TerminalInfo): string {
  if (terminal.unloaded) return 'Descarregado';
  switch (terminal.state) {
    case 'waiting':
      return 'Esperando você';
    case 'busy':
      return 'Ocupado';
    case 'starting':
      return 'Iniciando';
    case 'idle':
      return 'Ocioso';
    case 'background':
      return 'Em segundo plano';
    case 'exited':
      return 'Encerrado';
  }
}

export function modelLabelOf(terminal: TerminalInfo): string | null {
  const model = terminal.model;
  if (!model) return null;
  return model.chosen ?? model.effective ?? null;
}
