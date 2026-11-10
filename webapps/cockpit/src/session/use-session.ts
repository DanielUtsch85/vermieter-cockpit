import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Session, SessionState } from './session';

export const SessionContext = createContext<Session | undefined>(undefined);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === undefined) throw new Error('useSession outside of SessionContext.');
  return session;
}

export function useSessionState(): SessionState {
  const session = useSession();
  // The third argument is the snapshot for a render without a browser (the tests render to static markup).
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}
