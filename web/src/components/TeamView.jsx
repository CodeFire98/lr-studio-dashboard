/* eslint-disable */
/* Team — org-wide collaborators */
import React, { useState } from 'react';
import { Icon } from './Icon.jsx';
import { Avatar, Modal } from './primitives.jsx';
import MOCK from '../lib/mockData.js';

const TeamView = () => {
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <div className="view"><div className="view-inner">
      <div className="page-head">
        <div className="titles">
          <h1>Team</h1>
          <div className="sub">Everyone at Luma who can access L+R. Task-specific roles are managed inside each task.</div>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setInviteOpen(true)}>
            <Icon name="invite" size={14}/>Invite teammate
          </button>
        </div>
      </div>

      <div className="team-list">
        <div className="team-row is-head">
          <div>Name</div>
          <div>Email</div>
          <div>Role</div>
          <div></div>
        </div>
        {MOCK.team.map((m) => (
          <div className="team-row" key={m.id}>
            <div className="who">
              <Avatar person={m}/>
              <div>
                <div className="name">{m.name}</div>
                {m.status === "Pending" && <div style={{fontSize: 11, color: "var(--warn)"}}>Invite pending</div>}
              </div>
            </div>
            <div style={{fontSize: 13, color: "var(--ink-3)"}}>{m.email}</div>
            <div>
              <span className={"role-pill " + (m.role === "Admin" ? "admin" : "")}>
                <span className="sdot" style={{width: 5, height: 5, borderRadius: 5, background: "currentColor", opacity: 0.7}}/>
                {m.role}
              </span>
            </div>
            <div style={{color: "var(--ink-4)"}}><Icon name="more" size={16}/></div>
          </div>
        ))}
      </div>

      {inviteOpen && (
        <Modal onClose={() => setInviteOpen(false)}>
          <h3>Invite a teammate</h3>
          <p>They'll get access to all tasks under Luma by default. You can tighten permissions per task.</p>
          <div className="row">
            <input placeholder="teammate@luma.co"/>
            <select defaultValue="Requester">
              <option>Admin</option>
              <option>Requester</option>
              <option>Reviewer</option>
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setInviteOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => setInviteOpen(false)}>Send invite</button>
          </div>
        </Modal>
      )}
    </div></div>
  );
};

export { TeamView };
