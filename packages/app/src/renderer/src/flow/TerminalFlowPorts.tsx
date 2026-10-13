import { useApp } from '../store';
import { useContext } from 'react';
import { FlowPorts } from './FlowPorts';
import { FlowUIContext } from './ui-context';

export function TerminalFlowPorts({ name }: { name: string }) {
  const terminalId = useApp((state) => state.terminals[name]?.id);
  const node = useApp((state) => state.flow.graph.nodes.find((node) => node.kind === 'agent' && node.config.terminalId === terminalId));
  const ui = useContext(FlowUIContext);
  if (!node || !ui) return null;
  return <div className="terminal-flow-ports"><div className="terminal-flow-heading nodrag nopan"><small>Etapa de agente</small><button title="Definir entradas, saídas e instruções desta etapa" onClick={() => ui.edit(node.id)}>Configurar E/S</button></div><FlowPorts node={node} canvasId={name} /></div>;
}
