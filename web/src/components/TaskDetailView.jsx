/* eslint-disable */
/* Task Detail — brief summary, chat thread, deliverables, collaborators */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { Art, Avatar, StatusBadge } from './primitives.jsx';
import { useLightbox } from './Lightbox.jsx';
import { SafeImage } from './SafeImage.jsx';
import MOCK from '../lib/mockData.js';
import { readAuth } from '../lib/auth.js';
import {
  loadMessagesForTask,
  sendMessage,
  subscribeToMessagesForTask,
  loadActivityForTask,
  subscribeToActivityForTask,
  loadAssetsForTask,
  uploadAsset,
  deleteAsset,
  assetSignedUrl,
  subscribeToAssetsForTask,
  loadAgencyAccountId,
  loadTeamForAccount,
  assignTaskLead,
  updateTaskField,
} from '../lib/db.js';
import { confirm as confirmDialog } from './ConfirmDialog.jsx';

const CHIP_LABELS = {
  count: "Count", deadline: "Deadline", format: "Format", platform: "Platform", objective: "Objective",
  tone: "Tone", audience: "Audience", keyMessage: "Key message", aspectRatios: "Aspect ratios",
  campaign: "Campaign", product: "Product", mustInclude: "Must include", mustAvoid: "Must avoid",
  language: "Language", references: "References",
};

