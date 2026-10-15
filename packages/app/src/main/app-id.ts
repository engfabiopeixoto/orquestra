/** Mesmo appId do electron-builder.yml: o Windows agrupa janelas e guarda o ícone da barra de tarefas por este id. */
export const PACKAGED_APP_USER_MODEL_ID = 'com.orquestra.app';

/**
 * O electron.exe do repositório (npm run dev, Playwright) não tem o ícone do Orquestra. Com o id do instalado, o
 * Windows o agruparia com o app instalado e guardaria o átomo do Electron como ícone dele. Fora do pacote, id próprio.
 */
export function appUserModelId(isPackaged: boolean): string {
  return isPackaged ? PACKAGED_APP_USER_MODEL_ID : `${PACKAGED_APP_USER_MODEL_ID}.dev`;
}
