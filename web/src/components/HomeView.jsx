/* eslint-disable */
/* Home / Request — the hero screen. */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { StatusBadge } from './primitives.jsx';
import MOCK from '../lib/mockData.js';
import { parseBrief } from '../lib/chipParser.js';
import { submitTask } from '../lib/db.js';

const REQUIRED_CHIPS = [
  { key: "count", label: "Number", placeholder: "# creatives" },
  { key: "deadline", label: "Deadline", placeholder: "Deadline" },
  { key: "format", label: "Format", placeholder: "Format" },
  { key: "platform", label: "Platform", placeholder: "Platform" },
  { key: "objective", label: "Objective", placeholder: "Objective" },
];

const OPTIONAL_CHIP_DEFS = [
  { key: "product", label: "Product / SKU" },
  { key: "campaign", label: "Campaign" },
  { key: "audience", label: "Target audience" },
  { key: "keyMessage", label: "Key message / CTA" },
  { key: "tone", label: "Tone" },
  { key: "aspectRatios", label: "Aspect ratios" },
  { key: "mustInclude", label: "Must include" },
  { key: "mustAvoid", label: "Must avoid" },
  { key: "language", label: "Language" },
  { key: "references", label: "References" },
];

// Picker suggestions per field
const SUGGESTIONS = {
  count: { mode: "single-num", picks: ["1","3","5","10","15","25","50","100"], suffix: " creatives", custom: "numeric" },
  deadline: { mode: "single", picks: ["ASAP (24–48 hrs)","This week","Next week","In 2 weeks","In 1 month"], custom: "date" },
  format: { mode: "multi", picks: ["Static image / ad","Carousel","Lifestyle photography","Product photography","Illustration","Packaging design","Video"] },
  platform: { mode: "multi", picks: ["Instagram","TikTok","Facebook","YouTube","Pinterest","Email","Web","Out-of-home"] },
  objective: { mode: "single", picks: ["Brand awareness","Product launch","Conversion / sales","Lead generation","Re-engagement / winback","Recruiting / employer brand"] },
  campaign: { mode: "single", picks: ["Spring collection","Summer campaign","New Year","Valentine's Day","Mother's / Father's Day","Pride","Black Friday","Holiday gifting"], custom: "text" },
  audience: { mode: "text", placeholder: "e.g. Women 28–45, design-conscious, US & UK" },
  keyMessage: { mode: "message-cta", ctaPicks: ["Shop now","Learn more","Sign up","Subscribe","Get started","Try free","Book a demo","Download","Pre-order"] },
  tone: { mode: "single", picks: ["Playful / fun","Premium / luxury","Confident / bold","Warm / friendly","Minimalist / understated","Edgy / disruptive"], custom: "text" },
  aspectRatios: { mode: "multi", picks: ["1:1 (square)","4:5 (portrait)","9:16 (vertical)","16:9 (landscape)","2:3 (Pinterest)","3:2 (FB link)","All standard social"] },
  mustInclude: { mode: "multi", picks: ["Logo","Product shot","Offer / promo code","CTA button","Model / person","Tagline","Social handle","Hashtag","Packaging","Badge","Legal / disclaimer"] },
  mustAvoid: { mode: "text", placeholder: "e.g. no stock imagery, avoid greens" },
  language: { mode: "single", picks: ["English","Spanish","French","German","Portuguese","Italian","Japanese"], custom: "text" },
  product: { mode: "text", placeholder: "e.g. Replenish Serum — 30ml" },
  references: { mode: "text", placeholder: "Paste URLs, one per line" },
};

const Chip = ({ chipKey, label, value, filled, onEdit, onRemove, optional }) => {
  const ref = useRef(null);
  return (
    <button
      ref={ref}
      className={"chip " + (optional ? "optional " : "") + (filled ? "filled " : "")}
      onClick={(e) => onEdit && onEdit(e, ref)}
      type="button"
    >
      {filled && <span className="check"><Icon name="check" size={8} stroke={2.5} /></span>}
      <span>{filled ? value : label}</span>
      {filled && onRemove && (
        <span
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ marginLeft: 2, opacity: 0.5, display: "inline-flex" }}
          aria-label="Remove"
        >
          <Icon name="x" size={11} />
        </span>
      )}
    </button>
  );
};

