/* eslint-disable */
/* ConfirmDialog — replaces window.confirm() with a styled modal that fits
   the rest of the app. Singleton + Promise API so callers stay terse:
       if (!await confirm({ title: 'Cancel invite?', body: '...' })) return;
   The host <ConfirmHost/> mounts once at the App root. */
import React, { useEffect, useState } from 'react';
import { Icon } from './Icon.jsx';

let resolver = null;
let publish = null;

export function confirm(options) {
  return new Promise((resolve) => {
    resolver = resolve;
    publish?.(options || {});
  });
}

const ConfirmHost = () => {
  const [state, setState] = useState(null); // null when closed; options when open

  useEffect(() => {
    publish = (opts) => setState(opts);
    return () => { publish = null; };
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e) => {
      if (e.key === 'Escape') decide(false);
      if (e.key === 'Enter')  decide(true);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [state]);

  const decide = (value) => {
    const r = resolver;
    resolver = null;
    setState(null);
    r?.(value);
  };

  if (!state) return null;
  const {
    title = 'Are you sure?',
    body = '',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false,
  } = state;

  return (
    <div className="login-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) decide(false); }}>
      <div
        className="login-modal"
        role="alertdialog"
        aria-modal="true"
        style={{ maxWidth: 380 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 14 }}>
          <h2 className="login-modal-title" style={{ fontSize: 22 }}>
            {title}
          </h2>
          {body && <p className="login-modal-sub" style={{ marginTop: 6 }}>{body}</p>}
        </div>
        <div
          className="login-modal-body"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4, paddingBottom: 18 }}
        >
          <button type="button" className="btn btn-ghost" onClick={() => decide(false)}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn ${danger ? '' : 'btn-primary'}`}
            style={danger ? {
              background: 'var(--accent)',
              color: 'var(--accent-contrast)',
              borderColor: 'var(--accent)',
            } : undefined}
            autoFocus
            onClick={() => decide(true)}
          >
            {confirmText}
            {!danger && <Icon name="arrow-right" size={13}/>}
          </button>
        </div>
      </div>
    </div>
  );
};

export { ConfirmHost };
