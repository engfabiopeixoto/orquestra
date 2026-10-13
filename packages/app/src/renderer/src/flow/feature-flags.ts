/**
 * Flag temporária para desativar o sistema de E/S de dados dos agentes no fluxo visual.
 *
 * Quando desativada (false):
 * - Terminais não renderizam portas de E/S nem o botão "Configurar E/S".
 * - Arestas de fluxo não conectam terminais/etapas de agente.
 * - Conexões entre terminais funcionam exclusivamente como conexões de conversa.
 *
 * Para reativar o sistema de E/S de agentes, altere o valor desta constante para true.
 */
export const AGENT_FLOW_IO = false;
