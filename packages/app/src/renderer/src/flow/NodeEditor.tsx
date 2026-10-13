import { useState } from 'react';
import { FLOW_LABELS, flowNodeSchema, flowPortSchema, type FlowNode, type FlowPort } from '@orquestra/shared/flow';
import type { CommandApi } from '../api';
import { appStore } from '../store';

export function NodeEditor({ node, api, onClose }: { node: FlowNode; api: CommandApi; onClose(): void }) {
  const [draft, setDraft] = useState<FlowNode>(() => structuredClone(node));
  const [json, setJson] = useState({ value: JSON.stringify(node.config.value, null, 2), expected: JSON.stringify(node.config.expected, null, 2), tests: JSON.stringify(node.config.tests, null, 2) });
  const [schemas, setSchemas] = useState(() => ({ inputs: node.inputs.map((port) => JSON.stringify(port.schema)), outputs: node.outputs.map((port) => JSON.stringify(port.schema)) }));
  const [defaults, setDefaults] = useState(() => node.inputs.map((port) => JSON.stringify(port.defaultValue)));
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  const config = <K extends keyof FlowNode['config']>(key: K, value: FlowNode['config'][K]) => setDraft((before) => ({ ...before, config: { ...before.config, [key]: value } }));
  const port = (side: 'inputs' | 'outputs', index: number, change: Partial<FlowPort>) => setDraft((before) => ({ ...before, [side]: before[side].map((item, i) => i === index ? { ...item, ...change } : item) }));
  const add = (side: 'inputs' | 'outputs') => {
    const name = `${side === 'inputs' ? 'entrada' : 'saida'}_${draft[side].length + 1}`;
    setDraft((before) => ({ ...before, [side]: [...before[side], flowPortSchema.parse({ name })] }));
    setSchemas((before) => ({ ...before, [side]: [...before[side], 'null'] })); if (side === 'inputs') setDefaults((before) => [...before, 'null']);
  };
  const remove = (side: 'inputs' | 'outputs', index: number) => {
    setDraft((before) => ({ ...before, [side]: before[side].filter((_, i) => i !== index) }));
    setSchemas((before) => ({ ...before, [side]: before[side].filter((_, i) => i !== index) })); if (side === 'inputs') setDefaults((before) => before.filter((_, i) => i !== index));
  };
  const save = async () => {
    setPending(true); setError('');
    try {
      const parsed = flowNodeSchema.parse({ ...draft, inputs: draft.inputs.map((port, i) => ({ ...port, schema: JSON.parse(schemas.inputs[i] || 'null'), defaultValue: JSON.parse(defaults[i] || 'null') })), outputs: draft.outputs.map((port, i) => ({ ...port, schema: JSON.parse(schemas.outputs[i] || 'null') })), config: { ...draft.config, value: JSON.parse(json.value), expected: JSON.parse(json.expected), tests: JSON.parse(json.tests) } });
      appStore.getState().applyFlow(await api.command('flow.save', { node: parsed })); onClose();
    } catch (error) { setError((error as Error).message); } finally { setPending(false); }
  };
  return <div className="dialog-backdrop" role="dialog" aria-label="Editar nó de fluxo"><form className="dialog flow-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h2>{FLOW_LABELS[draft.kind]} · Entradas e saídas</h2>
    <label>Título<input value={draft.title} maxLength={120} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
    <div className="flow-contracts">{(['inputs', 'outputs'] as const).map((side) => <section key={side}><h3>{side === 'inputs' ? 'Entradas · esquerda' : 'Saídas · direita'}</h3>
      {draft[side].map((item, index) => <fieldset key={index}><div className="flow-port-fields"><label>Nome<input aria-label={`${side} nome ${index + 1}`} value={item.name} onChange={(event) => port(side, index, { name: event.target.value })} /></label><label>Tipo<select value={item.type} onChange={(event) => port(side, index, { type: event.target.value as FlowPort['type'] })}>{['any', 'number', 'string', 'boolean', 'json', 'geometry', 'file'].map((type) => <option key={type}>{type}</option>)}</select></label></div>
        <div className="flow-port-fields"><label>Limite em bytes<input type="number" min={1} max={4194304} value={item.maxBytes} onChange={(event) => port(side, index, { maxBytes: Number(event.target.value) })} /></label><label>Unidade<input value={item.unit} maxLength={24} onChange={(event) => port(side, index, { unit: event.target.value })} /></label></div>
        <label className="checkbox-label"><input type="checkbox" checked={item.required} onChange={(event) => port(side, index, { required: event.target.checked })} />Obrigatória</label>
        {side === 'inputs' ? <label>Valor padrão (JSON)<textarea rows={2} value={defaults[index]} onChange={(event) => setDefaults((before) => before.map((value, i) => i === index ? event.target.value : value))} /></label> : null}
        <details><summary>Validação JSON Schema</summary><textarea rows={4} value={schemas[side][index]} onChange={(event) => setSchemas((before) => ({ ...before, [side]: before[side].map((value, i) => i === index ? event.target.value : value) }))} /></details><button type="button" onClick={() => remove(side, index)}>Remover porta</button>
      </fieldset>)}<button type="button" disabled={draft[side].length >= 16 || side === 'inputs' && (['input', 'file'].includes(draft.kind) || !['code', 'agent'].includes(draft.kind) && draft.inputs.length >= 1)} onClick={() => add(side)}>+ Porta</button></section>)}</div>
    {draft.kind === 'input' ? <label>Valor (JSON)<textarea data-testid="flow-input-value" rows={5} value={json.value} onChange={(event) => setJson({ ...json, value: event.target.value })} /></label> : null}
    {draft.kind === 'code' ? <><label>Linguagem<select value={draft.config.language} onChange={(event) => config('language', event.target.value as 'python' | 'javascript')}><option value="python">Python 3</option><option value="javascript">JavaScript</option></select></label><p className="muted">Use run(IN) retornando um objeto com os nomes das saídas, ou atribua OUT. IN contém as entradas nomeadas.</p><label>Código<textarea className="flow-code" data-testid="flow-code" rows={12} value={draft.config.code} onChange={(event) => config('code', event.target.value)} spellCheck={false} /></label><label>Script do projeto (opcional, substitui o código)<input value={draft.config.scriptPath} onChange={(event) => config('scriptPath', event.target.value)} /></label>{draft.config.language === 'python' ? <label>Executável Python 3<input value={draft.config.pythonExecutable} onChange={(event) => config('pythonExecutable', event.target.value)} /></label> : null}<label>Dependências do projeto (uma por linha)<textarea rows={2} value={draft.config.dependencies.join('\n')} onChange={(event) => config('dependencies', event.target.value.split('\n').filter(Boolean))} /></label><label className="checkbox-label"><input type="checkbox" checked={draft.config.deterministic} onChange={(event) => config('deterministic', event.target.checked)} />Resultado determinístico · reutilizar cache</label><label>Casos de teste (JSON)<textarea rows={6} value={json.tests} onChange={(event) => setJson({ ...json, tests: event.target.value })} /></label></> : null}
    {draft.kind === 'agent' ? <><label>Instruções da etapa<textarea rows={6} value={draft.config.instruction} onChange={(event) => config('instruction', event.target.value)} /></label><label>Arquivos permitidos no contexto (um por linha)<textarea rows={3} value={draft.config.allowedFiles.join('\n')} onChange={(event) => config('allowedFiles', event.target.value.split('\n').filter(Boolean))} /></label><p className="muted">Esta etapa envia apenas entradas e instruções declaradas e exige uma resposta JSON com as saídas. É executada por ação explícita.</p></> : null}
    {draft.kind === 'file' ? <><label>Arquivo relativo ao projeto<input value={draft.config.filePath} onChange={(event) => config('filePath', event.target.value)} /></label><label>Formato<select value={draft.config.fileFormat} onChange={(event) => { config('fileFormat', event.target.value as FlowNode['config']['fileFormat']); if (draft.outputs.length === 1) port('outputs', 0, { type: event.target.value === 'reference' ? 'file' : event.target.value === 'text' ? 'string' : 'json' }); }}>{['reference', 'json', 'text', 'csv'].map((format) => <option key={format}>{format}</option>)}</select></label></> : null}
    {draft.kind === 'validate' ? <div className="flow-port-fields">{(['minimum', 'maximum'] as const).map((key) => <label key={key}>{key === 'minimum' ? 'Mínimo' : 'Máximo'}<input type="number" value={draft.config[key] ?? ''} onChange={(event) => config(key, event.target.value === '' ? null : Number(event.target.value))} /></label>)}</div> : null}
    {draft.kind === 'test' ? <label>Resultado esperado (JSON)<textarea rows={5} value={json.expected} onChange={(event) => setJson({ ...json, expected: event.target.value })} /></label> : null}
    {draft.kind === 'view' ? <label>Visualização<select value={draft.config.view} onChange={(event) => config('view', event.target.value as FlowNode['config']['view'])}><option value="table">Tabela</option><option value="chart">Gráfico</option><option value="3d">3D</option></select></label> : null}
    {draft.kind === 'output' ? <label>Destino da exportação<input value={draft.config.exportPath} onChange={(event) => config('exportPath', event.target.value)} /></label> : null}
    {['code', 'agent'].includes(draft.kind) ? <label>Tempo máximo (ms)<input type="number" min={100} max={300000} value={draft.config.timeoutMs} onChange={(event) => config('timeoutMs', Number(event.target.value))} /></label> : null}
    {['code', 'test'].includes(draft.kind) ? <label>Tolerância numérica<input type="number" step="any" min={0} value={draft.config.tolerance} onChange={(event) => config('tolerance', Number(event.target.value))} /></label> : null}
    {error ? <p role="alert" className="dialog-error">{error}</p> : null}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancelar</button><button className="primary" data-testid="flow-save" disabled={pending}>Salvar</button></div>
  </form></div>;
}
