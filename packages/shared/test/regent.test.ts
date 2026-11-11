import { describe, expect, it } from 'vitest';
import { orquestraGuide, personaBrief, personaSchema, REGENT_COMMANDS, regentGuide } from '../src/regent.js';

describe('funções e guia do regente', () => {
  it('função precisa de nome válido e texto não vazio', () => {
    expect(personaSchema.safeParse({ name: 'revisor', text: 'Revise o código.' }).success).toBe(true);
    expect(personaSchema.safeParse({ name: 'com espaço', text: 'x' }).success).toBe(false);
    expect(personaSchema.safeParse({ name: 'revisor', text: '   ' }).success).toBe(false);
  });

  it('o guia lista todos os comandos de reger e orienta a consultar orq usage antes de delegar', () => {
    const guide = regentGuide();
    expect(guide.startsWith('[orq] Você é regente neste canvas. Comandos:')).toBe(true);
    expect(guide).toContain('Antes de delegar, consulte orq usage para ver o crédito restante de cada assinatura (claude, codex, agy) e prefira agentes com folga.');
    for (const command of REGENT_COMMANDS) expect(guide).toContain(command.usage);
    expect(REGENT_COMMANDS.map((command) => command.usage.split(' ').slice(0, 2).join(' '))).toEqual(
      expect.arrayContaining(['orq new', 'orq remove', 'orq restart', 'orq link', 'orq unlink', 'orq brief']),
    );
    expect(guide).toContain('orq restart');
  });

  it('orquestraGuide orienta a consultar orq usage antes de delegar', () => {
    const guide = orquestraGuide({ terminalName: 'T1', regent: false, cliScript: 'cli.js', nodePath: 'node' });
    expect(guide).toContain('Antes de delegar, consulte orq usage para ver o crédito restante de cada assinatura (claude, codex, agy) e prefira agentes com folga.');
  });

  it('a entrega da função começa pelo cabeçalho e inclui o guia só para regente', () => {
    const persona = { name: 'executor', text: 'Implemente as tarefas.' };
    expect(personaBrief(persona, { regent: false })).toBe('[orq] Sua função: executor\nImplemente as tarefas.');
    expect(personaBrief(persona, { regent: true })).toBe(`[orq] Sua função: executor\nImplemente as tarefas.\n\n${regentGuide()}`);
  });
});
