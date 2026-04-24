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
  removeTeamMember,
  changeMemberRole,
} from '../lib/db.js';

const TeamView = () => {
  const auth = readAuth();
  const accountId = auth?.account?.id;
  const accountName = auth?.account?.name || 'Your Brand';

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

  useEffect(() => { refresh(); }, []); // eslint-disable-line

  const currentUserIsOwner = members.some((m) => m.person.id === auth?.id && m.role === 'owner');

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
      setFlash(`Invite created for ${inv.email}. Copy the link below and send it to them.`);
      setEmail('');
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
    if (!confirm(`Cancel invite for ${inv.email}?`)) return;
    try {
      await revokeInvitation(inv.id);
      setInvites((prev) => prev.filter((x) => x.id !== inv.id));
      setFlash(`Cancelled invite for ${inv.email}.`);
    } catch (ex) { setErr(ex.message); }
  };

  const handleRemoveMember = async (m) => {
    if (!confirm(`Remove ${m.person.name} from ${accountName}?`)) return;
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
            {invites.map((inv) => (
              <div key={inv.id} style={{display: "grid", gridTemplateColumns: "1.5fr 1fr auto auto", gap: 12, alignItems: "center", padding: 10, border: "1px solid var(--line)", borderRadius: 8}}>
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{inv.email}</div>
                  <div style={{fontSize: 11, color: "var(--ink-4)", marginTop: 2, fontFamily: "var(--font-mono)"}}>
                    {inv.inviteUrl.length > 64 ? inv.inviteUrl.slice(0, 62) + '...' : inv.inviteUrl}
                  </div>
                </div>
                <div style={{fontSize: 12, color: "var(--ink-3)"}}>Role: {inv.role === 'owner' ? 'Admin' : 'Member'}</div>
                <button className="btn btn-sm" onClick={() => copyLink(inv)}>
                  {copiedToken === inv.token ? 'Copied!' : 'Copy link'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => handleRevokeInvite(inv)} title="Cancel">
                  <Icon name="close" size={12}/>
                </button>
              </div>
            ))}
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
