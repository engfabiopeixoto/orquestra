import { describe, expect, it } from 'vitest';
import {
  ALL_PRESETS,
  DESKTOP_PRESETS,
  MOBILE_PRESETS,
  getDevicePreset,
  normalizePortalUrl,
  rotateDimensions,
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
