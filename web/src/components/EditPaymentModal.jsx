/* eslint-disable */
// EditPaymentModal — agency-only. Edits the editable fields of an
// existing payment request: title, description, amount + currency,
// payment link URL, dates, internal notes. Status and paid_at are
// edited via their own affordances (Mark paid / Void) so this modal
// stays focused on the row's static metadata.
import React, { useEffect, useState } from 'react';

function validateLink(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) return 'Must be a full https:// URL';
  return null;
}

const EditPaymentModal = ({ open, payment, isAgency, onSubmit, onCancel }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [linkUrl, setLinkUrl] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errs, setErrs] = useState({});

  useEffect(() => {
    if (!open || !payment) return;
    setTitle(payment.title || '');
    setDescription(payment.description || '');
    setAmount(payment.amount != null ? String(payment.amount) : '');
    setCurrency(payment.currency || 'INR');
    setLinkUrl(payment.payment_link_url || '');
    setDueOn(payment.due_on || '');
    setIssuedOn(payment.issued_on || '');
    setInternalNotes(payment.internal_notes || '');
    setErrs({});
  }, [open, payment]);

  if (!open || !payment || !isAgency) return null;

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
        issuedOn: issuedOn || payment.issued_on,
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
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>Edit payment request</h2>
        </div>

        <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Title" error={errs.title}>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={inputStyle}
            />
          </Field>

          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
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

          <Field label="Razorpay payment link" error={errs.linkUrl}>
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
            <Field label="Due on">
              <input
                type="date"
                value={dueOn}
                onChange={(e) => setDueOn(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>

          <Field label="Internal notes (agency only)">
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
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
            {submitting ? 'Saving…' : 'Save changes'}
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

export { EditPaymentModal };
