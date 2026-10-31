import { z } from 'zod';
import { terminalNameSchema } from './names.js';

export const personaSchema = z.object({
  name: terminalNameSchema,
  text: z.string().trim().min(1, 'o texto da função não pode ficar vazio'),
});
export type Persona = z.infer<typeof personaSchema>;

export const personaScopeSchema = z.enum(['project', 'global']);
export type PersonaScope = z.infer<typeof personaScopeSchema>;

/** Fonte única da ajuda dos comandos de reger: o orq --help e o guia entregue ao regente. */
export const REGENT_COMMANDS: Array<{ usage: string; description: string }> = [
  { usage: 'orq new <nome> --agent claude|agy|codex|shell [--persona <f>] [--args "<texto>"] [--cwd <pasta>] [--no-resume]', description: 'cria um terminal ao seu lado, já conectado a você' },
  { usage: 'orq remove <nome>', description: 'remove um terminal ou nota (não você mesmo)' },
  { usage: 'orq link <a> <b>', description: 'conecta dois nós' },
  { usage: 'orq unlink <a> <b>', description: 'desconecta dois nós' },
  { usage: 'orq brief <terminal> <persona>', description: 'entrega o texto de uma função ao terminal' },
  { usage: 'orq persona list | show <f> | write <f> <texto|-> [--global] | remove <f> [--global]', description: 'gerencia as funções' },
];

export function regentGuide(): string {
  return [
    '[orq] Você é regente neste canvas. Comandos:',
    'Este ambiente é o Orquestra. A comunicação com os outros terminais usa o CLI orq, disponível na ferramenta de shell.',
    'Execute orq whoami e orq peers para confirmar sua identidade e os terminais conectados antes de enviar tarefas.',
    ...REGENT_COMMANDS.map((command) => `  ${command.usage}  ${command.description}`),
    'Use orq prompt <terminal> "<tarefa>" para passar tarefas e orq read <terminal> para acompanhar.',
  ].join('\n');
}

export function orquestraGuide(opts: { terminalName?: string; regent: boolean; cliScript: string; nodePath: string }): string {
  const fallback = `& "${opts.nodePath.replaceAll('\\', '/')}" "${opts.cliScript.replaceAll('\\', '/')}"`;
  return [
    'Você está executando dentro de um terminal do Orquestra.',
    opts.terminalName ? `Seu terminal se chama ${opts.terminalName}.` : '',
    'A integração com o canvas está disponível no servidor MCP orquestra: ferramentas whoami, peers, prompt, read, result, note_list, note_show, note_write, regent_link, regent_new e outras.',
    'Prefira as ferramentas MCP orquestra para comunicação. Elas funcionam mesmo quando o sandbox impede comandos de shell de abrir o pipe local.',
    'Use orq para interagir com terminais e notas deste canvas.',
    'Comece usando as ferramentas whoami e peers do MCP orquestra (equivalentes a orq whoami e orq peers). Use os nomes exatos retornados por peers.',
    'Para enviar uma tarefa: orq prompt <peer> "<texto>" --timeout 8m. Este comando entrega a tarefa e espera a resposta.',
    'Para acompanhar: orq read <peer> --lines 40. Para consultar resposta pendente: orq result <id>.',
    'Para notas: orq note list, orq note show <nome>, orq note write <nome> "<texto>".',
    'Os comandos usam ORQ_PIPE e ORQ_TOKEN herdados da sessão. Nunca imprima nem copie ORQ_TOKEN para a conversa, notas ou arquivos do projeto.',
    `Se orq não for encontrado no PATH, use este comando equivalente no PowerShell: ${fallback} whoami. Troque whoami por peers, prompt, read ou outros subcomandos conforme necessário.`,
    'Antes de afirmar que não há integração, execute whoami e relate a mensagem de erro concreta se o comando falhar.',
    opts.regent ? `${regentGuide()}\nSe o terminal informado pelo usuário não estiver conectado, use regent_link com seu nome retornado por whoami e o nome do destinatário antes de prompt.` : 'Você pode comunicar-se com os terminais conectados. Comandos de regente requerem o papel de regente.',
  ].filter(Boolean).join('\n');
}

export function personaBrief(persona: Persona, opts: { regent: boolean }): string {
  const brief = `[orq] Sua função: ${persona.name}\n${persona.text}`;
  return opts.regent ? `${brief}\n\n${regentGuide()}` : brief;
}
