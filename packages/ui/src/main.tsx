import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/theme.css';
import './styles/app.css';
import './styles/markdown.css';
import './styles/panel.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Celeste: mount point #root was not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
