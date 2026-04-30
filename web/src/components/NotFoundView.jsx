/* eslint-disable */
/* NotFoundView — friendly 404 for unknown URLs. Matches the warm
   off-white / coral / serif language of the rest of the app. */
import React from 'react';
import { Icon } from './Icon.jsx';

const NotFoundView = ({ setRoute, pathname }) => {
  const goBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setRoute?.({ view: 'calendar' });
    }
  };

  return (
    <div className="view"><div className="view-inner">
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: 'var(--space-16) var(--space-10)',
          background:
            'radial-gradient(ellipse 60% 60% at 100% 0%, rgba(232, 85, 61, 0.12), transparent 70%),' +
            'radial-gradient(ellipse 40% 40% at 0% 100%, rgba(232, 85, 61, 0.06), transparent 70%),' +
            'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-2xl)',
          textAlign: 'center',
        }}
      >
        <div
          className="tiny"
          style={{ marginBottom: 'var(--space-4)', color: 'var(--accent-ink)' }}
        >
          404 · Page not found
        </div>

        <h2
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 'clamp(36px, 5vw, 58px)',
            margin: '0 0 var(--space-4)',
            letterSpacing: '-0.02em',
            fontWeight: 400,
            lineHeight: 1.05,
            textWrap: 'balance',
          }}
        >
          We don't think you meant <em style={{ color: 'var(--accent)', fontStyle: 'italic' }}>to come here.</em>
        </h2>

        <p
          style={{
            maxWidth: 540,
            margin: '0 auto var(--space-8)',
            color: 'var(--ink-3)',
            fontSize: 17,
            textWrap: 'pretty',
          }}
        >
          We couldn't find anything at this address. It might have been moved,
          renamed, or it never existed in the first place.
        </p>

        {pathname && (
          <div style={{ marginBottom: 'var(--space-8)' }}>
            <code
              style={{
                display: 'inline-block',
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: 13,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                color: 'var(--ink-3)',
              }}
            >
              {pathname}
            </code>
          </div>
        )}

        <div
          style={{
            display: 'inline-flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            className="btn btn-primary btn-lg"
            onClick={() => setRoute?.({ view: 'calendar' })}
          >
            <Icon name="calendar" size={14} />
            Take me to the Social Calendar
          </button>
          <button
            className="btn btn-ghost btn-lg"
            onClick={goBack}
            style={{ color: 'var(--ink-3)' }}
          >
            Go back
          </button>
        </div>
      </div>
    </div></div>
  );
};

export { NotFoundView };
