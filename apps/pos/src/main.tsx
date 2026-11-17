import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyDisplayPrefs } from './office/admin.tsx';
import './tokens.css';
import './styles.css';
import './office/office.css';

applyDisplayPrefs();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
