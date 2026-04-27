/* eslint-disable */
/* CreateBrandModal — singleton + Promise API for prompting an existing
   user to spin up an additional brand workspace. Mirrors the ConfirmDialog
   pattern so callers stay terse:
       const id = await promptCreateBrand();
       if (id) setRoute({ view: 'brand' });
   The host <CreateBrandHost/> mounts once at the App root. */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { createAdditionalBrand } from '../lib/auth.js';

let resolver = null;
let publish = null;

export function promptCreateBrand(options) {
  return new Promise((resolve) => {
    resolver = resolve;
    publish?.(options || {});
  });
}

const CreateBrandHost = () => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    publish = () => {
      setName('');
      setErr('');
      setSubmitting(false);
      setOpen(true);
    };
    return () => { publish = null; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) close(null); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, submitting]);

  const close = (value) => {
    const r = resolver;
    resolver = null;
    setOpen(false);
    r?.(value);
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    const trimmed = name.trim();
    if (!trimmed) {
      setErr('Brand name is required.');
      return;
    }
    setSubmitting(true);
    setErr('');
    try {
      const accountId = await createAdditionalBrand({ brandName: trimmed });
      close(accountId);
    } catch (ex) {
      setErr(ex?.message || 'Could not create brand. Try again.');
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) close(null); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-brand-title"
        style={{ maxWidth: 420 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 14 }}>
          <h2 id="create-brand-title" className="login-modal-title" style={{ fontSize: 22 }}>
            Create a new brand
          </h2>
          <p className="login-modal-sub" style={{ marginTop: 6 }}>
            Spin up a fresh workspace for another brand. You'll be the owner — invite
            teammates from the Team page once it's live.
          </p>
        </div>
        <div className="login-modal-body" style={{ paddingTop: 0 }}>
          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field">
              <span>Brand name</span>
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Luma"
                disabled={submitting}
              />
            </label>
            {err && <div className="auth-err">{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => close(null)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting || !name.trim()}
              >
                {submitting ? 'Creating…' : 'Create brand'}
                {!submitting && <Icon name="arrow-right" size={13}/>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export { CreateBrandHost };
