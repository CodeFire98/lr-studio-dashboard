/* eslint-disable */
/* Admin panel — reply-capable dashboard for L+R studio staff.
   Renders the L+R Inbox (queue), and a creative uploader. */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { Art, Avatar, AvatarStack, StatusBadge, STATUS_LABELS } from './primitives.jsx';
import MOCK from '../lib/mockData.js';
import { readAuth } from '../lib/auth.js';
import {
  loadLatestMessagePerTask,
  loadAgencyAccountId,
  loadTeamForAccount,
  loadInvitationsForAccount,
  createInvitation,
  revokeInvitation,
  removeTeamMember,
  loadBrandAccounts,
} from '../lib/db.js';

const AdminHome = ({ tasks, setRoute }) => {
  const auth = readAuth();
  const firstName = (auth?.name || 'there').split(' ')[0];

  // Pull the latest message per task so we can surface "brand sent you a reply".
  const [messagesByTask, setMessagesByTask] = useState(new Map());
  useEffect(() => {
    let cancelled = false;
    loadLatestMessagePerTask(true)
      .then((map) => { if (!cancelled) setMessagesByTask(map); })
      .catch((e) => console.error('loadLatestMessagePerTask failed', e));
    return () => { cancelled = true; };
  }, [tasks.length]);

  const queue = tasks
    .map((t) => ({ task: t, summary: messagesByTask.get(t.id) }))
    .filter((q) => q.summary?.awaitingAgencyReply);

  const newBriefs = tasks.filter((p) => p.status === "brief");
  const inFlight = tasks.filter((p) => ["progress", "review", "revising"].includes(p.status));

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{marginBottom: 8, color: "var(--accent-ink)"}}>L+R Studio</div>
          <h1>Inbox</h1>
          <div className="sub">What needs your eyes today, {firstName}.</div>
        </div>
        <div className="actions">
          <button className="btn"><Icon name="filter" size={14}/>All clients</button>
          <button className="btn btn-dark"><Icon name="upload" size={14}/>Upload creative</button>
        </div>
      </div>

      {newBriefs.length > 0 && (
        <div style={{marginBottom: 28}}>
          <div className="tiny" style={{marginBottom: 10}}>New briefs · needs kickoff</div>
          <div style={{display: "flex", flexDirection: "column", gap: 8}}>
            {newBriefs.map((p) => (
              <div key={p.id} className="admin-q-row" onClick={() => setRoute({view: "tasks", id: p.id})}>
                <div className="urgency hot"/>
                <div>
                  <div className="title">{p.title}</div>
                  <div className="sub">New brief from {p.accountName || p.tag} · {p.createdAt}</div>
                </div>
                <div><StatusBadge status={p.status}/></div>
                <div style={{fontSize: 12, color: "var(--ink-3)"}}>Due {p.deadline}</div>
                <div><AvatarStack people={p.collaborators} size="sm"/></div>
                <div style={{color: "var(--ink-4)"}}><Icon name="chevron-right" size={16}/></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{marginBottom: 12}}>
        <div className="tiny" style={{marginBottom: 10}}>Awaiting your reply</div>
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 8}}>
        {queue.length === 0 ? (
          <div className="empty" style={{padding: "14px 18px", fontSize: 13, color: "var(--ink-4)"}}>
            No pending replies — you're caught up.
          </div>
        ) : queue.map(({ task, summary }) => (
          <div key={task.id} className="admin-q-row" onClick={() => setRoute({view: "tasks", id: task.id})}>
            <div className="urgency hot"/>
            <div>
              <div className="title">{task.title}</div>
              <div className="sub">{summary.lastMessage.who.name}: "{summary.lastMessage.text.slice(0, 80)}{summary.lastMessage.text.length > 80 ? '…' : ''}"</div>
            </div>
            <div><StatusBadge status={task.status}/></div>
            <div style={{fontSize: 12, color: "var(--ink-3)"}}>{summary.lastMessage.time}</div>
            <div><AvatarStack people={task.collaborators} size="sm"/></div>
            <div style={{color: "var(--ink-4)"}}><Icon name="chevron-right" size={16}/></div>
          </div>
        ))}
      </div>

      <div className="divider" style={{margin: "40px 0"}}/>
      <div style={{marginBottom: 12}}>
        <div className="tiny" style={{marginBottom: 10}}>In flight</div>
      </div>
      <div className="project-grid">
        {inFlight.map((p) => (
          <div key={p.id} className="project-card" onClick={() => setRoute({view: "tasks", id: p.id})}>
            <div className="project-thumb">
              <Art palette={p.palette} kicker={p.artKicker} label={p.artLabel} variant={p.id.length}/>
              <div className="thumb-status"><StatusBadge status={p.status}/></div>
            </div>
            <div className="project-body">
              <div className="project-tag">Luma · {p.tag}</div>
              <div className="project-title">{p.title}</div>
              <div className="project-meta">
                <span>Due {p.deadline}</span><span className="dot"/>
                <AvatarStack people={p.collaborators} size="sm"/>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div></div>
  );
};

const AdminUploadView = ({ tasks }) => {
  const [target, setTarget] = useState(tasks[0]?.id || "");
  const [uploads, setUploads] = useState([]);
  const paletteIdx = useRef(0);
  const addUpload = () => {
    const p = MOCK.palettes[paletteIdx.current++ % MOCK.palettes.length];
    setUploads((u) => [...u, { id: "u_" + Date.now() + "_" + u.length, palette: p, name: `Upload ${u.length + 1}.png` }]);
  };
  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{marginBottom: 8, color: "var(--accent-ink)"}}>L+R Studio</div>
          <h1>Upload creatives</h1>
          <div className="sub">Deliver finished work to a client task. Versions and comments will be visible on their side.</div>
        </div>
      </div>

      <div className="card" style={{marginBottom: 24}}>
        <div className="card-head">
          <div><div className="card-title">1. Choose a task</div></div>
        </div>
        <select
          style={{padding: "10px 12px", border: "1px solid var(--line)", background: "var(--surface)", borderRadius: 10, fontSize: 14, outline: "none", color: "var(--ink)", width: "100%"}}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {tasks.map((p) => <option key={p.id} value={p.id}>{p.title} — {STATUS_LABELS[p.status]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="card-head">
          <div><div className="card-title">2. Drop the files</div><div className="card-sub">PNG, JPG, MP4, PDF up to 200MB</div></div>
          <button className="btn btn-sm btn-primary" onClick={addUpload} disabled={uploads.length === 0}>
            <Icon name="upload" size={12}/>Deliver {uploads.length || ""}
          </button>
        </div>
        <div className="uploader" onClick={addUpload}>
          <Icon name="upload" size={20} style={{color: "var(--ink-3)", marginBottom: 8}}/>
          <h4>Drop files here, or click to browse</h4>
          <div className="sub">We'll auto-version and notify Luma.</div>
        </div>
        {uploads.length > 0 && (
          <div className="upload-thumbs">
            {uploads.map((u) => (
              <div className="upload-thumb" key={u.id}>
                <Art palette={u.palette} kicker="Upload" variant={u.id.length}/>
                <button className="rm" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}><Icon name="x" size={11}/></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div></div>
  );
};

const AdminClientsView = ({ onOpenClient }) => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadBrandAccounts()
      .then((rows) => { if (!cancelled) setAccounts(rows); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load clients.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{marginBottom: 8, color: "var(--accent-ink)"}}>L+R Studio</div>
          <h1>Clients</h1>
          <div className="sub">All brands you manage across the studio. Click a row to open the client's workspace.</div>
        </div>
      </div>
      <div className="team-list">
        <div className="team-row is-head">
          <div>Client</div><div>Active tasks</div><div>Plan</div><div></div>
        </div>
        {loading ? (
          <div style={{padding: "20px 16px", color: "var(--ink-4)", fontSize: 13}}>Loading clients…</div>
        ) : err ? (
          <div style={{padding: "20px 16px", color: "var(--accent-ink)", fontSize: 13}}>{err}</div>
        ) : accounts.length === 0 ? (
          <div style={{padding: "20px 16px", color: "var(--ink-4)", fontSize: 13}}>
            No brand clients yet. New brand signups will show up here automatically.
          </div>
        ) : accounts.map((a) => {
          const initials = (a.name || '??').slice(0, 2);
          return (
            <button
              key={a.id}
              type="button"
              className="team-row team-row-btn"
              onClick={() => onOpenClient?.({ id: a.id, name: a.name })}
            >
              <div className="who">
                <Avatar person={{ initials, avatarColor: a.accentColor || '#C9A88B' }}/>
                <div>
                  <div className="name">{a.name}</div>
                  <div className="mail">{a.slug || 'brand'}</div>
                </div>
              </div>
              <div style={{fontSize: 13}}>
                {a.taskCount} task{a.taskCount === 1 ? '' : 's'}
                {a.deliveredThisMonth > 0 && ` · ${a.deliveredThisMonth} delivered this month`}
              </div>
              <div><span className="role-pill admin">Pro</span></div>
              <div style={{color: "var(--ink-4)", display: "flex", alignItems: "center", gap: 6, fontSize: 12}}>
                <span>Open</span><Icon name="chevron-right" size={14}/>
              </div>
            </button>
          );
        })}
      </div>
    </div></div>
  );
};

const AdminTeamView = ({ auth }) => {
  const [agencyId, setAgencyId] = useState(null);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [copiedToken, setCopiedToken] = useState(null);

  const refresh = async () => {
    setErr("");
    try {
      const id = agencyId || (await loadAgencyAccountId());
      if (!id) { setErr("No agency account found. Run the Supabase migration."); setLoading(false); return; }
      if (!agencyId) setAgencyId(id);
      const [team, pending] = await Promise.all([
        loadTeamForAccount(id),
        loadInvitationsForAccount(id),
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

  const submit = async (e) => {
    e?.preventDefault?.();
    setErr(""); setFlash("");
    if (!email.includes("@")) { setErr("Enter a valid email."); return; }
    if (!agencyId) { setErr("Still loading — try again in a sec."); return; }
    try {
      const inv = await createInvitation({
        accountId: agencyId,
        email,
        role,
        invitedBy: auth?.id || null,
      });
      setInvites((prev) => [inv, ...prev]);
      setFlash(`Invite created for ${inv.email}. Copy the link below and send it to them.`);
      setEmail("");
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
      prompt("Copy this invite URL:", inv.inviteUrl);
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
    if (!confirm(`Remove ${m.person.name} from the L+R team?`)) return;
    try {
      await removeTeamMember({ userId: m.person.id, accountId: agencyId });
      setMembers((prev) => prev.filter((x) => x.id !== m.id));
      setFlash(`Removed ${m.person.name}.`);
    } catch (ex) { setErr(ex.message); }
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{marginBottom: 8, color: "var(--accent-ink)"}}>L+R Studio</div>
          <h1>Team</h1>
          <div className="sub">Invite people to join the L+R agency workspace. Invitees sign up with the invited email and are auto-joined on their first sign-in.</div>
        </div>
      </div>

      <div className="card" style={{marginBottom: 24}}>
        <div className="card-head">
          <div>
            <div className="card-title">Invite a teammate</div>
            <div className="card-sub">You'll get a shareable link to send them — any email delivery is up to you for now.</div>
          </div>
        </div>
        <form onSubmit={submit} style={{display: "grid", gridTemplateColumns: "1.6fr 1fr auto", gap: 10, alignItems: "end"}}>
          <label className="auth-field" style={{margin: 0}}>
            <span>Work email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@lr.studio" required/>
          </label>
          <label className="auth-field" style={{margin: 0}}>
            <span>Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{height: 40, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)"}}>
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary" style={{height: 40}}>
            <Icon name="plus" size={13}/>Create invite
          </button>
        </form>
        {err && <div className="auth-err" style={{marginTop: 10}}>{err}</div>}
        {flash && <div style={{marginTop: 10, fontSize: 13, color: "var(--good)"}}>{flash}</div>}
      </div>

      {invites.length > 0 && (
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
                    {inv.inviteUrl.length > 64 ? inv.inviteUrl.slice(0, 62) + '…' : inv.inviteUrl}
                  </div>
                </div>
                <div style={{fontSize: 12, color: "var(--ink-3)"}}>Role: {inv.role}</div>
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
          <div style={{padding: "20px 16px", color: "var(--ink-4)", fontSize: 13}}>Loading team…</div>
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
            <div style={{fontSize: 13, color: "var(--ink-2)", textTransform: "capitalize"}}>{m.role}</div>
            <div>
              <span className="role-pill admin">Active</span>
            </div>
            <div style={{textAlign: "right"}}>
              {m.person.id === auth?.id ? (
                <span style={{color: "var(--ink-4)", fontSize: 12}}>You</span>
              ) : (
                <button className="btn btn-sm btn-ghost" onClick={() => handleRemoveMember(m)} title="Remove">
                  <Icon name="close" size={12}/>Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div></div>
  );
};

export { AdminHome, AdminUploadView, AdminClientsView, AdminTeamView };
