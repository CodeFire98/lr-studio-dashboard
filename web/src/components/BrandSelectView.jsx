/* eslint-disable */
/* BrandSelectView — shown after login when a user belongs to 2+ brand accounts
   and hasn't picked an active brand yet. Picks one → setActiveBrand() → main app. */
import React, { useState } from 'react';
import { Icon } from './Icon.jsx';
import { setActiveBrand, signOut } from '../lib/auth.js';

const BrandSelectView = ({ auth, onSelected }) => {
  const memberships = auth?.memberships || [];
  const [busyId, setBusyId] = useState(null);

  const pick = async (accountId) => {
    if (busyId) return;
    setBusyId(accountId);
    try {
      await setActiveBrand(accountId);
      onSelected?.(accountId);
    } catch (e) {
      console.error('setActiveBrand failed', e);
      setBusyId(null);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        background: 'var(--surface-1)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div style={{ marginBottom: 28, textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            <span className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
            Signed in as {auth?.email}
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 600, marginBottom: 6 }}>Choose a brand</h1>
          <p style={{ color: 'var(--ink-3)', fontSize: 14, margin: 0 }}>
            You're part of {memberships.length} brand workspaces. Pick one to continue —
            you can switch anytime from the sidebar.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {memberships.map((m) => {
            const { account, role } = m;
            const accent = account.accentColor || '#2B2B2E';
            const isBusy = busyId === account.id;
            return (
              <button
                key={account.id}
                disabled={!!busyId}
                onClick={() => pick(account.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 16px',
                  borderRadius: 12,
                  border: '1px solid var(--line)',
                  background: 'var(--surface-2)',
                  cursor: busyId ? 'default' : 'pointer',
                  textAlign: 'left',
                  transition: 'border-color 120ms, transform 120ms',
                  opacity: busyId && !isBusy ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!busyId) e.currentTarget.style.borderColor = 'var(--accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--line)';
                }}
              >
                <span
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 10,
                    background: `linear-gradient(135deg, ${accent}, color-mix(in oklab, ${accent} 70%, black))`,
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                    fontSize: 15,
                    flexShrink: 0,
                  }}
                >
                  {(account.name || '?').trim().slice(0, 2).toUpperCase()}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 15,
                      fontWeight: 500,
                      color: 'var(--ink-1)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {account.name}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                    {role === 'owner' ? 'Owner' : 'Member'} · {account.type === 'agency' ? 'Agency' : 'Brand'}
                  </span>
                </span>
                {isBusy ? (
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Opening…</span>
                ) : (
                  <Icon name="chevron-right" size={16} />
                )}
              </button>
            );
          })}
        </div>

        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => signOut()}
            disabled={!!busyId}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
};

export { BrandSelectView };
