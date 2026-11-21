import { describe, expect, it } from 'vitest';
import type { QualityReport } from '@orquestra/shared';
import { AskBroker } from '../src/ask-broker.js';
import { createHandlers } from '../src/handlers.js';
import { silentLogger } from '../src/log.js';
import { NoteStore } from '../src/notes.js';
import { Topology } from '../src/topology.js';

function makeDeps(quality?: (params: { changed?: boolean; refresh?: boolean }) => Promise<QualityReport>) {
  return {
    topology: new Topology(),
    notes: new NoteStore(),
    broker: new AskBroker({ resolveTarget: () => undefined, log: silentLogger() }),
    session: () => undefined,
    onNoteChanged: () => {},
    isRegent: () => false,
    quality,
  };
}

describe('handler quality do core', () => {
  it('lança APP_UNAVAILABLE quando a opção quality não foi fornecida', async () => {
    const dispatch = createHandlers(makeDeps());
    await expect(
      dispatch('quality', {}, { session: 'A' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
  });

  it('repassa { changed: true } para o callback quality quando configurado', async () => {
    const calls: Array<{ changed?: boolean; refresh?: boolean }> = [];
    const sample: QualityReport = {
      version: 1,
      dir: 'C:/proj',
      measuredAt: '2026-11-20T12:00:00.000Z',
      durationMs: 12,
      language: 'js-ts',
      limits: { files: 0, skippedLarge: 0, truncated: false },
      metrics: [
        { id: 'size', signal: 'missing', value: null, delta: null },
        { id: 'complexity', signal: 'missing', value: null, delta: null },
        { id: 'dependencies', signal: 'missing', value: null, delta: null },
        { id: 'coverage', signal: 'missing', value: null, delta: null },
        { id: 'mutation', signal: 'missing', value: null, delta: null },
      ],
      files: [],
      functions: [],
      cycles: [],
      hotspots: [],
      changed: [],
      coverage: null,
      mutation: null,
    };

    const dispatch = createHandlers(makeDeps(async (params) => {
      calls.push(params);
      return sample;
    }));

    const res = await dispatch('quality', { changed: true }, { session: 'A' }, new AbortController().signal);
    expect(calls).toEqual([{ changed: true }]);
    expect(res).toEqual(sample);
  });
});
