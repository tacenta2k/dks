import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DiagnosticsErrorBoundary } from '../features/diagnostics/ErrorBoundary';
import { defaultErrorReporter, installGlobalRendererErrorHandlers } from '../features/diagnostics/error-reporting';
import { App } from './App';
import './styles.css';

installGlobalRendererErrorHandlers(defaultErrorReporter);

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('DKS renderer root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <DiagnosticsErrorBoundary componentName="renderer/root">
      <App />
    </DiagnosticsErrorBoundary>
  </StrictMode>,
);
