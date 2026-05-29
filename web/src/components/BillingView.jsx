/* eslint-disable */
// =====================================================================
// BillingView — payment-request inbox for a brand
// =====================================================================
// Mounted at /c/:slug/billing. Single component for both roles.
//
// Brand sees:
//   - Outstanding payments with a "Pay now ↗" link (opens Razorpay link)
//   - Payment history with a "Download invoice ↓" button (signed URL)
//
// Agency sees the same data PLUS:
//   - "+ New payment request" in the page-head
//   - "Mark paid" / "Edit" / "Void" actions on outstanding rows
//   - "Upload invoice" / "Replace" / edit pencil on history rows
//   - internal_notes accessor
//
// Data: brand_payments table (migration 0062). Invoices in storage
// bucket brand-invoices, signed URLs on-demand.
// =====================================================================

import React, { useEffect, useState, useCallback } from 'react';
import { Icon } from './Icon.jsx';
import {
  loadBillingForAccount,
  createPayment,
  updatePayment,
  markPaymentPaid,
  voidPayment,
  uploadInvoiceFile,
  getInvoiceDownloadUrl,
} from '../lib/db.js';
import { formatMoney, formatDateShort } from '../lib/format.js';
import { NewPaymentRequestModal } from './NewPaymentRequestModal.jsx';
import { MarkPaidModal } from './MarkPaidModal.jsx';
import { EditPaymentModal } from './EditPaymentModal.jsx';

const STATUS_LABEL = {
  outstanding: 'Outstanding',
  paid: 'Paid',
  voided: 'Voided',
};

function StatusPill({ status, dueOn }) {
  let bg = 'var(--surface-2)';
  let color = 'var(--ink-3)';
  let label = STATUS_LABEL[status] || status;
  if (status === 'outstanding') {
    if (dueOn) {
      const today = new Date().toISOString().slice(0, 10);
      if (dueOn < today) {
        bg = 'color-mix(in srgb, var(--accent) 18%, transparent)';
        color = 'var(--accent)';
        label = 'Overdue';
      }
    }
  } else if (status === 'paid') {
    bg = 'color-mix(in srgb, #2f9e4f 18%, transparent)';
    color = '#1f7d3a';
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: 0.2,
      }}
    >
      {label}
    </span>
  );
}

