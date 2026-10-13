// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFlowNode } from '@orquestra/shared/flow';
import { AGENT_FLOW_IO } from '../src/renderer/src/flow/feature-flags';
import { NodeEditor } from '../src/renderer/src/flow/NodeEditor';
import { dataEdges, flowEndpoint } from '../src/renderer/src/flow/flow-edges';
import { createAppStore } from '../src/renderer/src/store';
import { appStore } from '../src/renderer/src/store';
import { connectData } from '../src/renderer/src/flow/canvas-actions';

afterEach(cleanup);
describe('editor de contratos', () => {
  it('normaliza arrasto reverso e rejeita misturar portas de dados com conversa', async () => {
    const source = defaultFlowNode('input', randomUUID()), target = defaultFlowNode('code', randomUUID()); const graph = { nodes: [source, target], connections: [], autoRun: false };
    appStore.setState({ flow: { graph, run: null, tests: null } });
    const command = vi.fn(async () => ({ graph, run: null, tests: null })); const api = { command } as any;
    expect(await connectData({ source: `flow:${target.id}`, target: `flow:${source.id}`, sourceHandle: 'in:valor', targetHandle: 'out:valor' }, api)).toBe(true);
    expect(command).toHaveBeenCalledWith('flow.connect', { from: source.id, to: target.id, output: 'valor', input: 'valor' });
    command.mockClear(); await connectData({ source: `flow:${source.id}`, target: 'nota', sourceHandle: 'out:valor', targetHandle: 'left' }, api); expect(command).not.toHaveBeenCalled();
    expect(await connectData({ source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' }, api)).toBe(false);
  });
  it('recusa JSON inválido e salva valor e contrato válidos juntos', async () => {
    const node = defaultFlowNode('input', randomUUID()); const command = vi.fn(async () => ({ graph: { nodes: [node], connections: [], autoRun: false }, run: null, tests: null })); const close = vi.fn();
    render(<NodeEditor node={node} api={{ command } as any} onClose={close} />);
    fireEvent.change(screen.getByTestId('flow-input-value'), { target: { value: '{bad' } }); fireEvent.click(screen.getByTestId('flow-save'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined()); expect(command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('flow-input-value'), { target: { value: '5' } }); fireEvent.click(screen.getByTestId('flow-save'));
    await waitFor(() => expect(close).toHaveBeenCalled()); expect(command).toHaveBeenCalledWith('flow.save', { node: expect.objectContaining({ config: expect.objectContaining({ value: 5 }), outputs: [expect.objectContaining({ name: 'valor', type: 'number' })] }) });
  });
  // Temporariamente ignorado enquanto AGENT_FLOW_IO estiver desativada (ver feature-flags.ts).
  it.skipIf(!AGENT_FLOW_IO)('conexões de dados usam nomes de porta fixos esquerda/direita e identidade do agente', () => {
    const store = createAppStore(), agent = defaultFlowNode('agent', randomUUID()), code = defaultFlowNode('code', randomUUID()); agent.config.terminalId = agent.id;
    store.getState().addTerminal({ id: agent.id, name: 'dev', agent: 'codex', state: 'idle', queued: 0, cwd: 'C:/p', resume: false, args: [], regente: false, monitor: false });
    const graph = { nodes: [agent, code], connections: [{ id: randomUUID(), from: code.id, output: 'saida', to: agent.id, input: 'entrada' }], autoRun: false };
    const edge = dataEdges(graph, store.getState().terminals)[0]!;
    expect(edge).toMatchObject({ source: `flow:${code.id}`, target: 'dev', sourceHandle: 'out:saida', targetHandle: 'in:entrada', data: { kind: 'flow' } });
    expect(flowEndpoint(graph, store.getState().terminals, 'dev')).toBe(agent.id); expect(flowEndpoint(graph, store.getState().terminals, `flow:${code.id}`)).toBe(code.id);
    expect(flowEndpoint(graph, store.getState().terminals, 'nota')).toBeNull();
  });
});
