import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyWorkspace } from '@orquestra/shared';
import { describe, expect, it } from 'vitest';
import { loadWorkspace, saveWorkspace, workspacePath } from '../src/workspace-file.js';

const project = () => mkdtempSync(join(tmpdir(), 'orq-ws-'));

describe('arquivo do workspace', () => {
  it('projeto sem arquivo abre vazio, sem backup', () => {
    expect(loadWorkspace(project())).toEqual({ workspace: emptyWorkspace(), backup: null, problem: null });
  });

  it('grava e lê de volta, com .gitignore próprio e sem sobra do arquivo temporário', () => {
    const dir = project();
    const workspace = { ...emptyWorkspace(), viewport: { x: 10, y: 20, zoom: 0.5 } };
    saveWorkspace(dir, workspace);
    expect(loadWorkspace(dir).workspace).toEqual(workspace);
    expect(readFileSync(join(dir, '.orquestra', '.gitignore'), 'utf8')).toBe('*\n');
    expect(readdirSync(join(dir, '.orquestra')).sort()).toEqual(['.gitignore', 'workspace.json']);
  });

  it('não sobrescreve um .gitignore que já existe', () => {
    const dir = project();
    mkdirSync(join(dir, '.orquestra'));
    writeFileSync(join(dir, '.orquestra', '.gitignore'), 'meu\n');
    saveWorkspace(dir, emptyWorkspace());
    expect(readFileSync(join(dir, '.orquestra', '.gitignore'), 'utf8')).toBe('meu\n');
  });

  it('arquivo inválido vira backup e o projeto abre vazio', () => {
    const dir = project();
    mkdirSync(join(dir, '.orquestra'));
    writeFileSync(workspacePath(dir), '{ quebrado');
    const result = loadWorkspace(dir, new Date(2026, 9, 10, 8, 5, 3));
    expect(result.workspace).toEqual(emptyWorkspace());
    expect(result.backup).toBe(join(dir, '.orquestra', 'workspace.json.invalido-20261010-080503'));
    expect(result.problem).toMatch(/JSON/);
    expect(readFileSync(result.backup!, 'utf8')).toBe('{ quebrado');
    expect(existsSync(workspacePath(dir))).toBe(false);
  });

  it('arquivo com conteúdo fora do schema também vira backup, com a mensagem da validação', () => {
    const dir = project();
    mkdirSync(join(dir, '.orquestra'));
    writeFileSync(workspacePath(dir), JSON.stringify({ ...emptyWorkspace(), connections: [{ a: 'x', b: 'y' }] }));
    const result = loadWorkspace(dir);
    expect(result.backup).not.toBeNull();
    expect(result.problem).toMatch(/conexão com nó inexistente: x/);
  });

  it('carrega workspace.json antigo com flow e grupo misto sem backup e não regrava esses dados ao salvar', () => {
    const dir = project();
    mkdirSync(join(dir, '.orquestra'));
    const terminalId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const flowNodeId = crypto.randomUUID();
    const legacyWorkspace = {
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      terminals: [{
        id: terminalId,
        name: 'dev',
        agent: 'shell',
        cwd: dir,
        args: [],
        resume: false,
        regente: false,
        persona: null,
        monitor: false,
        agentSessionId: null,
        position: { x: 80, y: 80 },
        size: { width: 640, height: 400 },
      }],
      notes: [{
        id: noteId,
        name: 'anotacao',
        content: 'ok',
        revision: 1,
        updatedBy: 'você',
        position: { x: 760, y: 80 },
        size: { width: 320, height: 240 },
      }],
      connections: [{ a: 'dev', b: 'anotacao' }],
      personas: [],
      groups: [{
        id: crypto.randomUUID(),
        title: 'Misto legado',
        color: '#7aa7ff',
        kind: 'mixed',
        position: { x: 56, y: 8 },
        size: { width: 1048, height: 496 },
        members: [
          { kind: 'terminal', id: terminalId },
          { kind: 'flow', id: flowNodeId },
        ],
        locked: false,
        order: 0,
      }],
      flow: {
        nodes: [{
          id: flowNodeId,
          title: 'Entrada',
          kind: 'input',
          position: { x: 80, y: 520 },
          size: { width: 280, height: 220 },
          inputs: [],
          outputs: [{ name: 'valor', label: 'valor', type: 'number', required: true, maxBytes: 65536, unit: '', schema: null, defaultValue: 1 }],
          config: { value: 1 },
        }],
        connections: [],
        autoRun: false,
      },
      portals: [],
    };
    writeFileSync(workspacePath(dir), JSON.stringify(legacyWorkspace, null, 2));

    const loaded = loadWorkspace(dir);
    expect(loaded.backup).toBeNull();
    expect(loaded.problem).toBeNull();
    expect(loaded.workspace.groups?.[0]?.members).toEqual([{ kind: 'terminal', id: terminalId }]);
    expect(loaded.workspace.groups?.[0]?.kind).toBe('agents');

    saveWorkspace(dir, loaded.workspace);
    const savedRaw = JSON.parse(readFileSync(workspacePath(dir), 'utf8')) as Record<string, unknown>;
    expect('flow' in savedRaw).toBe(false);
    expect((savedRaw.groups as Array<{ members: unknown[] }>)[0]?.members).toEqual([{ kind: 'terminal', id: terminalId }]);
  });
});
