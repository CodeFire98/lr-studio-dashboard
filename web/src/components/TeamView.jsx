/* eslint-disable */
/* Team — brand workspace team management.
   Brand owners can invite members, change roles, and remove people.
   Regular members see the team list but can't manage it. */
import React, { useState, useEffect } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar } from './primitives.jsx';
import { readAuth } from '../lib/auth.js';
import {
  loadTeamForAccount,
  loadInvitationsForAccount,
  createInvitation,
  revokeInvitation,
  resendInvitation,
  sendInviteEmail,
  removeTeamMember,
  changeMemberRole,
} from '../lib/db.js';
import { confirm as confirmDialog } from './ConfirmDialog.jsx';

// Format the gap between now and an ISO timestamp as something human-readable.
// Returns { label, status } where status is 'fresh' | 'soon' | 'expired'.
function formatExpiry(iso) {
  if (!iso) return { label: 'No expiry', status: 'fresh' };
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return { label: 'Unknown', status: 'fresh' };
  if (ms <= 0) return { label: 'Expired', status: 'expired' };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor(ms / 3600000);
  if (days >= 2) return { label: `Expires in ${days} days`, status: 'fresh' };
  if (days === 1) return { label: 'Expires tomorrow', status: 'soon' };
  if (hours >= 1) return { label: `Expires in ${hours}h`, status: 'soon' };
  return { label: 'Expires soon', status: 'soon' };
}

