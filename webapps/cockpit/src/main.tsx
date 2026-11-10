import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { createQueryClient } from './query';
import { createMreAuthenticator } from './session/mre-authenticator';
import { Session } from './session/session';
import { SessionContext } from './session/use-session';
import { App } from './ui/App';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');

const session = new Session(createMreAuthenticator());
void session.start();

createRoot(root).render(
  <StrictMode>
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={createQueryClient()}>
        <App />
      </QueryClientProvider>
    </SessionContext.Provider>
  </StrictMode>,
);
