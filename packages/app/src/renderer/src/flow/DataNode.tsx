import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useMemo, useState } from 'react';
import { FLOW_LABELS } from '@orquestra/shared/flow';
import type { DataFlowNode } from '../canvas/flow-nodes';
import { createCommandApi } from '../api';
import { appStore, useApp } from '../store';
import { activeWorkspaceId } from '../workspace-context';
import { FlowPorts } from './FlowPorts';
import { useFlowUI } from './ui-context';

const STATUS: Record<string, string> = { queued: 'na fila', running: 'executando', success: 'concluído', cached: 'cache', error: 'erro', cancelled: 'cancelado', skipped: 'bloqueado', stale: 'desatualizado', idle: 'pronto' };
export function DataNode({ data, selected }: NodeProps<DataFlowNode>) {
  const flow = useApp((state) => state.flow);
  const node = flow.graph.nodes.find((node) => node.id === data.flowId);
  const ui = useFlowUI();
  const api = useMemo(() => { const workspaceId = activeWorkspaceId(); return createCommandApi(window.orquestra.invoke, () => workspaceId); }, []);
  const [pending, setPending] = useState(false);
  if (!node) return null;
  const result = flow.run?.results[node.id];
  const status = flow.run?.stale && result ? 'stale' : result?.status ?? 'idle';
  const run = async () => { setPending(true); try { appStore.getState().applyFlow(await api.command('flow.run', { targets: [node.id], force: false })); } catch (error) { appStore.getState().notify('error', (error as Error).message); } finally { setPending(false); } };
  return <div className={`data-node ${selected ? 'is-selected' : ''}`} data-testid={`flow-node-${node.title}`}>
    <NodeResizer isVisible={selected} minWidth={240} minHeight={130 + Math.max(node.inputs.length, node.outputs.length) * 26} onResizeEnd={(_event, rect) => void api.command('flow.move', { nodes: [{ id: node.id, position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }] }).catch((error) => appStore.getState().notify('error', (error as Error).message))} />
    <header className="data-node-header" onDoubleClick={() => ui.edit(node.id)}><strong>{node.title}</strong><small>{FLOW_LABELS[node.kind]}</small><button className="nodrag nopan" data-testid={`flow-edit-${node.title}`} title="Editar nó e contratos" onClick={() => ui.edit(node.id)}>⋯</button></header>
    <FlowPorts node={node} canvasId={`flow:${node.id}`} />
    <div className="data-node-content nodrag nopan nowheel">
      {node.kind === 'input' ? <button className="data-input-value" title="Editar valor de entrada" onClick={() => ui.edit(node.id)}>{JSON.stringify(node.config.value).slice(0, 100)}</button> : null}
      {node.kind === 'code' ? <small>{node.config.language === 'python' ? 'Python 3' : 'JavaScript'} · {node.config.deterministic ? 'cache habilitado' : 'sempre recalcular'}</small> : null}
      {node.kind === 'file' ? <small>{node.config.filePath || 'Escolha um arquivo do projeto'}</small> : null}
      {node.kind === 'view' ? <button disabled={!result?.outputs[node.outputs[0]?.name ?? '']} onClick={() => ui.inspect({ nodeId: node.id, port: node.outputs[0]!.name, direction: 'output' })}>{node.config.view === '3d' ? 'Abrir prévia 3D' : node.config.view === 'chart' ? 'Abrir gráfico' : 'Inspecionar dados'}</button> : null}
      {node.kind === 'output' ? <small>{node.config.exportPath}</small> : null}
      {result?.message ? <p className={status === 'error' ? 'usage-error' : 'muted'} title={result.message}>{result.message.slice(0, 180)}</p> : null}
      {result?.outputs[node.outputs[0]?.name ?? ''] && node.kind !== 'view' ? <button className="data-result-preview" onClick={() => ui.inspect({ nodeId: node.id, port: node.outputs[0]!.name, direction: 'output' })}>{result.outputs[node.outputs[0]!.name]!.preview.slice(0, 120)}</button> : null}
    </div>
    <footer className="data-node-footer nodrag nopan"><span className={`flow-status flow-${status}`}>{STATUS[status]}{result?.durationMs ? ` · ${Math.round(result.durationMs)} ms` : ''}</span><button disabled={pending || flow.run?.status === 'running'} data-testid={`flow-run-${node.title}`} onClick={() => void run()}>▶</button>{node.kind === 'code' ? <button title="Executar casos de teste" onClick={() => ui.tests(node.id)}>Testar</button> : null}</footer>
  </div>;
}
