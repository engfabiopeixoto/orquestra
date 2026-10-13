// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError, type CommandApi } from '../src/renderer/src/api';
import { NoteBody } from '../src/renderer/src/notes/NoteNode';
import { suggestNoteName } from '../src/renderer/src/notes/suggest-name';
import { appStore } from '../src/renderer/src/store';

// Antes dos imports: NoteNode cria a ponte de comandos com window.orquestra ao carregar.
vi.hoisted(() => Object.assign(window, { orquestra: { invoke: async () => ({ ok: true, result: {} }), reportError: () => {} } }));

const snapshot = {
  dir: 'C:/p', name: 'p', terminals: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  notes: [{ name: 'plano', content: '# Título\n\n- [x] feito', revision: 1, updatedBy: 'A' }],
  layout: {},
};

function fakeApi(handler: (method: string, params: unknown) => unknown) {
  const calls: Array<[string, unknown]> = [];
  const api = {
    command: (async (method: string, params: unknown) => {
      calls.push([method, params]);
      return handler(method, params);
    }) as CommandApi['command'],
  };
  return { api, calls };
}

beforeEach(() => appStore.getState().loadProject(snapshot));
afterEach(cleanup);

describe('NoteBody', () => {
  it('mostra o Markdown renderizado com GFM', () => {
    const { api } = fakeApi(() => ({}));
    render(<NoteBody name="plano" api={api} />);
    expect(screen.getByRole('heading', { name: 'Título' })).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('duplo clique edita; Ctrl+S salva com a revisão em que a edição começou', async () => {
    const { api, calls } = fakeApi(() => ({ name: 'plano', content: 'novo', revision: 2, updatedBy: 'você' }));
    render(<NoteBody name="plano" api={api} />);
    fireEvent.doubleClick(screen.getByTestId('note-view-plano'));
    const editor = screen.getByTestId('note-editor-plano');
    fireEvent.change(editor, { target: { value: 'novo' } });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() => expect(appStore.getState().notes.plano?.revision).toBe(2));
    expect(calls).toEqual([['note.save', { name: 'plano', content: 'novo', baseRevision: 1 }]]);
  });

  it('conflito mostra quem alterou com Recarregar e Sobrescrever', async () => {
    let conflict = true;
    const { api, calls } = fakeApi(() => {
      if (conflict) throw new CommandError('CONFLICT', 'A nota plano foi alterada por B (revisão 2). Recarregue para ver a versão nova ou sobrescreva.');
      return { name: 'plano', content: 'meu texto', revision: 3, updatedBy: 'você' };
    });
    render(<NoteBody name="plano" api={api} />);
    fireEvent.doubleClick(screen.getByTestId('note-view-plano'));
    fireEvent.change(screen.getByTestId('note-editor-plano'), { target: { value: 'meu texto' } });
    fireEvent.blur(screen.getByTestId('note-editor-plano'));
    await screen.findByText(/alterada por B/);
    conflict = false;
    fireEvent.click(screen.getByRole('button', { name: 'Sobrescrever' }));
    await waitFor(() => expect(appStore.getState().notes.plano?.content).toBe('meu texto'));
    expect(calls.at(-1)).toEqual(['note.save', { name: 'plano', content: 'meu texto', baseRevision: null }]);
  });

  it('Recarregar descarta o texto digitado e limpa o conflito', async () => {
    const { api } = fakeApi(() => {
      throw new CommandError('CONFLICT', 'A nota plano foi alterada por B (revisão 2).');
    });
    render(<NoteBody name="plano" api={api} />);
    fireEvent.doubleClick(screen.getByTestId('note-view-plano'));
    fireEvent.change(screen.getByTestId('note-editor-plano'), { target: { value: 'descartar' } });
    fireEvent.blur(screen.getByTestId('note-editor-plano'));
    await screen.findByText(/alterada por B/);
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(appStore.getState().notes.plano?.conflict).toBeNull();
    expect(screen.queryByTestId('note-editor-plano')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Título' })).toBeTruthy();
  });

  it('Esc cancela a edição sem salvar', () => {
    const { api, calls } = fakeApi(() => ({}));
    render(<NoteBody name="plano" api={api} />);
    fireEvent.doubleClick(screen.getByTestId('note-view-plano'));
    fireEvent.keyDown(screen.getByTestId('note-editor-plano'), { key: 'Escape' });
    expect(screen.queryByTestId('note-editor-plano')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('suggestNoteName', () => {
  it('sugere o primeiro nota-N livre', () => {
    expect(suggestNoteName([])).toBe('nota-1');
    expect(suggestNoteName(['nota-1', 'nota-3'])).toBe('nota-2');
  });
});
