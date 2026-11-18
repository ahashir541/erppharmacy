import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../pos/src/tokens.css';
import '../../pos/src/styles.css';
import '../../pos/src/office/office.css';
import './hq.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