const TaskDetailView = ({ taskId, tasks, updateTask, setRoute, mode }) => {
  const task = tasks.find((p) => p.id === taskId);
  const auth = readAuth();
  const viewerId = auth?.id;
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState("overview"); // "overview" | "conversation" | "activity"
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [activity, setActivity] = useState([]);
  const [assets, setAssets] = useState([]);
  const [assetThumbs, setAssetThumbs] = useState({}); // id -> signed url
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState([]); // [{ name, percent, error? }]
  const threadRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load & subscribe to messages whenever we land on a task.
  useEffect(() => {
    if (!task?.id || !viewerId) return;
    let cancelled = false;
    setMessagesLoading(true);
    loadMessagesForTask(task.id, viewerId)
      .then((rows) => { if (!cancelled) setMessages(rows); })
      .catch((e) => console.error('loadMessages failed', e))
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    const unsub = subscribeToMessagesForTask(task.id, viewerId, (evt) => {
      if (evt.type === 'INSERT') {
        setMessages((prev) => prev.some((m) => m.id === evt.message.id) ? prev : [...prev, evt.message]);
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [task?.id, viewerId]);

  // Load & subscribe to assets for the same task.
  useEffect(() => {
    if (!task?.id) return;
    let cancelled = false;
    loadAssetsForTask(task.id)
      .then((rows) => { if (!cancelled) setAssets(rows); })
      .catch((e) => console.error('loadAssets failed', e));
    const unsub = subscribeToAssetsForTask(task.id, (evt) => {
      if (evt.type === 'INSERT') {
        setAssets((prev) => prev.some((a) => a.id === evt.asset.id) ? prev : [evt.asset, ...prev]);
      } else if (evt.type === 'UPDATE') {
        setAssets((prev) => prev.map((a) => (a.id === evt.asset.id ? evt.asset : a)));
      } else if (evt.type === 'DELETE') {
        setAssets((prev) => prev.filter((a) => a.id !== evt.id));
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [task?.id]);

  // Generate signed thumbnail URLs for image assets.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const needs = assets.filter((a) => a.isImage && !assetThumbs[a.id]);
      if (needs.length === 0) return;
      const updates = {};
      for (const a of needs) {
        try {
          updates[a.id] = await assetSignedUrl(a.storagePath);
        } catch (e) {
          // ignore — placeholder will render
        }
      }
      if (!cancelled && Object.keys(updates).length) {
        setAssetThumbs((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => { cancelled = true; };
  }, [assets]);

  // Load & subscribe to activity feed for the same task.
  useEffect(() => {
    if (!task?.id) return;
    let cancelled = false;
    loadActivityForTask(task.id)
      .then((rows) => { if (!cancelled) setActivity(rows); })
      .catch((e) => console.error('loadActivity failed', e));
    const unsub = subscribeToActivityForTask(task.id, (evt) => {
      if (evt.type === 'INSERT') {
        setActivity((prev) => prev.some((a) => a.id === evt.activity.id) ? prev : [evt.activity, ...prev]);
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [task?.id]);

  // Agency lead picker: load the Linkrunner team once (per session) so the dropdown
  // can offer assignment targets. Brand viewers don't need this list.
  const [agencyMembers, setAgencyMembers] = useState([]);
  const [reassigning, setReassigning] = useState(false);
  const [editingChip, setEditingChip] = useState(null); // chip key being edited
  const [editValue, setEditValue] = useState('');
  const [savingChip, setSavingChip] = useState(false);

  // Options matching the brief creation form
  const CHIP_OPTIONS = {
    count: ["1","3","5","10","15","25","50","100"],
    format: ["Static image / ad","Carousel","Lifestyle photography","Product photography","Illustration","Packaging design","Video"],
    platform: ["Instagram","TikTok","Facebook","YouTube","Pinterest","LinkedIn","Email","Web","Out-of-home"],
    objective: ["Brand awareness","Product launch","Conversion / sales","Lead generation","Re-engagement / winback","Recruiting / employer brand"],
  };
  useEffect(() => {
    if (mode !== 'admin') return;
    let cancelled = false;
    (async () => {
      try {
        const agencyId = await loadAgencyAccountId();
        if (!agencyId || cancelled) return;
        const team = await loadTeamForAccount(agencyId);
        if (!cancelled) setAgencyMembers(team);
      } catch (e) {
        console.warn('failed to load agency team', e);
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  const startEditChip = (key, currentValue) => {
    if (key === 'deadline') {
      // For deadline, seed with the ISO date if available
      setEditValue(task.deadlineDate || '');
    } else if (key === 'count') {
      setEditValue(String(currentValue?.value || ''));
    } else {
      setEditValue(currentValue?.value || '');
    }
    setEditingChip(key);
  };

  const saveChipEdit = async (newVal) => {
    if (!editingChip || savingChip) return;
    const chip = task.brief.chips[editingChip];
    const oldDisplay = editingChip === 'count' ? String(chip?.value || '') : (chip?.value || '');
    const displayNew = newVal != null ? String(newVal) : editValue.trim();
    if (displayNew === oldDisplay) { setEditingChip(null); return; }

    const ok = await confirmDialog({
      title: 'Update this field?',
      body: `Change ${CHIP_LABELS[editingChip] || editingChip} from "${oldDisplay || '—'}" to "${displayNew || '—'}"? This will be logged in the activity feed.`,
      confirmText: 'Save change',
      cancelText: 'Cancel',
    });
    if (!ok) return;

    setSavingChip(true);
    try {
      const dbVal = editingChip === 'count' ? (parseInt(displayNew, 10) || null) : displayNew;
      const updated = await updateTaskField({
        taskId: task.id,
        chipKey: editingChip,
        oldValue: oldDisplay,
        newValue: dbVal,
        actorId: viewerId,
      });
      updateTask(task.id, updated);
    } catch (e) {
      alert(`Couldn't update: ${e.message || e}`);
    } finally {
      setSavingChip(false);
      setEditingChip(null);
    }
  };

  const handleAssignLead = async (userId) => {
    if (!task?.id) return;
    const next = userId || null;
    if (next === (task.assignedLeadId || null)) return;
    setReassigning(true);
    try {
      const updated = await assignTaskLead({ taskId: task.id, userId: next });
      // Bubble the new lead up so the parent list (and topbar crumb) refresh.
      updateTask(task.id, {
        assignedLeadId: updated.assignedLeadId,
        creativeLead: updated.creativeLead,
        collaborators: updated.collaborators,
      });
    } catch (e) {
      alert(`Couldn't reassign: ${e.message || e}`);
    } finally {
      setReassigning(false);
    }
  };

  useEffect(() => {
    if (tab === "conversation" && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages.length, tab]);

  if (!task) {
    return <div className="view"><div className="view-inner"><div className="empty"><div className="big">Task not found</div></div></div></div>;
  }

  const sendReply = async () => {
    const body = reply.trim();
    if (!body || !viewerId || sending) return;
    setSending(true);
    try {
      const newMessage = await sendMessage({ taskId: task.id, body, authorId: viewerId });
      setMessages((prev) => prev.some((m) => m.id === newMessage.id) ? prev : [...prev, newMessage]);
      setReply("");
      // If an agency user replies to a brand-new brief, auto-advance status.
      if (mode === "admin" && task.status === "brief") {
        updateTask(task.id, { status: "progress" });
      }
    } catch (e) {
      console.error('sendMessage failed', e);
      alert(`Couldn't send: ${e.message || e}`);
    } finally {
      setSending(false);
    }
  };

  const advanceStatus = (newStatus) => updateTask(task.id, { status: newStatus });

  const handleFilesPicked = async (fileList) => {
    if (!fileList?.length || !viewerId) return;
    const kind = mode === 'admin' ? 'deliverable' : 'reference';
    const files = Array.from(fileList);
    setUploading(true);
    setUploadProgress(files.map((f) => ({ name: f.name, percent: 0 })));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const newAsset = await uploadAsset({
          taskId: task.id,
          file,
          kind,
          uploaderId: viewerId,
          onProgress: (percent) => {
            setUploadProgress((prev) => prev.map((p, idx) => (idx === i ? { ...p, percent } : p)));
          },
        });
        setAssets((prev) => prev.some((a) => a.id === newAsset.id) ? prev : [newAsset, ...prev]);
      } catch (e) {
        console.error('upload failed', e);
        setUploadProgress((prev) => prev.map((p, idx) => (idx === i ? { ...p, error: e.message || String(e) } : p)));
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    // Clear successful rows after a beat; keep errors visible until user dismisses.
    setTimeout(() => {
      setUploadProgress((prev) => prev.filter((p) => p.error));
    }, 1400);
  };

  const dismissProgress = (idx) => {
    setUploadProgress((prev) => prev.filter((_, i) => i !== idx));
  };

  const lightbox = useLightbox();
  const isAgency = mode === 'admin';

  // Bare delete used by both the tile button (which prompts via
  // confirmDialog first) and the lightbox Delete button (which prompts
  // via its own internal confirm). Either path lands here.
  const actuallyDeleteAsset = async (asset) => {
    await deleteAsset(asset);
    setAssets((prev) => prev.filter((a) => a.id !== asset.id));
  };

  const handleOpenAsset = async (asset) => {
    try {
      const url = await assetSignedUrl(asset.storagePath);
      lightbox.open({
        src: url,
        mimeType: asset.mimeType,
        name: asset.filename,
        alt: asset.filename,
        downloadUrl: url,
        onDelete: isAgency ? () => actuallyDeleteAsset(asset) : undefined,
      });
    } catch (e) {
      alert(`Couldn't get file: ${e.message || e}`);
    }
  };

  const handleDeleteAsset = async (asset) => {
    const ok = await confirmDialog({
      title: `Delete ${asset.filename}?`,
      body: 'This permanently removes the file from the task.',
      confirmText: 'Delete',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await actuallyDeleteAsset(asset);
    } catch (e) {
      alert(`Delete failed: ${e.message || e}`);
    }
  };

  const deliverables = assets.filter((a) => a.kind === 'deliverable' || a.kind === 'wip');
  const referenceAssets = assets.filter((a) => a.kind === 'reference');

  // Side-based delete: agency can delete deliverables/wip; brand can delete references.
  // Mirrors the assets_delete_by_side RLS policy in migration 0003.
  const canDelete = (a) => {
    if (mode === 'admin') return a.kind === 'deliverable' || a.kind === 'wip';
    return a.kind === 'reference';
  };

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <div className="tiny" style={{ marginBottom: 8 }}>
            <a onClick={() => setRoute({ view: "tasks" })} style={{cursor: "pointer"}}>Tasks</a>
            <span style={{margin: "0 6px", color: "var(--ink-5)"}}>/</span>
            <span>{task.tag}</span>
          </div>
          <h1 style={{ fontSize: 40 }}>{task.title}</h1>
          <div className="sub" style={{display: "flex", gap: 14, alignItems: "center", marginTop: 10}}>
            <StatusBadge status={task.status}/>
            <span>· Due {task.deadline}</span>
            <span>· Lead {task.creativeLead.name}</span>
          </div>
        </div>
        <div className="actions">
          {mode === "admin" && (
            <select
              className="btn"
              style={{appearance: "none", paddingRight: 30, background: "var(--ink)", color: "var(--bg)", borderColor: "var(--ink)"}}
              value={task.status}
              onChange={(e) => advanceStatus(e.target.value)}
            >
              <option value="brief">Set status: Brief Received</option>
              <option value="progress">Set status: In Progress</option>
              <option value="review">Set status: In Review</option>
              <option value="delivered">Set status: Delivered</option>
              <option value="revising">Set status: Revising</option>
            </select>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: "flex", alignItems: "center", gap: 2,
        borderBottom: "1px solid var(--line)",
        marginBottom: 24, marginTop: -8,
      }}>
        {[
          {k: "overview", label: "Overview", icon: "sparkles"},
          {k: "conversation", label: "Conversation", icon: "comment", count: messages.length},
          {k: "activity", label: "Activity", icon: "sparkles", count: activity.length},
        ].map((t) => {
          const active = tab === t.k;
          return (
            <button key={t.k} onClick={() => setTab(t.k)} style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "10px 16px",
              fontSize: 13.5, fontWeight: 500,
              color: active ? "var(--ink)" : "var(--ink-3)",
              borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
              transition: "color 150ms",
            }}>
              <Icon name={t.icon} size={14}/>
              <span>{t.label}</span>
              {typeof t.count === "number" && t.count > 0 && (
                <span style={{
                  fontSize: 11, fontVariantNumeric: "tabular-nums",
                  padding: "1px 7px", borderRadius: 999,
                  background: active ? "var(--accent-soft)" : "var(--surface-2)",
                  color: active ? "var(--accent-ink)" : "var(--ink-3)",
                  fontWeight: 500,
                }}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="detail">
        <div className="detail-main">
          {tab === "overview" && <>
          {/* Parsed brief */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Brief summary</div>
                <div className="card-sub">Captured {task.createdAt}</div>
              </div>
            </div>
            <p style={{ color: "var(--ink-2)", margin: "0 0 16px", lineHeight: 1.55 }}>
              "{task.brief.message}"
            </p>
            <div className="brief-grid">
              {Object.entries(task.brief.chips).map(([k, v]) => {
                const editable = ['count', 'deadline', 'format', 'platform', 'objective'].includes(k);
                const display = k === "count" ? `${v.value} ${v.unit || ""}`.trim() : v.value;
                const isEditing = editingChip === k;
                const options = CHIP_OPTIONS[k];
                return (
                  <div className="brief-field" key={k} style={editable ? { cursor: 'pointer' } : undefined}>
                    <div className="k">{CHIP_LABELS[k] || k}</div>
                    {isEditing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {k === 'deadline' ? (
                          <input
                            type="date"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            autoFocus
                            disabled={savingChip}
                            style={{
                              padding: '4px 6px', fontSize: 13,
                              border: '1px solid var(--accent)', borderRadius: 6,
                              outline: 'none', background: 'var(--surface)',
                            }}
                          />
                        ) : options ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {options.map((opt) => {
                              const selected = editValue === opt;
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => setEditValue(opt)}
                                  disabled={savingChip}
                                  style={{
                                    padding: '4px 10px', fontSize: 12, borderRadius: 6,
                                    border: selected ? '1px solid var(--accent)' : '1px solid var(--line)',
                                    background: selected ? 'var(--accent-tint)' : 'var(--surface)',
                                    color: selected ? 'var(--accent-ink)' : 'var(--ink-2)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  {k === 'count' ? `${opt} creatives` : opt}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveChipEdit(); if (e.key === 'Escape') setEditingChip(null); }}
                            autoFocus
                            disabled={savingChip}
                            style={{
                              padding: '4px 6px', fontSize: 13,
                              border: '1px solid var(--accent)', borderRadius: 6,
                              outline: 'none', background: 'var(--surface)',
                            }}
                          />
                        )}
                        <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-start', marginTop: 4 }}>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={savingChip || !editValue}
                            onClick={() => {
                              if (k === 'deadline') {
                                const d = new Date(editValue);
                                const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                saveChipEdit(formatted);
                              } else {
                                saveChipEdit(editValue);
                              }
                            }}
                            style={{ padding: '5px 14px', fontSize: 12 }}
                          >{savingChip ? 'Saving…' : 'Save'}</button>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => setEditingChip(null)}
                            disabled={savingChip}
                            style={{ padding: '5px 14px', fontSize: 12 }}
                          >Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="v" onClick={editable ? () => startEditChip(k, v) : undefined}
                        title={editable ? 'Click to edit' : undefined}
                        style={editable ? { borderBottom: '1px dashed var(--ink-5)', display: 'inline-block' } : undefined}
                      >{display}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Deliverables (agency-uploaded) */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Deliverables</div>
                <div className="card-sub">{deliverables.length} items · newest first</div>
              </div>
              {mode === "admin" && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{display: "none"}}
                    onChange={(e) => handleFilesPicked(e.target.files)}
                  />
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="upload" size={12}/>{uploading ? 'Uploading…' : 'Upload new'}
                  </button>
                </>
              )}
            </div>
            {uploadProgress.length > 0 && (
              <UploadProgressList items={uploadProgress} onDismiss={dismissProgress}/>
            )}
            {deliverables.length === 0 ? (
              <div className="empty" style={{padding: "32px 16px"}}>
                <div className="big">No deliverables yet</div>
                <div>
                  {mode === "admin"
                    ? "Upload drop 01 when it's ready — the client will see it live."
                    : "Your creative lead will drop the first concepts here soon."}
                </div>
              </div>
            ) : (
              <div className="deliverables">
                {deliverables.map((a) => (
                  <AssetTile
                    key={a.id}
                    asset={a}
                    thumb={assetThumbs[a.id]}
                    onClick={() => handleOpenAsset(a)}
                    onDelete={canDelete(a) ? () => handleDeleteAsset(a) : null}
                  />
                ))}
              </div>
            )}
          </div>

          {/* References (brand-uploaded) — always visible to both sides */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">References</div>
                <div className="card-sub">{referenceAssets.length} items from {task.accountName || 'the brand'}</div>
              </div>
              {mode !== "admin" && (
                <>
                  <input
                    ref={mode === "admin" ? null : fileInputRef}
                    type="file"
                    multiple
                    style={{display: "none"}}
                    onChange={(e) => handleFilesPicked(e.target.files)}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="upload" size={12}/>{uploading ? 'Uploading…' : 'Add reference'}
                  </button>
                </>
              )}
            </div>
            {referenceAssets.length === 0 ? (
              <div className="empty" style={{padding: "24px 16px"}}>
                <div>No references attached.</div>
              </div>
            ) : (
              <div className="deliverables">
                {referenceAssets.map((a) => (
                  <AssetTile
                    key={a.id}
                    asset={a}
                    thumb={assetThumbs[a.id]}
                    onClick={() => handleOpenAsset(a)}
                    onDelete={canDelete(a) ? () => handleDeleteAsset(a) : null}
                  />
                ))}
              </div>
            )}
          </div>

          </>}

          {tab === "conversation" && (
          /* Thread */
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Conversation</div>
                <div className="card-sub">{messages.length} messages between {task.accountName || task.tag} and Linkrunner Media</div>
              </div>
            </div>
            <div className="thread" ref={threadRef}>
              {messagesLoading ? (
                <div className="empty" style={{padding: "24px 16px"}}>
                  <div>Loading…</div>
                </div>
              ) : messages.length === 0 ? (
                <div className="empty" style={{padding: "24px 16px"}}>
                  <div className="big">Nothing in flight</div>
                  <div>{mode === "admin" ? "Kick things off by saying hi." : "Your creative lead will kick things off within 24 hours."}</div>
                </div>
              ) : messages.map((m) => (
                <div key={m.id} className={"msg " + m.from}>
                  <Avatar person={m.who} size="sm"/>
                  <div>
                    <div className="name">{m.who.name} · {m.time}</div>
                    <div className="bubble">{m.text}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="thread-composer">
              <textarea
                placeholder={mode === "admin" ? "Reply as Linkrunner Media…" : "Reply to your creative lead…"}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendReply(); }}
                disabled={sending}
              />
              <button className="send" onClick={sendReply} disabled={sending || !reply.trim()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
          )}

          {tab === "activity" && (
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Activity</div>
                <div className="card-sub">Every event on this task, in order.</div>
              </div>
            </div>
            <div style={{display: "flex", flexDirection: "column", gap: 14, padding: "16px 20px 24px"}}>
              {activity.length === 0 ? (
                <div className="empty" style={{padding: "24px 16px"}}>
                  <div>No activity yet.</div>
                </div>
              ) : activity.map((a) => (
                <div key={a.id} style={{display: "flex", gap: 12, alignItems: "flex-start"}}>
                  <Avatar person={a.actor} size="sm"/>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: 13.5, color: "var(--ink)"}}>{a.label}</div>
                    <div style={{fontSize: 12, color: "var(--ink-4)", marginTop: 2}}>{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="detail-side">
          <div className="card">
            <div className="card-head"><div className="card-title" style={{fontSize: 18}}>Team</div></div>
            <div className="collab-list">
              <div className="collab-row">
                <Avatar person={task.creativeLead} size="sm"/>
                <div>
                  <div className="name">{task.creativeLead.name}</div>
                  <div style={{fontSize: 11, color: "var(--ink-4)"}}>{task.creativeLead.role}</div>
                </div>
                <div className="role">Lead</div>
              </div>
              {mode === 'admin' && agencyMembers.length > 0 && (
                <div style={{ padding: '8px 16px 12px', borderTop: '1px solid var(--line-2)' }}>
                  <div className="tiny" style={{ marginBottom: 6 }}>Reassign lead</div>
                  <select
                    value={task.assignedLeadId || ''}
                    onChange={(e) => handleAssignLead(e.target.value)}
                    disabled={reassigning}
                    style={{
                      width: '100%',
                      height: 34,
                      padding: '0 10px',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      background: 'var(--surface)',
                      color: 'var(--ink)',
                      fontSize: 13,
                    }}
                  >
                    <option value="">Unassigned</option>
                    {agencyMembers.map((m) => (
                      <option key={m.person.id} value={m.person.id}>
                        {m.person.name}{m.role === 'owner' ? ' · Lead' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {task.collaborators.filter((c) => c.id !== task.creativeLead.id).map((c) => (
                <div className="collab-row" key={c.id}>
                  <Avatar person={c} size="sm"/>
                  <div>
                    <div className="name">{c.name}</div>
                    <div style={{fontSize: 11, color: "var(--ink-4)"}}>{c.role}</div>
                  </div>
                  <div className="role">Collab</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title" style={{fontSize: 18}}>Timeline</div></div>
            <div style={{display: "flex", flexDirection: "column", gap: 10, fontSize: 13}}>
              {[
                {k: "Brief Received", v: task.createdAt, on: true},
                {k: "Kickoff", v: "Within 24h", on: ["progress","review","delivered","revising"].includes(task.status)},
                {k: "First draft", v: "+3 days", on: ["review","delivered","revising"].includes(task.status)},
                {k: "Delivered", v: task.deadline, on: task.status === "delivered"},
              ].map((step, i) => (
                <div key={i} style={{display: "flex", gap: 10, alignItems: "center"}}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: step.on ? "var(--accent)" : "var(--ink-5)",
                    boxShadow: step.on ? "0 0 0 3px var(--accent-soft)" : "none",
                    flex: "0 0 auto"
                  }}/>
                  <div style={{flex: 1}}>
                    <div style={{color: step.on ? "var(--ink)" : "var(--ink-3)", fontWeight: step.on ? 500 : 400}}>{step.k}</div>
                  </div>
                  <div style={{color: "var(--ink-4)", fontSize: 12}}>{step.v}</div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

    </div></div>
  );
};

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

const UploadProgressList = ({ items, onDismiss }) => (
  <div style={{display: "flex", flexDirection: "column", gap: 6, padding: "12px 16px"}}>
    {items.map((it, idx) => (
      <div key={idx} style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 12px",
        background: it.error ? "var(--accent-soft)" : "var(--surface-2)",
        border: "1px solid " + (it.error ? "var(--accent-soft)" : "var(--line)"),
        borderRadius: 8,
      }}>
        <Icon name={it.error ? "close" : "upload"} size={12} />
        <div style={{flex: 1, minWidth: 0}}>
          <div style={{fontSize: 12, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {it.name}
          </div>
          {it.error ? (
            <div style={{fontSize: 11, color: "var(--accent-ink)", marginTop: 2}}>{it.error}</div>
          ) : (
            <div style={{height: 3, background: "var(--line)", borderRadius: 2, overflow: "hidden", marginTop: 4}}>
              <div style={{
                height: "100%",
                width: `${it.percent || 0}%`,
                background: "var(--accent)",
                transition: "width 200ms ease-out",
              }}/>
            </div>
          )}
        </div>
        <span style={{fontSize: 11, color: "var(--ink-4)", fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right"}}>
          {it.error ? "failed" : `${it.percent || 0}%`}
        </span>
        {it.error && (
          <button onClick={() => onDismiss(idx)} style={{
            background: "transparent", border: 0, cursor: "pointer", color: "var(--ink-3)", padding: 4,
          }} title="Dismiss"><Icon name="close" size={12}/></button>
        )}
      </div>
    ))}
  </div>
);

const AssetTile = ({ asset, thumb, onClick, onDelete }) => {
  return (
    <div className="deliverable" style={{position: "relative", cursor: "pointer"}}>
      <div className="prev" onClick={onClick} style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--surface-2)", overflow: "hidden",
      }}>
        {asset.isImage && thumb ? (
          <SafeImage src={thumb} alt={asset.filename} filename={asset.filename} caption="Preview unavailable" style={{width: "100%", height: "100%", objectFit: "cover"}}/>
        ) : (
          <div style={{textAlign: "center", padding: 12}}>
            <Icon name="upload" size={28}/>
            <div style={{fontSize: 11, color: "var(--ink-4)", marginTop: 6, textTransform: "uppercase", letterSpacing: 0.5}}>
              {(asset.mimeType.split('/')[1] || 'file').slice(0, 6)}
            </div>
          </div>
        )}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete"
            style={{
              position: "absolute", top: 8, right: 8,
              background: "rgba(0,0,0,0.5)", color: "#fff",
              border: 0, borderRadius: 999, width: 24, height: 24,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer",
            }}
          ><Icon name="close" size={12}/></button>
        )}
      </div>
      <div className="meta" onClick={onClick}>
        <span title={asset.filename}>{asset.filename.length > 24 ? asset.filename.slice(0, 22) + '…' : asset.filename}</span>
        <span className="v">v{asset.version}</span>
      </div>
      <div style={{fontSize: 11, color: "var(--ink-4)", padding: "0 4px 6px", display: "flex", justifyContent: "space-between"}}>
        <span>{asset.uploader?.name?.split(' ')[0] || ''}</span>
        <span>{formatSize(asset.sizeBytes)}</span>
      </div>
    </div>
  );
};

export { TaskDetailView };
