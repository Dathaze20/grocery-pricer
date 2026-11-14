import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { startUpdateChecks } from './ui/pwa';
import './ui/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html is missing its root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// After the first render: registering the worker is not worth delaying the interface for.
startUpdateChecks();
