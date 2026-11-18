// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import QRCode from 'qrcode';
import { afterEach, describe, expect, it } from 'vitest';
import { QrCode } from '../src/renderer/src/components/QrCode';

afterEach(cleanup);

function countDarkModules(value: string): { size: number; darkCount: number } {
  const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
  let darkCount = 0;
  for (let r = 0; r < modules.size; r++) {
    for (let c = 0; c < modules.size; c++) {
      if (modules.get(r, c)) darkCount++;
    }
  }
  return { size: modules.size, darkCount };
}

describe('QrCode', () => {
  it('renderiza um <svg> React com margem de 2 módulos e o número exato de módulos escuros de QRCode.create (sem <img src="data:...">)', () => {
    const url = 'https://desktop-rvg8ant.tail9938e7.ts.net:8443/?pair=tok999';
    const expected = countDarkModules(url);
    const total = expected.size + 4;

    const { container } = render(<QrCode value={url} testId="qr-test" />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('data:');

    const svg = screen.getByTestId('qr-test');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('QR code para parear o celular');
    expect(svg.getAttribute('width')).toBe('180');
    expect(svg.getAttribute('height')).toBe('180');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${total} ${total}`);

    const bg = svg.querySelector('rect');
    expect(bg?.getAttribute('fill')).toBe('#ffffff');
    expect(bg?.getAttribute('width')).toBe(String(total));
    expect(bg?.getAttribute('height')).toBe(String(total));

    const path = svg.querySelector('path');
    expect(path?.getAttribute('fill')).toBe('#000000');
    const d = path?.getAttribute('d') ?? '';
    const drawnModules = d.match(/M\d+\s+\d+h1v1h-1z/g) ?? [];
    expect(drawnModules).toHaveLength(expected.darkCount);
  });

  it('CSP do renderer (index.html) continua restritiva e sem data: em img-src', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(here, '../src/renderer/index.html'), 'utf8');
    const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
    expect(match).not.toBeNull();
    const csp = match![1]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/data:/i);
    expect(csp).not.toMatch(/img-src[^;]*data:/i);
  });
});
