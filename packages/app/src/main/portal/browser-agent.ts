import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { browserMethodSchemas, OrqError, type BrowserMethod } from '@orquestra/shared';

/** This function is serialized into the isolated page. Keep it self contained. */
function browserDocument(input: { method: string; selector?: string; text?: string; maxChars?: number; x?: number; y?: number }) {
  const selectorOf = (element: Element) => {
    if (element.id && element.id.length < 400) return `#${CSS.escape(element.id)}`;
    const parts: string[] = []; let current: Element | null = element;
    while (current && parts.length < 24) { const parent: Element | null = current.parentElement; parts.unshift(`${current.tagName.toLowerCase()}${parent ? `:nth-child(${Array.from(parent.children).indexOf(current) + 1})` : ''}`); current = parent; }
    return parts.join(' > ');
  };
  if (input.method === 'portal.check') {
    const elements = [];
    for (const element of document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')) {
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
      const field = element as HTMLInputElement;
      elements.push({ selector: selectorOf(element), tag: element.tagName.toLowerCase(), type: String(field.type || '').slice(0, 64), text: (element.getAttribute('aria-label') || field.labels?.[0]?.textContent || element.textContent || '').trim().slice(0, 160), placeholder: String(field.placeholder || '').slice(0, 160), disabled: Boolean(field.disabled) });
      if (elements.length >= 150) break;
    }
    return { url: location.href, title: document.title, text: (document.body?.innerText ?? '').slice(0, input.maxChars ?? 12000), elements };
  }
  if (input.method === 'portal.scroll') { window.scrollBy({ left: input.x ?? 0, top: input.y ?? 0, behavior: 'instant' }); return { ok: true }; }
  const matches = document.querySelectorAll(input.selector!);
  if (matches.length !== 1) throw new Error(matches.length ? 'O seletor identifica vários elementos. Use um seletor único.' : 'Elemento não encontrado na página. Consulte portal check novamente.');
  const element = matches[0] as HTMLElement;
  if (!element.getClientRects().length || (element as HTMLInputElement).disabled) throw new Error('O elemento está oculto ou desabilitado.');
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (input.method === 'portal.click') { element.click(); return { ok: true }; }
  if (input.method === 'portal.type') {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element instanceof HTMLInputElement && ['file', 'checkbox', 'radio', 'submit', 'button', 'hidden'].includes(element.type)) throw new Error('Este controle não recebe texto.');
      if (element instanceof HTMLInputElement && element.readOnly || element instanceof HTMLTextAreaElement && element.readOnly) throw new Error('Campo somente leitura.');
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, input.text ?? '');
    } else if (element.isContentEditable) element.textContent = input.text ?? '';
    else throw new Error('Selecione um campo editável.');
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  throw new Error('Operação não suportada.');
}

export async function executeBrowser(wc: WebContents, method: BrowserMethod, raw: unknown, captureDir: string, signal: AbortSignal): Promise<unknown> {
  const params = browserMethodSchemas[method].params.parse(raw);
  if (signal.aborted || wc.isDestroyed()) throw new OrqError('APP_UNAVAILABLE', 'Navegador encerrado ou operação cancelada.');
  if (method === 'portal.navigate') {
    const url = new URL(browserMethodSchemas['portal.navigate'].params.parse(raw).url);
    if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') throw new OrqError('USAGE', 'Use uma URL HTTP ou HTTPS.');
    await wc.loadURL(url.href); return { ok: true };
  }
  if (method === 'portal.screenshot') {
    const image = await wc.capturePage();
    if (signal.aborted) throw new OrqError('APP_UNAVAILABLE', 'Operação cancelada.');
    const size = image.getSize(), scale = Math.min(1, 1600 / Math.max(1, size.width), 1200 / Math.max(1, size.height));
    const png = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toPNG();
    if (png.length > 4 * 1024 * 1024) throw new OrqError('USAGE', 'Captura excede 4 MiB. Reduza o viewport.');
    await mkdir(captureDir, { recursive: true });
    const path = join(captureDir, `${Date.now()}-${randomUUID()}.png`); await writeFile(path, png);
    const files = (await readdir(captureDir)).filter((name) => /^\d+-[a-f0-9-]+\.png$/.test(name)).sort().reverse();
    await Promise.all(files.slice(3).map((name) => unlink(join(captureDir, name)).catch(() => {})));
    return { path, mimeType: 'image/png' };
  }
  return wc.executeJavaScript(`(${browserDocument.toString()})(${JSON.stringify({ method, ...params })})`);
}
