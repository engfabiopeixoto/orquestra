import { describe, expect, it } from 'vitest';
import { FlowWorkerPool } from '../src/flow-workers.js';

describe('workers reutilizáveis', () => {
  it('reutiliza processo JS, isola escopos e respeita no máximo dois processos', async () => {
    const counts: number[] = [];
    const pool = new FlowWorkerPool({ onPids: (pids) => counts.push(pids.length) });
    const job = { language: 'javascript' as const, cwd: process.cwd(), inputs: { valor: 3 }, timeoutMs: 3000 };
    try {
      const first = await pool.execute({ ...job, code: 'globalThis.hidden=7; function run(IN) {return {saida:IN.valor*2}}' });
      expect(first.value).toEqual({ saida: 6 });
      const second = await pool.execute({ ...job, code: 'function run(IN) {return {saida:typeof hidden}}' }); expect(second.value).toEqual({ saida: 'undefined' });
      await expect(pool.execute({ ...job, code: 'OUT={saida:NaN}' })).rejects.toThrow(/não finito/);
      expect(Math.max(...counts)).toBe(1);
      await Promise.all(Array.from({ length: 4 }, () => pool.execute({ ...job, code: 'function run(IN) { const end=Date.now()+50; while(Date.now()<end){}; return {saida:IN.valor}; }' })));
      expect(Math.max(...counts)).toBeLessThanOrEqual(2);
    } finally { await pool.close(); }
    expect(counts.at(-1)).toBe(0);
  });
  it('timeout não bloqueia jobs seguintes e fechamento durante boot rejeita a fila', async () => {
    const pool = new FlowWorkerPool(); const job = { language: 'javascript' as const, cwd: process.cwd(), inputs: {}, timeoutMs: 100 };
    try { await expect(pool.execute({ ...job, code: 'while(true){}' })).rejects.toThrow(/timed out|excedeu/); expect((await pool.execute({ ...job, code: 'OUT={ok:true}' })).value).toEqual({ ok: true }); } finally { await pool.close(); }
    const boot = new FlowWorkerPool(); const pending = boot.execute({ ...job, code: 'OUT={ok:true}' }); const rejected = expect(pending).rejects.toThrow(/encerrado/); await boot.close(); await rejected;
  });
  it('Python 3 retorna JSON e remove globais entre execuções', async () => {
    const pool = new FlowWorkerPool(); const job = { language: 'python' as const, cwd: process.cwd(), inputs: { valor: 4 }, timeoutMs: 3000 };
    try {
      const first = await pool.execute({ ...job, code: 'hidden=7\ndef run(IN):\n    print("calculando")\n    return {"saida":IN["valor"]*2}' });
      expect(first.value).toEqual({ saida: 8 }); expect(first.logs).toContain('calculando');
      const second = await pool.execute({ ...job, code: 'OUT={"saida":"hidden" in globals()}' }); expect(second.value).toEqual({ saida: false });
    } finally { await pool.close(); }
  });
});
