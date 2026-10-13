import { session, type Session } from 'electron';

/**
 * Retorna uma sessão particionada para o workspace, mantendo cookies e armazenamento
 * completamente isolados da janela do Orquestra e separados por workspace.
 */
export function getOrCreatePortalSession(workspaceId: string): Session {
  const partitionName = `persist:orq-portal-${workspaceId || 'default'}`;
  const portalSession = session.fromPartition(partitionName);

  // Bloqueia permissões sensíveis (câmera, microfone, geolocalização) de páginas web externas por padrão
  portalSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  return portalSession;
}
