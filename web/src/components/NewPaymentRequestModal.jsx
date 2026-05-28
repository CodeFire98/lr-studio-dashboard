/* eslint-disable */
// NewPaymentRequestModal — agency-only. Captures the fields needed to
// post a new payment request: title, amount + currency, the Razorpay
// link URL (pasted from the agency's Razorpay dashboard), optional
// due date, optional description + internal notes.
import React, { useEffect, useState } from 'react';

const today = () => new Date().toISOString().slice(0, 10);

function validateLink(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null; // optional
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) return 'Must be a full https:// URL';
  return null;
}

const NewPaymentRequestModal = ({ open, onSubmit, onCancel }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [linkUrl, setLinkUrl] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [issuedOn, setIssuedOn] = useState(today());
  const [internalNotes, setInternalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errs, setErrs] = useState({});

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setAmount('');
    setCurrency('INR');
    setLinkUrl('');
    setDueOn('');
    setIssuedOn(today());
    setInternalNotes('');
    setErrs({});
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    const next = {};
    if (!title.trim()) next.title = 'Required';
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) next.amount = 'Enter a number ≥ 0';
    const lerr = validateLink(linkUrl);
    if (lerr) next.linkUrl = lerr;
    if (Object.keys(next).length > 0) {
      setErrs(next);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        amount: amt,
        currency,
        paymentLinkUrl: linkUrl.trim() || null,
        dueOn: dueOn || null,
        issuedOn: issuedOn || null,
        internalNotes: internalNotes.trim() || null,
      });
    } catch (e) {
      setErrs({ __form: e?.message || String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 520, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 10 }}>
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>New payment request</h2>
          <p className="login-modal-sub" style={{ marginTop: 4, fontSize: 13 }}>
            Paste your Razorpay payment-link URL so the brand can pay directly.
          </p>
        </div>

        <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Title" error={errs.title}>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. June retainer"
              style={inputStyle}
            />
          </Field>

          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional line item detail"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
            <Field label="Amount" error={errs.amount}>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                style={inputStyle}
              />
            </Field>
            <Field label="Currency">
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                style={inputStyle}
              >
                <option value="INR">INR ₹</option>
                <option value="USD">USD $</option>
              </select>
            </Field>
          </div>

          <Field label="Razorpay payment link (optional)" error={errs.linkUrl}>
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://rzp.io/i/…"
              style={inputStyle}
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Issued on">
              <input
                type="date"
                value={issuedOn}
                onChange={(e) => setIssuedOn(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Due on (optional)">
              <input
                type="date"
                value={dueOn}
                onChange={(e) => setDueOn(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>

          <Field label="Internal notes (agency only, optional)">
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder="Not visible to the brand"
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </Field>

          {errs.__form && (
            <div style={{ fontSize: 12.5, color: 'var(--accent)' }}>{errs.__form}</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 20px 20px' }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Creating…' : 'Create request'}
          </button>
        </div>
      </div>
    </div>
  );
};

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--line)',
  borderRadius: 6,
  background: 'var(--surface)',
  color: 'var(--ink-1)',
  fontSize: 13,
  outline: 'none',
};

function Field({ label, error, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
      <span>{label}</span>
      {children}
      {error && <span style={{ fontSize: 11.5, color: 'var(--accent)' }}>{error}</span>}
    </label>
  );
}

export { NewPaymentRequestModal };
