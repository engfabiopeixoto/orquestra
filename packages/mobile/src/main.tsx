import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerMobileServiceWorker } from './notifications';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

registerMobileServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
