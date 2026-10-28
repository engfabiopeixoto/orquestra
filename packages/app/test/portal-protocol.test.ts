import { describe, expect, it } from 'vitest';
import {
  ALL_PRESETS,
  DESKTOP_PRESETS,
  MOBILE_PRESETS,
  getDevicePreset,
  normalizePortalUrl,
  rotateDimensions,
  portalCanvasFrameBounds,
  PORTAL_IPC,
} from '../src/shared/portal-protocol';

describe('portal-protocol', () => {
  describe('normalizePortalUrl', () => {
    it('adiciona https:// em domínios comuns', () => {
      expect(normalizePortalUrl('example.com')).toBe('https://example.com');
      expect(normalizePortalUrl('example.com/portal')).toBe('https://example.com/portal');
    });

    it('adiciona http:// em localhost e endereços IP', () => {
      expect(normalizePortalUrl('localhost:3000')).toBe('http://localhost:3000');
      expect(normalizePortalUrl('localhost')).toBe('http://localhost');
      expect(normalizePortalUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
      expect(normalizePortalUrl('192.168.1.10')).toBe('http://192.168.1.10');
    });

    it('mantém URLs já completas', () => {
      expect(normalizePortalUrl('https://orquestra.dev')).toBe('https://orquestra.dev');
      expect(normalizePortalUrl('http://my-server.local')).toBe('http://my-server.local');
      expect(normalizePortalUrl('about:blank')).toBe('about:blank');
    });

    it('trata entradas vazias retornando about:blank', () => {
      expect(normalizePortalUrl('')).toBe('about:blank');
      expect(normalizePortalUrl('   ')).toBe('about:blank');
    });

    it('bloqueia file, javascript, data e protocolos customizados', () => {
      expect(normalizePortalUrl('file:///etc/passwd')).toBe('about:blank');
      expect(normalizePortalUrl('javascript:alert(1)')).toBe('about:blank');
      expect(normalizePortalUrl('data:text/html,<h1>hi</h1>')).toBe('about:blank');
      expect(normalizePortalUrl('custom://deep-link')).toBe('about:blank');
    });
  });

  describe('rotateDimensions', () => {
    it('ajusta dimensões para portrait', () => {
      const portrait = rotateDimensions(852, 393, 'portrait');
      expect(portrait.width).toBe(393);
      expect(portrait.height).toBe(852);
    });

    it('ajusta dimensões para landscape', () => {
      const landscape = rotateDimensions(393, 852, 'landscape');
      expect(landscape.width).toBe(852);
      expect(landscape.height).toBe(393);
    });
  });

  describe('moldura do canvas', () => {
    it('exclui as faixas ocupadas por controles superiores e inferiores', () => {
      const canvas = { x: 220, y: 32, width: 1180, height: 868 };
      const controls = [
        { x: 400, y: 44, width: 500, height: 40 },
        { x: 1210, y: 50, width: 170, height: 100 },
        { x: 230, y: 820, width: 500, height: 50 },
        { x: 1300, y: 830, width: 80, height: 40 },
      ];

      expect(portalCanvasFrameBounds(canvas, controls)).toEqual({ x: 220, y: 154, width: 1180, height: 662 });
    });

    it('mantém o canvas inteiro quando não há controles e nunca retorna tamanho negativo', () => {
      const canvas = { x: 220, y: 32, width: 1180, height: 868 };
      expect(portalCanvasFrameBounds(canvas, [])).toEqual(canvas);
      expect(portalCanvasFrameBounds(canvas, [{ x: 300, y: 35, width: 0, height: 100 }])).toEqual(canvas);
      expect(portalCanvasFrameBounds(canvas, [
        { x: 0, y: 500, width: 1400, height: 450 },
        { x: 0, y: 0, width: 1400, height: 500 },
      ])).toEqual({ x: 220, y: 504, width: 1180, height: 0 });
    });
  });

  describe('presets', () => {
    it('retorna preset existente pelo id', () => {
      const preset = getDevicePreset('iphone-15-pro');
      expect(preset.name).toContain('iPhone 15 Pro');
      expect(preset.isMobile).toBe(true);
      expect(preset.hasTouch).toBe(true);
      expect(preset.userAgent).toContain('iPhone');
    });

    it('retorna fallback quando id não existe', () => {
      const fallback = getDevicePreset('inexistente-123');
      expect(fallback).toBeDefined();
      expect(fallback.isMobile).toBe(true);
    });

    it('garante que todos os presets mobile possuem userAgent e hasTouch', () => {
      for (const p of MOBILE_PRESETS) {
        expect(p.hasTouch).toBe(true);
        expect(p.userAgent.length).toBeGreaterThan(0);
      }
    });
  });

  describe('PORTAL_IPC', () => {
    it('possui todos os canais IPC definidos', () => {
      expect(PORTAL_IPC.CREATE).toBe('orq:portal:create');
      expect(PORTAL_IPC.NAVIGATE).toBe('orq:portal:navigate');
      expect(PORTAL_IPC.SYNC_BOUNDS).toBe('orq:portal:sync-bounds');
      expect(PORTAL_IPC.DESTROY).toBe('orq:portal:destroy');
    });
  });
});
