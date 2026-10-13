import { expect, test } from '@playwright/test';
import { createShell, launchApp, screenOf } from './launch';

// Programa que mostra cada leitura do stdin: vê o que o terminal entrega ao agente, sem o PowerShell no meio
// (o PSReadLine trata Ctrl+V sozinho e esconderia o defeito).
const ECHO_BYTES = `node -e "process.stdin.setRawMode(true);process.stdin.on('data',d=>console.log('RX'+JSON.stringify(d.toString())))"`;

const received = (screen: string) =>
  screen
    .split(String.fromCharCode(10))
    // A linha pode começar com códigos de cor do retrato: procura a marca em qualquer posição.
    .filter((line) => line.includes('RX"'));

test('colar entrega o texto uma vez ao agente, por Ctrl+V, Ctrl+Shift+V e clique direito', async () => {
  const { app, page } = await launchApp();
  await createShell(page, 'S1');
  const body = page.getByTestId('terminal-body-S1');
  await body.click();
  await page.keyboard.type(ECHO_BYTES);
  await page.keyboard.press('Enter');
  // O retrato traz as cores do PSReadLine no meio do comando: espera o node subir em vez de procurar o texto.
  await page.waitForTimeout(2500);

  for (const [label, paste] of [
    ['ctrlv', () => page.keyboard.press('Control+V')],
    ['ctrlshiftv', () => page.keyboard.press('Control+Shift+V')],
    ['direito', () => body.click({ button: 'right' })],
  ] as const) {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `${label}-ok`);
    await body.click();
    await paste();
    await expect.poll(async () => received(await screenOf(page, 'S1')).filter((line) => line.includes(`${label}-ok`)).length).toBe(1);
    await page.waitForTimeout(500);
    expect(received(await screenOf(page, 'S1')).filter((line) => line.includes(`${label}-ok`))).toHaveLength(1);
  }
  expect(received(await screenOf(page, 'S1')).filter((line) => line.includes('\\u0016'))).toEqual([]);
  await app.close();
});
