import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

test('aba Qualidade mede projeto com ciclo de import e destaca problema em Dependências', async () => {
  const project = mkdtempSync(join(tmpdir(), 'orq-quality-e2e-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), "import { b } from './b';\nexport const a = () => b;\n");
  writeFileSync(join(project, 'src', 'b.ts'), "import { a } from './a';\nexport const b = () => a;\n");

  const { app, page } = await launchApp({ project });
  try {
    const qualityTab = page.getByTestId('sidebar-tab-quality');
    await expect(qualityTab).toBeVisible({ timeout: 30_000 });
    await qualityTab.click();

    await page.getByTestId('quality-measure').click();
    const depsCard = page.getByTestId('quality-card-dependencies');
    await expect(depsCard).toContainText('PROBLEMA', { timeout: 30_000 });
    await expect(depsCard).toContainText('1');
  } finally {
    await app.close();
  }
});
