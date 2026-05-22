import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from '@/App';
import '@/index.css';
import { bootstrapLocale } from '@/i18n/locale-bootstrap';

// i18n must initialize before any component renders useTranslation().
bootstrapLocale();

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: import.meta.env.PROD,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION,
  tracesSampleRate: 0.2,
  sendDefaultPii: false,
  beforeSend(event) {
    const ignoredErrors = [
      'ResizeObserver loop limit exceeded',
      'Script error.',
      'NetworkError when attempting to fetch resource',
    ];
    const message = event.exception?.values?.[0]?.value || '';
    if (ignoredErrors.some((err) => message.includes(err))) {
      return null;
    }
    return event;
  },
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);
root.render(
  <Sentry.ErrorBoundary fallback={<div>Page Error</div>}>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </Sentry.ErrorBoundary>,
);