const TeamView = ({ overrideAccountId } = {}) => {
  const auth = readAuth();
  const accountId = overrideAccountId || auth?.account?.id;
  const accountName = auth?.account?.name || 'Your Brand';
  const isImpersonating = !!overrideAccountId;

  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [copiedToken, setCopiedToken] = useState(null);

  const refresh = async () => {
    setErr('');
    if (!accountId) { setErr('No brand workspace found.'); setLoading(false); return; }
    try {
      const [team, pending] = await Promise.all([
        loadTeamForAccount(accountId),
        loadInvitationsForAccount(accountId),
      ]);
      setMembers(team);
      setInvites(pending);
    } catch (ex) {
      setErr(ex.message || "Couldn't load team.");
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch whenever the active brand (or impersonated client) changes — switching
  // brands while sitting on this tab needs to swap the team list, not stay stale.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMembers([]);
    setInvites([]);
    setErr('');
    if (!accountId) { setErr('No brand workspace found.'); setLoading(false); return; }
    Promise.all([
      loadTeamForAccount(accountId),
      loadInvitationsForAccount(accountId),
    ])
      .then(([team, pending]) => {
        if (cancelled) return;
        setMembers(team);
        setInvites(pending);
      })
      .catch((ex) => { if (!cancelled) setErr(ex.message || "Couldn't load team."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  const currentUserIsOwner = !isImpersonating && members.some((m) => m.person.id === auth?.id && m.role === 'owner');

  const submit = async (e) => {
    e?.preventDefault?.();
    setErr(''); setFlash('');
    if (!email.includes('@')) { setErr('Enter a valid email.'); return; }
    if (!accountId) { setErr('Still loading — try again in a sec.'); return; }
    try {
      const inv = await createInvitation({
        accountId,
        email,
        role,
        invitedBy: auth?.id || null,
      });
      setInvites((prev) => [inv, ...prev]);
      setEmail('');
      // Deliver the email. If Resend errors out, the invite row still exists
      // and the Copy-link fallback below the form keeps working.
      try {
        await sendInviteEmail(inv.id);
        setFlash(`Sent an invite to ${inv.email}.`);
      } catch (mailEx) {
        console.error('send-email failed', mailEx);
        setFlash(`Invite created for ${inv.email}, but the email didn't send. Copy the link below and send it manually.`);
      }
    } catch (ex) {
      setErr(ex.message || "Couldn't create invite.");
    }
  };

  const copyLink = async (inv) => {
    try {
      await navigator.clipboard.writeText(inv.inviteUrl);
      setCopiedToken(inv.token);
      setTimeout(() => setCopiedToken((t) => (t === inv.token ? null : t)), 1600);
    } catch {
      prompt('Copy this invite URL:', inv.inviteUrl);
    }
  };

  const handleRevokeInvite = async (inv) => {
    const ok = await confirmDialog({
      title: `Cancel invite for ${inv.email}?`,
      body: 'The link will stop working immediately.',
      confirmText: 'Cancel invite',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeInvitation(inv.id);
      setInvites((prev) => prev.filter((x) => x.id !== inv.id));
      setFlash(`Cancelled invite for ${inv.email}.`);
    } catch (ex) { setErr(ex.message); }
  };

  const [resendingId, setResendingId] = useState(null);
  const handleResendInvite = async (inv) => {
    setErr(''); setFlash(''); setResendingId(inv.id);
    try {
      const fresh = await resendInvitation(inv, { invitedBy: auth?.id || null });
      setInvites((prev) => [fresh, ...prev.filter((x) => x.id !== inv.id)]);
      try {
        await sendInviteEmail(fresh.id);
        setFlash(`Sent a fresh invite to ${fresh.email}.`);
      } catch (mailEx) {
        console.error('send-email failed', mailEx);
        setFlash(`Created a fresh invite for ${fresh.email}, but the email didn't send. Copy the link manually.`);
      }
    } catch (ex) {
      setErr(ex.message || "Couldn't resend invite.");
    } finally {
      setResendingId(null);
    }
  };

  const handleRemoveMember = async (m) => {
    const ok = await confirmDialog({
      title: `Remove ${m.person.name}?`,
      body: `They'll lose access to ${accountName}. You can re-invite them anytime.`,
      confirmText: 'Remove',
      cancelText: 'Keep them',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeTeamMember({ userId: m.person.id, accountId });
      setMembers((prev) => prev.filter((x) => x.id !== m.id));
      setFlash(`Removed ${m.person.name}.`);
    } catch (ex) { setErr(ex.message); }
  };

  const handleRoleChange = async (m, newRole) => {
    try {
      await changeMemberRole({ userId: m.person.id, accountId, newRole });
      setMembers((prev) => prev.map((x) => x.id === m.id ? { ...x, role: newRole } : x));
      setFlash(`Changed ${m.person.name}'s role to ${newRole}.`);
    } catch (ex) { setErr(ex.message); }
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{marginBottom: 8, color: "var(--accent-ink)"}}>{accountName}</div>
          <h1>Team</h1>
          <div className="sub">Manage who has access to your brand workspace. Invite teammates so they can view tasks, submit briefs, and collaborate.</div>
        </div>
      </div>

      {currentUserIsOwner && (
        <div className="card" style={{marginBottom: 24}}>
          <div className="card-head">
            <div>
              <div className="card-title">Invite a teammate</div>
              <div className="card-sub">You'll get a shareable link to send them.</div>
            </div>
          </div>
          <form onSubmit={submit} style={{display: "grid", gridTemplateColumns: "1.6fr 1fr auto", gap: 10, alignItems: "end"}}>
            <label className="auth-field" style={{margin: 0}}>
              <span>Work email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" required/>
            </label>
            <label className="auth-field" style={{margin: 0}}>
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} style={{height: 40, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)"}}>
                <option value="member">Member</option>
                <option value="owner">Admin</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary" style={{height: 40}}>
              <Icon name="plus" size={13}/>Create invite
            </button>
          </form>
          {err && <div className="auth-err" style={{marginTop: 10}}>{err}</div>}
          {flash && <div style={{marginTop: 10, fontSize: 13, color: "var(--good)"}}>{flash}</div>}
        </div>
      )}

      {invites.length > 0 && currentUserIsOwner && (
        <div className="card" style={{marginBottom: 24}}>
          <div className="card-head">
            <div>
              <div className="card-title">Pending invites ({invites.length})</div>
              <div className="card-sub">Invitees accept by opening the link and signing up with the same email.</div>
            </div>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: 8, padding: "10px 16px 16px"}}>
            {invites.map((inv) => {
              const expiry = formatExpiry(inv.expiresAt);
              const isExpired = expiry.status === 'expired';
              const isResending = resendingId === inv.id;
              return (
                <div
                  key={inv.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.5fr auto 1fr auto auto auto",
                    gap: 12,
                    alignItems: "center",
                    padding: 10,
                    border: `1px solid ${isExpired ? 'var(--accent-soft)' : 'var(--line)'}`,
                    borderRadius: 8,
                    background: isExpired ? 'var(--accent-tint)' : undefined,
                  }}
                >
                  <div>
                    <div style={{fontSize: 13, fontWeight: 500}}>{inv.email}</div>
                    <div style={{fontSize: 11, color: "var(--ink-4)", marginTop: 2, fontFamily: "var(--font-mono)"}}>
                      {inv.inviteUrl.length > 56 ? inv.inviteUrl.slice(0, 54) + '...' : inv.inviteUrl}
                    </div>
                  </div>
                  <span
                    style={{
                      padding: '3px 8px',
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 500,
                      background:
                        expiry.status === 'expired' ? 'var(--accent-soft)' :
                        expiry.status === 'soon'    ? 'color-mix(in oklab, var(--good) 18%, transparent)' :
                                                      'var(--surface-2)',
                      color:
                        expiry.status === 'expired' ? 'var(--accent-ink)' :
                        expiry.status === 'soon'    ? 'var(--good)' :
                                                      'var(--ink-3)',
                      whiteSpace: 'nowrap',
                    }}
                    title={inv.expiresAt ? `Expires ${new Date(inv.expiresAt).toLocaleString()}` : ''}
                  >
                    {expiry.label}
                  </span>
                  <div style={{fontSize: 12, color: "var(--ink-3)"}}>Role: {inv.role === 'owner' ? 'Admin' : 'Member'}</div>
                  <button
                    className="btn btn-sm"
                    onClick={() => copyLink(inv)}
                    disabled={isExpired}
                    title={isExpired ? 'Resend first to get a fresh link' : 'Copy invite link'}
                  >
                    {copiedToken === inv.token ? 'Copied!' : 'Copy link'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => handleResendInvite(inv)}
                    disabled={isResending}
                    title="Revoke and re-issue a fresh link"
                  >
                    <Icon name="refresh" size={12}/>{isResending ? 'Sending…' : 'Resend'}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => handleRevokeInvite(inv)} title="Cancel">
                    <Icon name="close" size={12}/>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="team-list">
        <div className="team-row is-head">
          <div>Member</div><div>Role</div><div>Status</div><div></div>
        </div>
        {loading ? (
          <div style={{padding: "20px 16px", color: "var(--ink-4)", fontSize: 13}}>Loading team...</div>
        ) : members.length === 0 ? (
          <div style={{padding: "20px 16px", color: "var(--ink-4)", fontSize: 13}}>No team members yet.</div>
        ) : members.map((m) => (
          <div className="team-row" key={m.id}>
            <div className="who">
              <Avatar person={m.person}/>
              <div>
                <div className="name">{m.person.name}</div>
                <div className="mail">{m.person.email || m.person.role}</div>
              </div>
            </div>
            <div style={{fontSize: 13, color: "var(--ink-2)"}}>
              {currentUserIsOwner && m.person.id !== auth?.id ? (
                <select
                  value={m.role}
                  onChange={(e) => handleRoleChange(m, e.target.value)}
                  style={{height: 32, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)", fontSize: 13}}
                >
                  <option value="member">Member</option>
                  <option value="owner">Admin</option>
                </select>
              ) : (
                <span style={{textTransform: "capitalize"}}>{m.role === 'owner' ? 'Admin' : 'Member'}</span>
              )}
            </div>
            <div>
              <span className="role-pill admin">Active</span>
            </div>
            <div style={{textAlign: "right"}}>
              {m.person.id === auth?.id ? (
                <span style={{color: "var(--ink-4)", fontSize: 12}}>You</span>
              ) : currentUserIsOwner ? (
                <button className="btn btn-sm btn-ghost" onClick={() => handleRemoveMember(m)} title="Remove">
                  <Icon name="close" size={12}/>Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div></div>
  );
};

export { TeamView };
