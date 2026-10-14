// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorkspace } from '../src/renderer/src/project';
import { workspaceStore } from '../src/renderer/src/workspaces';

describe('closeWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    workspaceStore.setState({
      workspaces: [
        { id: 'w1', dir: 'C:\\proj\\um', name: 'um', status: 'open', terminalCount: 1, busy: 0, waiting: 0 },
        { id: 'w2', dir: 'C:\\proj\\dois', name: 'dois', status: 'open', terminalCount: 2, busy: 0, waiting: 0 },
      ],
      selectedId: 'w1',
      changing: false,
      focusRequest: null,
    });
  });

  it('usa singular no aviso de confirmação quando há 1 terminal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await closeWorkspace('w1');
    expect(confirm).toHaveBeenCalledWith('Fechar um salva o canvas e encerra seu 1 terminal. Continuar?');
  });

  it('usa plural no aviso de confirmação quando há múltiplos terminais', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await closeWorkspace('w2');
    expect(confirm).toHaveBeenCalledWith('Fechar dois salva o canvas e encerra seus 2 terminais. Continuar?');
  });
});
