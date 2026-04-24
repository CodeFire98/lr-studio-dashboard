/* eslint-disable */
/* Shared primitives: Avatar, AvatarStack, Status, Art (procedural creative placeholder) */
import React, { useEffect, useMemo } from 'react';

const Avatar = ({ person, size = "md", ...rest }) => {
  const cls = size === "lg" ? "avatar avatar-lg" : size === "sm" ? "avatar avatar-sm" : "avatar";
  const bg = person?.avatarColor || "#E8553D";
  // Darken with low opacity overlay feel via gradient
  const style = {
    background: `linear-gradient(135deg, ${bg}, color-mix(in oklab, ${bg} 75%, black))`,
    color: "#fff",
  };
  return (
    <span className={cls} style={style} title={person?.name} {...rest}>
      {person?.initials || "?"}
    </span>
  );
};

const AvatarStack = ({ people, max = 3, size = "md" }) => {
  const shown = people.slice(0, max);
  const overflow = Math.max(0, people.length - max);
  return (
    <span className="avatar-stack">
      {shown.map((p) => <Avatar key={p.id} person={p} size={size} />)}
      {overflow > 0 && (
        <span className={"avatar " + (size === "sm" ? "avatar-sm" : "")} style={{ background: "var(--surface-2)", color: "var(--ink-3)" }}>+{overflow}</span>
      )}
    </span>
  );
};

const STATUS_LABELS = {
  brief: "Brief Received",
  progress: "In Progress",
  review: "In Review",
  delivered: "Delivered",
  revising: "Revising",
};

const StatusBadge = ({ status }) => (
  <span className="status" data-s={status}>
    <span className="sdot" />
    {STATUS_LABELS[status] || status}
  </span>
);

/* Procedural creative art — gradient + type placeholder.
   Takes a 3-color palette and optional labels. */
const Art = ({ palette, kicker, label, variant = 0, pattern }) => {
  const [a, b, c] = palette || ["#F4EBDD", "#E8C9A8", "#1B1F1C"];
  // Choose a composition based on variant
  const v = Math.abs(variant) % 5;
  const id = useMemo(() => "art_" + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="art" style={{ background: a }}>
      <svg width="100%" height="100%" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", inset: 0 }}>
        <defs>
          <linearGradient id={id + "g"} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={b} stopOpacity="0.85"/>
            <stop offset="1" stopColor={a} stopOpacity="0"/>
          </linearGradient>
          <radialGradient id={id + "r"} cx="0.7" cy="0.3" r="0.7">
            <stop offset="0" stopColor={b} stopOpacity="0.9"/>
            <stop offset="1" stopColor={a} stopOpacity="0"/>
          </radialGradient>
        </defs>
        {v === 0 && (<>
          <rect width="400" height="400" fill={`url(#${id}r)`} />
          <circle cx="280" cy="140" r="90" fill={c} opacity="0.08"/>
          <circle cx="280" cy="140" r="70" fill={c} opacity="0.12"/>
          <rect x="40" y="280" width="160" height="40" rx="4" fill={c} opacity="0.1"/>
        </>)}
        {v === 1 && (<>
          <rect width="400" height="400" fill={`url(#${id}g)`} />
          <path d="M0 260 Q 100 200, 200 260 T 400 260 L 400 400 L 0 400 Z" fill={c} opacity="0.18"/>
          <circle cx="120" cy="120" r="60" fill={b} opacity="0.6"/>
        </>)}
        {v === 2 && (<>
          <rect width="400" height="400" fill={a} />
          <rect x="30" y="30" width="340" height="340" rx="16" fill="none" stroke={c} strokeOpacity="0.15"/>
          <circle cx="200" cy="210" r="110" fill={b} opacity="0.7"/>
          <circle cx="200" cy="210" r="110" fill="none" stroke={c} strokeOpacity="0.25"/>
        </>)}
        {v === 3 && (<>
          <rect width="400" height="400" fill={a}/>
          <rect x="0" y="0" width="400" height="210" fill={b} opacity="0.65"/>
          <circle cx="310" cy="120" r="44" fill={c} opacity="0.2"/>
          <rect x="40" y="260" width="200" height="8" rx="4" fill={c} opacity="0.5"/>
          <rect x="40" y="278" width="120" height="6" rx="3" fill={c} opacity="0.25"/>
        </>)}
        {v === 4 && (<>
          <rect width="400" height="400" fill={a}/>
          <g opacity="0.6">
            {Array.from({ length: 9 }).map((_, i) => (
              <circle key={i} cx={50 + (i%3)*150} cy={80 + Math.floor(i/3)*120} r="38" fill={b} opacity={0.3 + (i%4)*0.15} />
            ))}
          </g>
          <circle cx="200" cy="200" r="30" fill={c} opacity="0.9"/>
        </>)}
      </svg>
      {kicker && <span className="kicker" style={{color: `color-mix(in oklab, ${c} 60%, transparent)`}}>{kicker}</span>}
      {label && <span className="label" style={{color: `color-mix(in oklab, ${c} 82%, transparent)`}}>{label}</span>}
    </div>
  );
};

/* Simple modal */
const Modal = ({ onClose, children }) => {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">{children}</div>
    </div>
  );
};

export { Avatar, AvatarStack, StatusBadge, Art, Modal, STATUS_LABELS };
