// Entrada de teste do processo do núcleo: o agente falso no lugar dos agentes reais.
import { createFakeAdapter } from '../../../core/test/helpers/fake-adapter.js';
import { runHost } from '../../src/run.js';

await runHost({ adapters: { shell: createFakeAdapter() } });
