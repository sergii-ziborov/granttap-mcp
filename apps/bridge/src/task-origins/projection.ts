import type { SessionInfo, SessionsStatus } from '../../../../packages/protocol/schema';
import { localTaskOrigins, type TaskOriginRegistry } from './index';

/** A fresh catalog heals a controller that was offline when the creation response was sent. */
export function decorateTaskOriginCatalog(status: SessionsStatus, room: string,
  registry?: TaskOriginRegistry): SessionsStatus {
  let origins: ReturnType<TaskOriginRegistry['readyInRoom']>;
  try { origins = (registry ?? localTaskOrigins()).readyInRoom(room); }
  catch { return status; }
  const decorate = (session: SessionInfo): SessionInfo => {
    const matching = origins.filter(origin => origin.sessionId === session.sessionId && origin.agent === session.agent
      && (!origin.projectId || !session.projectId || origin.projectId === session.projectId));
    if (!matching.length && !session.creationOrigins) return session;
    const { creationOrigins: _previous, ...native } = session;
    return matching.length ? { ...native, creationOrigins: matching.slice(0, 32).map(origin => ({
      originId: origin.originId, controllerPublicKey: origin.controllerPublicKey,
    })) } : native;
  };
  return { ...status, sessions: status.sessions.map(decorate), history: status.history?.map(decorate) };
}
