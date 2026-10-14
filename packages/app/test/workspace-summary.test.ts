import type { WorkspaceInfo } from '@orquestra/shared/host-protocol';
import { describe, expect, it } from 'vitest';
import { workspaceDot, workspaceSummary } from '../src/renderer/src/workspaces';

const workspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({ id: 'w1', dir: 'C:\\proj\\alfa', name: 'alfa', status: 'open', terminalCount: 0, busy: 0, waiting: 0, ...overrides });

describe('workspaceSummary', () => {
  it('mostra "pausado" para workspace pausado, mesmo com terminais', () => {
    expect(workspaceSummary(workspace({ status: 'paused', terminalCount: 4 }))).toBe('pausado');
  });
  it('conta os agentes e acrescenta ativos e aguardando só quando existem', () => {
    expect(workspaceSummary(workspace({ terminalCount: 5 }))).toBe('5 agentes');
    expect(workspaceSummary(workspace({ terminalCount: 5, busy: 2 }))).toBe('5 agentes · 2 ativos');
    expect(workspaceSummary(workspace({ terminalCount: 5, waiting: 1 }))).toBe('5 agentes · 1 aguardando');
    expect(workspaceSummary(workspace({ terminalCount: 5, busy: 2, waiting: 1 }))).toBe('5 agentes · 2 ativos · 1 aguardando');
  });
});

describe('workspaceDot', () => {
  it('prioriza aguardando, depois ativo, depois o status', () => {
    expect(workspaceDot(workspace({ busy: 1, waiting: 1 }))).toBe('waiting');
    expect(workspaceDot(workspace({ busy: 1 }))).toBe('busy');
    expect(workspaceDot(workspace())).toBe('open');
    expect(workspaceDot(workspace({ status: 'paused' }))).toBe('paused');
  });
});
