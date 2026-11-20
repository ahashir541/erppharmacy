import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { serverMode } from './backend/server.ts';
import { softwareMode } from './desktop.ts';
import { applyDisplayPrefs } from './office/admin.tsx';
import './tokens.css';
import './styles.css';
import './office/office.css';

applyDisplayPrefs();
// Nuskha Local on the shop PCs is always software; Nuskha Cloud only in an app window.
softwareMode(serverMode);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
