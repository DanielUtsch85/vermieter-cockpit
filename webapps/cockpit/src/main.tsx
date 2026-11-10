import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { createQueryClient } from './query';
import { reloadWhenRestoredFromCache } from './navigation';
import { createRealmLock, reloadPage } from './routing';
import { clearCacheWhenSessionEnds } from './session/cache-binding';
import { createMreAuthenticator } from './session/mre-authenticator';
import { Session } from './session/session';
import { SessionContext } from './session/use-session';
import { App } from './ui/App';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');

reloadWhenRestoredFromCache(window, reloadPage);

const session = new Session(createMreAuthenticator());
const queryClient = createQueryClient();
clearCacheWhenSessionEnds(session, queryClient);
void session.start();

createRoot(root).render(
  <StrictMode>
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queryClient}>
        <App realmLock={createRealmLock()} />
      </QueryClientProvider>
    </SessionContext.Provider>
  </StrictMode>,
);
