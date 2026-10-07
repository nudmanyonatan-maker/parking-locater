import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { navigate } from 'wouter/use-browser-location';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker: Web Push + a minimal offline shell. Registered in dev too so
// notifications can be tested locally.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
      console.warn('Service worker registration failed', err);
    });
  });
  // A notification tapped while the app is open: route in place instead of reloading.
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as { type?: unknown; url?: unknown } | null;
    if (msg?.type === 'navigate' && typeof msg.url === 'string' && msg.url.startsWith('/') && !msg.url.startsWith('//')) {
      navigate(msg.url);
    }
  });
}
