import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html is missing its root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