function OutstandingRow({ row, isAgency, onMarkPaid, onEdit, onVoid }) {
  const canPay = !!row.payment_link_url;
  return (
    <div
      className="billing-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 8,
        alignItems: 'center',
        padding: '12px 14px',
        borderBottom: '1px solid var(--line-2)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14.5 }}>{row.title}</strong>
          <StatusPill status={row.status} dueOn={row.due_on} />
        </div>
        {row.description && (
          <div style={{ fontSize: 12.5, color: 'var(--ink-4)', marginTop: 2 }}>
            {row.description}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span><strong style={{ color: 'var(--ink-2)' }}>{formatMoney(row.amount, row.currency)}</strong></span>
          {row.due_on && <span>Due {formatDateShort(row.due_on)}</span>}
          <span>Issued {formatDateShort(row.issued_on)}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {canPay ? (
          <a
            href={row.payment_link_url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            Pay now <Icon name="arrow-up-right" size={12} />
          </a>
        ) : (
          <span
            title="Awaiting payment link from agency"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--surface-2)',
              color: 'var(--ink-4)',
              fontSize: 12,
              border: '1px solid var(--line-2)',
            }}
          >
            Awaiting link
          </span>
        )}
        {isAgency && (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onMarkPaid(row)}>
              <Icon name="check" size={12} /> Mark paid
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onEdit(row)}
              aria-label="Edit"
              title="Edit"
            >
              <Icon name="edit" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onVoid(row)}
              aria-label="Void"
              title="Void"
            >
              <Icon name="x" size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ row, isAgency, onDownload, onUploadInvoice, onEdit }) {
  const hasInvoice = !!row.invoice_file_path;
  return (
    <div
      className="billing-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 8,
        alignItems: 'center',
        padding: '12px 14px',
        borderBottom: '1px solid var(--line-2)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14.5 }}>{row.title}</strong>
          <StatusPill status={row.status} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span><strong style={{ color: 'var(--ink-2)' }}>{formatMoney(row.amount, row.currency)}</strong></span>
          {row.paid_at && <span>Paid {formatDateShort(row.paid_at)}</span>}
          {row.paid_note && <span style={{ color: 'var(--ink-3)' }}>· {row.paid_note}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {hasInvoice ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onDownload(row)}
            title={row.invoice_file_name || 'Download invoice'}
          >
            <Icon name="download" size={12} /> Invoice
          </button>
        ) : (
          <span
            title="Invoice not uploaded yet"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--surface-2)',
              color: 'var(--ink-4)',
              fontSize: 12,
              border: '1px solid var(--line-2)',
            }}
          >
            No invoice
          </span>
        )}
        {isAgency && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onUploadInvoice(row)}
              title={hasInvoice ? 'Replace invoice' : 'Upload invoice'}
            >
              <Icon name="upload" size={12} /> {hasInvoice ? 'Replace' : 'Upload'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onEdit(row)}
              aria-label="Edit"
              title="Edit"
            >
              <Icon name="edit" size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const BillingView = ({ accountId, isAgency, authUserId }) => {
  const [data, setData] = useState({ outstanding: [], history: [], voided: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [markPaidTarget, setMarkPaidTarget] = useState(null);
  const [uploadTarget, setUploadTarget] = useState(null);

  const refresh = useCallback(async () => {
    if (!accountId) {
      setLoading(false);
      setData({ outstanding: [], history: [], voided: [] });
      return;
    }
    try {
      const next = await loadBillingForAccount(accountId);
      setData(next);
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const handleCreate = async (input) => {
    await createPayment({ ...input, accountId, createdBy: authUserId });
    await refresh();
    setShowNew(false);
  };

  const handleEditSubmit = async (patch) => {
    await updatePayment(editTarget.id, patch);
    await refresh();
    setEditTarget(null);
  };

  const handleMarkPaid = async ({ paidAt, paidNote, file }) => {
    await markPaymentPaid({
      paymentId: markPaidTarget.id,
      accountId,
      paidAt,
      paidNote,
      file,
    });
    await refresh();
    setMarkPaidTarget(null);
  };

  const handleVoid = async (row) => {
    const ok = window.confirm(`Void "${row.title}"? It will move out of Outstanding.`);
    if (!ok) return;
    await voidPayment(row.id);
    await refresh();
  };

  const handleUploadInvoice = async ({ file }) => {
    await uploadInvoiceFile({
      paymentId: uploadTarget.id,
      accountId,
      file,
    });
    await refresh();
    setUploadTarget(null);
  };

  const handleDownload = async (row) => {
    try {
      const url = await getInvoiceDownloadUrl(row.invoice_file_path);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      console.warn('invoice download failed', e);
      alert('Could not generate download link. Try again or contact the agency.');
    }
  };

  if (!accountId) {
    return (
      <div className="view">
        <div className="view-inner">
          <div className="page-head">
            <div className="titles">
              <h1>Billing</h1>
              <div className="sub">Pick a brand from the sidebar to see its billing.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-inner">
        <div className="page-head">
          <div className="titles">
            <h1>Billing</h1>
            <div className="sub">
              {isAgency
                ? 'Post Razorpay payment links and upload invoices after payment.'
                : 'Open payment requests from your agency and your payment history.'}
            </div>
          </div>
          {isAgency && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowNew(true)}>
                <Icon name="plus" size={12} /> New payment request
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="card" style={{ marginBottom: 12, padding: 14, color: 'var(--accent)', fontSize: 13 }}>
            Couldn't load billing: {error}
          </div>
        )}

        {/* Outstanding */}
        <div className="card" style={{ marginBottom: 16, padding: 0 }}>
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <strong style={{ fontSize: 13.5 }}>Outstanding</strong>
            <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>
              {data.outstanding.length} {data.outstanding.length === 1 ? 'request' : 'requests'}
            </span>
          </div>
          {loading ? (
            <div style={{ padding: 16, color: 'var(--ink-4)', fontSize: 13 }}>Loading…</div>
          ) : data.outstanding.length === 0 ? (
            <div style={{ padding: 22, color: 'var(--ink-4)', fontSize: 13, textAlign: 'center' }}>
              {isAgency ? (
                <>
                  No outstanding payments.{' '}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowNew(true)}>
                    <Icon name="plus" size={12} /> New payment request
                  </button>
                </>
              ) : (
                'No outstanding payments.'
              )}
            </div>
          ) : (
            data.outstanding.map((row) => (
              <OutstandingRow
                key={row.id}
                row={row}
                isAgency={isAgency}
                onMarkPaid={(r) => setMarkPaidTarget(r)}
                onEdit={(r) => setEditTarget(r)}
                onVoid={handleVoid}
              />
            ))
          )}
        </div>

        {/* Payment history */}
        <div className="card" style={{ marginBottom: 16, padding: 0 }}>
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <strong style={{ fontSize: 13.5 }}>Payment history</strong>
            <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>
              {data.history.length} {data.history.length === 1 ? 'payment' : 'payments'}
            </span>
          </div>
          {loading ? (
            <div style={{ padding: 16, color: 'var(--ink-4)', fontSize: 13 }}>Loading…</div>
          ) : data.history.length === 0 ? (
            <div style={{ padding: 22, color: 'var(--ink-4)', fontSize: 13, textAlign: 'center' }}>
              No payment history yet.
            </div>
          ) : (
            data.history.map((row) => (
              <HistoryRow
                key={row.id}
                row={row}
                isAgency={isAgency}
                onDownload={handleDownload}
                onUploadInvoice={(r) => setUploadTarget(r)}
                onEdit={(r) => setEditTarget(r)}
              />
            ))
          )}
        </div>

        {/* Voided — agency only, collapsed footer */}
        {isAgency && data.voided.length > 0 && (
          <details className="card" style={{ padding: 0 }}>
            <summary style={{ padding: '12px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--ink-3)' }}>
              Voided ({data.voided.length})
            </summary>
            {data.voided.map((row) => (
              <div
                key={row.id}
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--line-2)',
                  fontSize: 12.5,
                  color: 'var(--ink-4)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <span>
                  {row.title} · {formatMoney(row.amount, row.currency)} · Issued {formatDateShort(row.issued_on)}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setEditTarget(row)}
                  aria-label="Edit"
                >
                  <Icon name="edit" size={12} />
                </button>
              </div>
            ))}
          </details>
        )}
      </div>

      <NewPaymentRequestModal
        open={showNew}
        onSubmit={handleCreate}
        onCancel={() => setShowNew(false)}
      />
      <EditPaymentModal
        open={!!editTarget}
        payment={editTarget}
        isAgency={isAgency}
        onSubmit={handleEditSubmit}
        onCancel={() => setEditTarget(null)}
      />
      <MarkPaidModal
        open={!!markPaidTarget}
        payment={markPaidTarget}
        onSubmit={handleMarkPaid}
        onCancel={() => setMarkPaidTarget(null)}
      />
      <UploadInvoiceModal
        open={!!uploadTarget}
        payment={uploadTarget}
        onSubmit={handleUploadInvoice}
        onCancel={() => setUploadTarget(null)}
      />
    </div>
  );
};

// Tiny inline modal — just a file picker. Keeping it co-located since
// it's 30 lines and reuses MarkPaid's file-input pattern. A dedicated
// file would be overkill.
function UploadInvoiceModal({ open, payment, onSubmit, onCancel }) {
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open) {
      setFile(null);
      setErr(null);
    }
  }, [open]);
  if (!open || !payment) return null;
  const handleSubmit = async () => {
    if (!file) {
      setErr('Pick a file first.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ file });
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
        style={{ maxWidth: 440, width: '100%' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="login-modal-head" style={{ paddingBottom: 10 }}>
          <h2 className="login-modal-title" style={{ fontSize: 20 }}>
            {payment.invoice_file_path ? 'Replace invoice' : 'Upload invoice'}
          </h2>
          <p className="login-modal-sub" style={{ marginTop: 4, fontSize: 13 }}>
            For <strong>{payment.title}</strong>. PDF or image, up to 10 MB.
          </p>
        </div>
        <div style={{ padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          />
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
            disabled={submitting || !file}
          >
            {submitting ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { BillingView };
