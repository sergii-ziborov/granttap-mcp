import { DesktopConnection } from './connection';
import { desktopSocketPath } from './socket-path';

/** A deliberate user stop reaches the owning desktop; no provider process is killed. */
export async function interruptCodexDesktop(sessionId: string): Promise<{ ok: boolean } | undefined> {
  let connection: DesktopConnection | undefined;
  try {
    const path = desktopSocketPath();
    if (!path) return undefined;
    connection = new DesktopConnection(path, 2_500);
    await connection.initialize();
    const owner = await connection.call('thread-owner-discovery', { hostId: 'local', conversationId: sessionId }, 1);
    if (owner.resultType === 'error' && owner.error === 'no-client-found') return undefined;
    if (owner.resultType !== 'success' || !owner.handledByClientId) return { ok: false };
    // Version 3 is the native explicit-user-stop form, without a stale expected turn ID.
    const response = await connection.call('thread-follower-interrupt-turn',
      { conversationId: sessionId, mode: 'user-stop', expectedTurnId: null }, 3, owner.handledByClientId);
    return { ok: response.resultType === 'success' && response.result?.ok === true };
  } catch { return { ok: false }; }
  finally { connection?.close(); }
}
