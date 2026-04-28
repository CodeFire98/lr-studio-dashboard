import React from 'react';
import ReactDOM from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { App } from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { PasswordResetPage } from './components/PasswordResetPage.jsx';
import { LightboxProvider } from './components/Lightbox.jsx';
import './styles/app.css';

window.LR_TWEAKS = window.LR_TWEAKS || {
  accent: 'coral',
  density: 'airy',
  dark: false,
  font: 'geist-instrument',
  showBriefAssist: true,
  heroVariant: 'gradient',
};

// Supabase's password-recovery email link lands here with `type=recovery`
// in the URL hash. Route to the reset page before the App shell mounts so
// the user isn't bounced around by auth state.
const hash = window.location.hash || '';
const isRecovery =
  hash.includes('type=recovery') || window.location.pathname.endsWith('/reset-password');

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <LightboxProvider>
      {isRecovery ? <PasswordResetPage /> : <App />}
      <Analytics />
      <SpeedInsights />
    </LightboxProvider>
  </ErrorBoundary>
);
