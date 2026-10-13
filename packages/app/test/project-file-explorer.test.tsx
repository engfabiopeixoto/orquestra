// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandApi } from '../src/renderer/src/api';
import { ProjectFileExplorer } from '../src/renderer/src/components/ProjectFileExplorer';

afterEach(cleanup);
it('navega por pastas, mostra as cores e abre alterações de um arquivo', async () => {
  const command = vi.fn().mockImplementation(async (method: string, params: { path: string }) => {
    if (method === 'files.read') return { path: params.path, kind: 'text', content: 'novo', diff: '-antigo\n+novo' };
    return { comparison: 'git', truncated: false, entries: params.path ? [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', change: 'modified', additions: 1, deletions: 1 }] : [{ name: 'src', path: 'src', kind: 'directory', change: 'modified', additions: 0, deletions: 0 }, { name: 'new.txt', path: 'new.txt', kind: 'file', change: 'added', additions: 1, deletions: 0 }, { name: 'old.txt', path: 'old.txt', kind: 'file', change: 'removed', additions: 0, deletions: 1 }] };
  });
  render(<ProjectFileExplorer api={{ command } as unknown as CommandApi} projectDir="C:/project" />);
  expect((await screen.findByTestId('file-new.txt')).className).toContain('file-added');
  expect(screen.getByTestId('file-old.txt').className).toContain('file-removed');
  fireEvent.click(screen.getByTestId('file-src'));
  const file = await screen.findByTestId('file-src/app.ts');
  expect(file.className).toContain('file-modified');
  fireEvent.click(file);
  await screen.findByText('novo');
  fireEvent.click(screen.getByRole('button', { name: 'Alterações' }));
  expect(screen.getByText('+novo').parentElement?.className).toContain('code-added');
  expect(screen.getByText('-antigo').parentElement?.className).toContain('code-removed');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar arquivo' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
