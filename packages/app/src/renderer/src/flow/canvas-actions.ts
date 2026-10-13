import type { Connection } from '@xyflow/react';
import type { CommandApi } from '../api';
import { appStore } from '../store';
import { flowEndpoint } from './flow-edges';

/** True means the connection concerns data ports, including invalid combinations. */
export async function connectData(connection: Connection, api: CommandApi): Promise<boolean> {
  const data = /^(in|out):/.test(connection.sourceHandle ?? '') || /^(in|out):/.test(connection.targetHandle ?? '');
  if (!data) return false;
  const state = appStore.getState();
  try {
    const reverse = connection.sourceHandle?.startsWith('in:') && connection.targetHandle?.startsWith('out:');
    const source = reverse ? connection.target : connection.source, target = reverse ? connection.source : connection.target;
    const output = reverse ? connection.targetHandle : connection.sourceHandle, input = reverse ? connection.sourceHandle : connection.targetHandle;
    if (!output?.startsWith('out:') || !input?.startsWith('in:')) throw new Error('Conecte uma saída à direita a uma entrada à esquerda.');
    const from = flowEndpoint(state.flow.graph, state.terminals, source), to = flowEndpoint(state.flow.graph, state.terminals, target);
    if (!from || !to) throw new Error('Estas portas precisam pertencer a etapas do fluxo.');
    state.applyFlow(await api.command('flow.connect', { from, to, output: output.slice(4), input: input.slice(3) }));
  } catch (error) { state.notify('error', (error as Error).message); }
  return true;
}
