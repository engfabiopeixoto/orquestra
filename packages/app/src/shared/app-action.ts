/** Ações do antigo menu da janela, agora expostas pelo botão ⋯ da sidebar. */
export const APP_ACTIONS = ['open-logs', 'reload', 'devtools', 'open-repo', 'quit'] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
