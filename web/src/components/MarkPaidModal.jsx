/* eslint-disable */
// MarkPaidModal — flip an outstanding payment to paid. Optional file
// upload so the agency can attach the invoice in the same step; the
// row can also be marked paid without a file (upload via the row's
// Upload-invoice button later).
import React, { useEffect, useState } from 'react';

const today = () => new Date().toISOString().slice(0, 10);

const MarkPaidModal = ({ open, payment, onSubmit, onCancel }) => {
  const [paidAt, setPaidAt] = useState(today());
  const [paidNote, setPaidNote] = useState('');
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setPaidAt(today());
    setPaidNote('');
    setFile(null);
    setErr(null);
  }, [open]);

  if (!open || !payment) return null;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({ paidAt, paidNote: paidNote.trim() || null, file });
    } catch (e) {
      setErr(e?.message || String(e));
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
        style={{ maxWidth: 460, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 10 }}>
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>Mark as paid</h2>
          <p className="login-modal-sub" style={{ marginTop: 4, fontSize: 13 }}>
            <strong>{payment.title}</strong>
          </p>
        </div>

        <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
            <span>Payment date</span>
            <input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
            <span>Note (optional)</span>
            <input
              type="text"
              value={paidNote}
              onChange={(e) => setPaidNote(e.target.value)}
              placeholder="e.g. UPI ref 4827xxxx"
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
            <span>Invoice file (optional, PDF or image, ≤10 MB)</span>
            <input
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                if (f && f.size > 10 * 1024 * 1024) {
                  setErr('File too large (max 10 MB).');
                  setFile(null);
                  return;
                }
                setErr(null);
                setFile(f);
              }}
              style={{ fontSize: 12 }}
            />
            <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>
              Can also be uploaded later from the row in Payment history.
            </span>
          </label>

          {err && <div style={{ fontSize: 12.5, color: 'var(--accent)' }}>{err}</div>}
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
            {submitting ? 'Saving…' : 'Mark paid'}
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

export { MarkPaidModal };
