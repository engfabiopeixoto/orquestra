import { describe, expect, it } from 'vitest';
import { appUserModelId } from '../src/main/app-id';

describe('appUserModelId', () => {
  it('o app instalado usa o id do instalador, o mesmo do appId do electron-builder', () => {
    expect(appUserModelId(true)).toBe('com.orquestra.app');
  });

  it('desenvolvimento e testes usam um id próprio, para o Windows não misturar ícone e agrupamento com o instalado', () => {
    expect(appUserModelId(false)).toBe('com.orquestra.app.dev');
    expect(appUserModelId(false)).not.toBe(appUserModelId(true));
  });
});
