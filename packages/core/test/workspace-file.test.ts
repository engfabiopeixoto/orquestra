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
});
