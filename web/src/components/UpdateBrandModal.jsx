/* eslint-disable */
/* UpdateBrandModal — agency-only modal for sending a free-form update email
   to all members of a brand workspace. The agency types a summary of what's
   changed across the calendar (multiple plans, status flips, etc.) and one
   email goes to each member, instead of one email per micro-event.

   Recipients + agency authz are enforced server-side in the `send-email`
   edge function (`agency-update` template).
*/
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { sendAgencyUpdateEmail } from '../lib/db.js';

const MAX_LEN = 8000;

const UpdateBrandModal = ({ open, accountId, accountName, onClose }) => {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'sending' | 'sent' | 'error'
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const textareaRef = useRef(null);

  // Reset state every time the modal is opened.
  useEffect(() => {
    if (!open) return;
    setSubject('');
    setMessage('');
    setStatus('idle');
    setResult(null);
    setErr('');
    // Focus the textarea on open.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  const handleSend = async () => {
    setErr('');
    if (!message.trim()) {
      setErr('Write a message before sending.');
      return;
    }
    if (!accountId) {
      setErr('No active brand selected.');
      return;
    }
    setStatus('sending');
    try {
      const res = await sendAgencyUpdateEmail({ accountId, message, subject: subject || undefined });
      setResult(res);
      setStatus('sent');
    } catch (ex) {
      console.error('agency-update failed', ex);
      setErr(ex?.message || "Couldn't send the update.");
      setStatus('error');
    }
  };

  const handleClose = () => {
    if (status === 'sending') return; // don't let user close mid-send
    onClose?.();
  };

  if (!open) return null;

  const sentCount = result?.sent || 0;
  const totalCount = result?.total ?? sentCount;
  const failedCount = (result?.failed || []).length;
  const isPartial = totalCount > sentCount;

  return (
    <div
      className="login-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 520, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 10 }}>
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>
            Send update {accountName ? `to ${accountName}` : ''}
          </h2>
          <p className="login-modal-sub" style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)' }}>
            One email to every member of the workspace. Use this to summarize a batch of changes instead of sending one email per plan.
          </p>
        </div>

        {status === 'sent' ? (
          <div style={{ padding: '20px 22px 24px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 14px',
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                fontSize: 14,
                color: 'var(--ink-1)',
              }}
            >
              <Icon name="check" size={16} />
              <span>
                Sent to {sentCount} of {totalCount} member{totalCount === 1 ? '' : 's'}
                {failedCount > 0 ? ` · ${failedCount} failed` : ''}.
              </span>
            </div>
            {failedCount > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-3)' }}>
                Failed: {(result.failed || []).map((f) => f.to).join(', ')}
              </div>
            )}
            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={handleClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: '4px 22px 22px' }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginBottom: 6, marginTop: 8 }}>
              Subject <span style={{ color: 'var(--ink-4)' }}>(optional)</span>
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={accountName ? `Update on ${accountName} from L+R Agency` : 'Update on your workspace from L+R Agency'}
              disabled={status === 'sending'}
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line)',
                background: 'var(--surface)',
                color: 'var(--ink-1)',
                marginBottom: 14,
              }}
            />

            <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
              Message
            </label>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX_LEN))}
              placeholder="Hey team — here's what's new on the calendar this week:&#10;&#10;• ...&#10;• ...&#10;&#10;Let me know if anything looks off."
              rows={9}
              disabled={status === 'sending'}
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 14,
                lineHeight: 1.55,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line)',
                background: 'var(--surface)',
                color: 'var(--ink-1)',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--ink-4)' }}>
              <span>Replies will go to your email.</span>
              <span>{message.length}/{MAX_LEN}</span>
            </div>

            {err && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--accent-ink, #c44)' }}>
                {err}
              </div>
            )}

            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={handleClose}
                disabled={status === 'sending'}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={handleSend}
                disabled={status === 'sending' || !message.trim()}
              >
                {status === 'sending' ? 'Sending…' : 'Send update'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export { UpdateBrandModal };