const ChipEditor = ({ chipKey, current, onSave, onClose, anchor }) => {
  const spec = SUGGESTIONS[chipKey] || { mode: "text" };
  const initial = current?.value ?? "";
  const [val, setVal] = useState(initial);
  const [multi, setMulti] = useState(() => {
    if (spec.mode !== "multi") return new Set();
    return new Set(initial ? initial.split(", ").filter(Boolean) : []);
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [customVal, setCustomVal] = useState("");
  // key-message: split into {message, cta}
  const [msg, setMsg] = useState(() => {
    if (spec.mode !== "message-cta") return "";
    const m = initial.match(/^(.*?)(?:\s*·\s*CTA:\s*(.+))?$/);
    return (m && m[1]) || "";
  });
  const [cta, setCta] = useState(() => {
    if (spec.mode !== "message-cta") return "";
    const m = initial.match(/CTA:\s*(.+)$/);
    return (m && m[1]) || "";
  });

  const pos = useMemo(() => {
    if (!anchor?.current) return { top: 0, left: 0 };
    const r = anchor.current.getBoundingClientRect();
    return { top: r.bottom + 6, left: r.left };
  }, [anchor]);

  const commit = (v) => { onSave(v); onClose(); };
  const label = [...REQUIRED_CHIPS, ...OPTIONAL_CHIP_DEFS].find((c) => c.key === chipKey)?.label || chipKey;

  const saveMulti = () => commit([...multi].join(", "));
  const saveMsgCta = () => {
    if (!msg && !cta) return commit("");
    commit(cta ? `${msg || "—"} · CTA: ${cta}` : msg);
  };

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Width by mode
  const width = (spec.mode === "multi" || spec.mode === "message-cta") ? 340
               : spec.mode === "single" ? 300
               : spec.mode === "single-num" ? 280
               : 280;

  // Clamp horizontal so it doesn't overflow viewport
  const left = Math.min(pos.left, window.innerWidth - width - 16);

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 49 }} onClick={onClose}/>
      <div className="chip-editor chip-editor-rich" style={{ position: "fixed", top: pos.top, left, width, zIndex: 50, maxHeight: `calc(100vh - ${pos.top + 16}px)`, overflowY: "auto" }}>
        <label>{label}</label>

        {/* ===== numeric picker ===== */}
        {spec.mode === "single-num" && (
          <>
            <div className="picker-grid">
              {spec.picks.map((p) => (
                <button key={p} className={"picker-pill " + (val === p + (spec.suffix||"") ? "on" : "")}
                  onClick={() => commit(p + (spec.suffix||""))}>{p}</button>
              ))}
              <button className={"picker-pill picker-custom " + (customOpen ? "on" : "")} onClick={() => setCustomOpen(true)}>Custom</button>
            </div>
            {customOpen && (
              <div style={{display: "flex", gap: 6, marginTop: 6}}>
                <input type="number" min="1" placeholder="e.g. 7" value={customVal} onChange={(e) => setCustomVal(e.target.value)} autoFocus/>
                <button className="btn btn-sm btn-primary" disabled={!customVal} onClick={() => commit(customVal + (spec.suffix||""))}>Add</button>
              </div>
            )}
          </>
        )}

        {/* ===== single-select pills ===== */}
        {spec.mode === "single" && (
          <>
            <div className="picker-grid">
              {spec.picks.map((p) => (
                <button key={p} className={"picker-pill " + (val === p ? "on" : "")} onClick={() => commit(p)}>{p}</button>
              ))}
              {spec.custom === "date" && (
                <button className={"picker-pill picker-custom " + (customOpen ? "on" : "")} onClick={() => setCustomOpen(true)}>Pick a date</button>
              )}
              {spec.custom === "text" && (
                <button className={"picker-pill picker-custom " + (customOpen ? "on" : "")} onClick={() => setCustomOpen(true)}>Other…</button>
              )}
            </div>
            {customOpen && spec.custom === "date" && (
              <div style={{display: "flex", gap: 6, marginTop: 8}}>
                <input type="date" value={customVal} onChange={(e) => setCustomVal(e.target.value)} autoFocus/>
                <button className="btn btn-sm btn-primary" disabled={!customVal} onClick={() => {
                  const d = new Date(customVal);
                  commit("Due " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
                }}>Set</button>
              </div>
            )}
            {customOpen && spec.custom === "text" && (
              <div style={{display: "flex", gap: 6, marginTop: 8}}>
                <input placeholder={`Custom ${label.toLowerCase()}`} value={customVal} onChange={(e) => setCustomVal(e.target.value)} autoFocus/>
                <button className="btn btn-sm btn-primary" disabled={!customVal} onClick={() => commit(customVal)}>Add</button>
              </div>
            )}
          </>
        )}

        {/* ===== multi-select pills ===== */}
        {spec.mode === "multi" && (
          <>
            <div className="picker-grid">
              {spec.picks.map((p) => {
                const on = multi.has(p);
                return (
                  <button key={p} className={"picker-pill " + (on ? "on" : "")}
                    onClick={() => {
                      const next = new Set(multi);
                      on ? next.delete(p) : next.add(p);
                      setMulti(next);
                    }}>
                    {on && <span style={{marginRight: 4, display: "inline-flex"}}><Icon name="check" size={10} stroke={2.5}/></span>}
                    {p}
                  </button>
                );
              })}
            </div>
            <div className="chip-editor-actions">
              <button className="btn btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" disabled={multi.size === 0} onClick={saveMulti}>
                Save {multi.size > 0 && <span style={{opacity: 0.7}}>· {multi.size}</span>}
              </button>
            </div>
          </>
        )}

        {/* ===== message + CTA ===== */}
        {spec.mode === "message-cta" && (
          <>
            <div className="editor-sub">Key message</div>
            <textarea rows={2} placeholder="What's the message? One line is great."
              value={msg} onChange={(e) => setMsg(e.target.value)} autoFocus
              style={{resize: "none", padding: "7px 10px", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", background: "var(--surface)", fontSize: 13, fontFamily: "var(--font-sans)", color: "var(--ink)", outline: "none"}}/>
            <div className="editor-sub" style={{marginTop: 6}}>CTA</div>
            <div className="picker-grid">
              {spec.ctaPicks.map((p) => (
                <button key={p} className={"picker-pill " + (cta === p ? "on" : "")} onClick={() => setCta(cta === p ? "" : p)}>{p}</button>
              ))}
            </div>
            <div className="chip-editor-actions">
              <button className="btn btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={saveMsgCta}>Save</button>
            </div>
          </>
        )}

        {/* ===== free text ===== */}
        {spec.mode === "text" && (
          <>
            {chipKey === "references" || chipKey === "mustAvoid" || chipKey === "audience" ? (
              <textarea rows={3} placeholder={spec.placeholder} value={val} onChange={(e) => setVal(e.target.value)} autoFocus
                style={{resize: "none", padding: "7px 10px", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", background: "var(--surface)", fontSize: 13, fontFamily: "var(--font-sans)", color: "var(--ink)", outline: "none"}}/>
            ) : (
              <input placeholder={spec.placeholder} value={val} onChange={(e) => setVal(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") commit(val); }}/>
            )}
            <div className="chip-editor-actions">
              <button className="btn btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={() => commit(val)}>Save</button>
            </div>
          </>
        )}
      </div>
    </>
  );
};

const MissingFieldsModal = ({ missing, onClose, onFocusChip }) => {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "color-mix(in oklab, var(--ink) 35%, transparent)",
        backdropFilter: "blur(4px)",
        display: "grid", placeItems: "center", padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-lg)",
          padding: "24px 24px 20px",
          animation: "popIn 220ms var(--ease-out)",
        }}
      >
        <div style={{display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14}}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%",
            background: "var(--accent-tint)", color: "var(--accent-ink)",
            display: "grid", placeItems: "center", flex: "0 0 auto",
          }}>
            <Icon name="sparkles" size={16}/>
          </div>
          <div style={{minWidth: 0}}>
            <div style={{
              fontFamily: "var(--font-serif)", fontSize: 24, lineHeight: 1.15,
              letterSpacing: "-0.01em", marginBottom: 4, color: "var(--ink)",
            }}>
              A few details before we send this
            </div>
            <div style={{fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.5}}>
              Please fill these fields so your creative lead has what they need to kick things off.
            </div>
          </div>
        </div>
        <div style={{display: "flex", flexDirection: "column", gap: 0, marginBottom: 18, borderTop: "1px solid var(--line-2)"}}>
          {missing.map((m) => (
            <button
              key={m.key}
              onClick={() => onFocusChip(m.key)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "11px 4px",
                borderBottom: "1px solid var(--line-2)",
                fontSize: 13.5, color: "var(--ink-2)", fontWeight: 500, textAlign: "left",
              }}
            >
              <span style={{
                width: 18, height: 18, borderRadius: "50%",
                border: "1.5px dashed var(--ink-5)", flex: "0 0 auto",
              }}/>
              <span style={{flex: 1}}>{m.label}</span>
              <span style={{color: "var(--ink-4)"}}><Icon name="arrow-right" size={13}/></span>
            </button>
          ))}
        </div>
        <div style={{display: "flex", justifyContent: "flex-end", gap: 8}}>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-sm btn-primary" onClick={() => missing[0] && onFocusChip(missing[0].key)}>
            Fill {missing[0]?.label?.toLowerCase()}
            <Icon name="arrow-right" size={12}/>
          </button>
        </div>
      </div>
    </div>
  );
};

const AddDetailPopover = ({ used, onPick, onClose, anchor }) => {
  const pos = useMemo(() => {
    if (!anchor?.current) return { top: 0, left: 0 };
    const r = anchor.current.getBoundingClientRect();
    return { top: r.bottom + 6, left: r.left };
  }, [anchor]);
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 49 }} onClick={onClose}/>
      <div className="popover" style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 50, maxHeight: `calc(100vh - ${pos.top + 16}px)`, overflowY: "auto" }}>
        <div className="opt-head">Add a detail</div>
        {OPTIONAL_CHIP_DEFS.map((o) => (
          <button key={o.key} className={"opt " + (used.has(o.key) ? "used" : "")} onClick={() => onPick(o.key)}>
            <Icon name="plus" size={12} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </>
  );
};

const HomeView = ({ setRoute, pushTask, requireAuth, auth }) => {
  const [text, setText] = useState("");
  const [manual, setManual] = useState({}); // chipKey -> { value }
  const [removed, setRemoved] = useState(new Set()); // chipKeys user explicitly cleared
  const [editing, setEditing] = useState(null); // { key, anchor }
  const [addOpen, setAddOpen] = useState(false);
  const [extraChips, setExtraChips] = useState(new Set()); // user-added optional chips (shown even when empty)
  const [submitted, setSubmitted] = useState(null);
  const addRef = useRef(null);
  const variant = window.LR_TWEAKS?.heroVariant || "gradient";

  const detected = useMemo(() => parseBrief(text), [text]);

  // merge detected + manual (manual takes precedence)
  const chips = useMemo(() => {
    const out = {};
    for (const k of [...REQUIRED_CHIPS.map((c) => c.key), ...OPTIONAL_CHIP_DEFS.map((c) => c.key)]) {
      if (removed.has(k)) continue;
      if (manual[k]) out[k] = manual[k];
      else if (detected[k]) out[k] = detected[k];
    }
    return out;
  }, [detected, manual, removed]);

  const allRequiredFilled = REQUIRED_CHIPS.every((r) => chips[r.key] && chips[r.key].value);
  // Button enables as soon as there's text; click-time validation handles the rest.
  const hasText = text.trim().length > 0;
  const canSubmit = !submitted && hasText;
  const [missingOpen, setMissingOpen] = useState(false);

  const optionalShown = useMemo(() => {
    const s = new Set(extraChips);
    for (const o of OPTIONAL_CHIP_DEFS) if (chips[o.key]) s.add(o.key);
    return [...s];
  }, [extraChips, chips]);

  const chipValue = (k) => {
    const c = chips[k];
    if (!c) return null;
    if (k === "count") return `${c.value} ${c.unit || ""}`.trim();
    if (k === "deadline") return `Due ${c.value}`;
    return c.value;
  };

  const handleEditChip = (key, anchor) => setEditing({ key, anchor });
  const handleSaveChip = (key, val) => {
    if (!val) {
      setManual((m) => { const n = { ...m }; delete n[key]; return n; });
      setRemoved((r) => new Set([...r, key]));
    } else {
      if (key === "count") {
        const n = parseInt(val, 10) || 1;
        setManual((m) => ({ ...m, [key]: { value: n, unit: "creatives" } }));
      } else if (key === "deadline") {
        setManual((m) => ({ ...m, [key]: { value: val.replace(/^due\s*/i, "") } }));
      } else {
        setManual((m) => ({ ...m, [key]: { value: val } }));
      }
      setRemoved((r) => { const n = new Set(r); n.delete(key); return n; });
    }
  };
  const handleRemoveChip = (key) => {
    setManual((m) => { const n = { ...m }; delete n[key]; return n; });
    setExtraChips((s) => { const n = new Set(s); n.delete(key); return n; });
    setRemoved((r) => new Set([...r, key]));
  };

  const applyTemplate = (t) => {
    setText(t.text);
    setRemoved(new Set());
    setManual({});
  };

  const handleSubmit = () => {
    if (!canSubmit) return;

    // Gate on required fields first — for both guests and signed-in users.
    if (!allRequiredFilled) {
      setMissingOpen(true);
      return;
    }

    // Do the actual submit — takes an auth profile (fresh from sign-in, or null)
    const doSubmit = async (profile) => {
      const who = profile?.name || auth?.name || MOCK.people.you.name;
      const name = who.split(" ")[0];
      const accountId = profile?.account?.id || auth?.account?.id;
      if (!accountId) {
        alert("No brand workspace found on your account — contact L+R to finish setup.");
        return;
      }
      const chipSnapshot = {};
      for (const [k, v] of Object.entries(chips)) chipSnapshot[k] = v;
      try {
        const newTask = await submitTask({
          accountId,
          userId: profile?.id || auth?.id,
          text,
          chips: chipSnapshot,
        });
        pushTask(newTask);
        setSubmitted({ task: newTask, name });
      } catch (e) {
        console.error('submitTask failed', e);
        alert(`Couldn't send your brief: ${e.message || e}`);
      }
    };

    if (!auth) {
      // Guest — pause here and prompt sign-in. Draft chips + text remain intact.
      requireAuth?.("Sign in to send this brief — we've saved your draft.", doSubmit);
      return;
    }
    doSubmit(auth);
  };

  return (
    <div className="home-stage" data-variant={variant}>
      <div className="home-inner">
        <div className="greeting">
          <span className="status-dot"/>
          {auth
            ? `Hello, ${(auth.name || MOCK.people.you.name).split(" ")[0]} — it's a quiet morning at L+R`
            : "Welcome to L+R — a calmer way to brief your agency"}
        </div>

        <h1 className="home-title">
          {auth ? <>What can we do for <em>you</em> today?</> : <>What can we <em>make</em> for you today?</>}
        </h1>
        <p className="home-sub" style={{fontSize: 13, color: "rgb(154, 152, 154)"}}>Describe your creative need in plain language. Attach references if you have them. We'll parse the brief and get a creative lead on it within 24 hours.</p>

        <div style={{display: "flex", justifyContent: "flex-end", marginBottom: 10}}>
          <button className="btn btn-sm">
            <Icon name="calendar" size={13} />
            Schedule a call
          </button>
        </div>

        <div className="composer">
          <textarea
            placeholder="Describe your creative need…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            disabled={!!submitted}
          />
          <div className="composer-actions">
            <button className="composer-icon-btn" title="Attach reference"><Icon name="paperclip" size={16} /></button>
            <button
              className="composer-send"
              disabled={!canSubmit}
              data-ready={canSubmit}
              onClick={handleSubmit}
            >
              <span>Submit Request</span>
              <Icon name="arrow-right" size={13} />
            </button>
          </div>
        </div>

        {/* Required chips */}
        <div className="chip-row">
          <span className="chip-row-label">Brief</span>
          {REQUIRED_CHIPS.map((c) => {
            const filled = !!chips[c.key];
            return (
              <Chip
                key={c.key}
                chipKey={c.key}
                label={c.placeholder}
                value={chipValue(c.key)}
                filled={filled}
                onEdit={(e, ref) => handleEditChip(c.key, ref)}
                onRemove={filled ? () => handleRemoveChip(c.key) : null}
              />
            );
          })}
        </div>

        {/* Optional chips */}
        {(optionalShown.length > 0 || true) && (
          <div className="chip-row" style={{ paddingTop: 0 }}>
            <span className="chip-row-label">Optional</span>
            {optionalShown.map((key) => {
              const def = OPTIONAL_CHIP_DEFS.find((o) => o.key === key);
              const filled = !!chips[key];
              return (
                <Chip
                  key={key}
                  chipKey={key}
                  label={def?.label || key}
                  value={chipValue(key)}
                  filled={filled}
                  optional
                  onEdit={(e, ref) => handleEditChip(key, ref)}
                  onRemove={() => handleRemoveChip(key)}
                />
              );
            })}
            <button
              ref={addRef}
              className="chip chip-add"
              onClick={() => setAddOpen(true)}
              type="button"
            >
              <Icon name="plus" size={12} />
              <span>Add detail</span>
            </button>
          </div>
        )}

        {/* Acknowledgment */}
        {submitted && (
          <div className="ack-wrap">
            <div className="ack-bubble">
              <span className="who">L</span>
              <div>
                <div style={{ fontSize: 11, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4, fontWeight: 500 }}>L+R · Just now</div>
                Thanks, {submitted.name} — we've got your brief. Your creative lead will follow up here within 24 hours with a kickoff and timeline.
              </div>
            </div>
            <div className="ack-card" onClick={() => setRoute({ view: "tasks", id: submitted.task.id })}>
              <div className="thumb"><Icon name="sparkles" size={18} /></div>
              <div>
                <div className="title">{submitted.task.title}</div>
                <div className="meta"><StatusBadge status="brief" /> · Opened just now</div>
              </div>
              <span className="arrow"><Icon name="arrow-right" size={16} /></span>
            </div>
          </div>
        )}

        {/* Template suggestions */}
        {!submitted && (
          <div className="template-section">
            <div className="template-label">Start from a template</div>
            <div className="templates">
              {MOCK.templates.map((t) => (
                <button key={t.text} className="template-chip" onClick={() => applyTemplate(t)}>
                  <Icon name={t.icon} size={13} />
                  {t.text}
                </button>
              ))}
            </div>
            <a className="browse-past" onClick={() => setRoute({ view: "tasks" })}>
              Or browse past briefs <Icon name="arrow-right" size={13} />
            </a>
          </div>
        )}
      </div>

      {/* Popovers */}
      {editing && (
        <ChipEditor
          chipKey={editing.key}
          current={chips[editing.key]}
          onSave={(v) => handleSaveChip(editing.key, v)}
          onClose={() => setEditing(null)}
          anchor={editing.anchor}
        />
      )}
      {missingOpen && (
        <MissingFieldsModal
          missing={REQUIRED_CHIPS.filter((r) => !(chips[r.key] && chips[r.key].value))}
          onClose={() => setMissingOpen(false)}
          onFocusChip={(key) => {
            setMissingOpen(false);
            setTimeout(() => {
              const defLabel = REQUIRED_CHIPS.find((c) => c.key === key)?.placeholder;
              const nodes = document.querySelectorAll(".chip");
              const target = [...nodes].find((el) => el.textContent.trim() === defLabel);
              if (target) {
                target.scrollIntoView({ block: "center", behavior: "smooth" });
                setEditing({ key, anchor: { current: target } });
              }
            }, 60);
          }}
        />
      )}
      {addOpen && (
        <AddDetailPopover
          used={new Set(optionalShown)}
          onPick={(k) => {
            setExtraChips((s) => new Set([...s, k]));
            setAddOpen(false);
            setTimeout(() => {
              const node = document.querySelectorAll(".chip");
              // last chip = the one we just added
              const target = [...node].findLast((el) => el.textContent.trim() === (OPTIONAL_CHIP_DEFS.find((o) => o.key === k)?.label));
              if (target) setEditing({ key: k, anchor: { current: target } });
            }, 20);
          }}
          onClose={() => setAddOpen(false)}
          anchor={addRef}
        />
      )}
    </div>
  );
};

export { HomeView };
