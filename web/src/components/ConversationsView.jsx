/* eslint-disable */
/* ConversationsView — placeholder for the unified per-brand chat.
   PR 1 (data layer + sidebar plumbing) ships this stub so the new
   sidebar entry has somewhere to land. PR 2 replaces it with the
   actual chat UI: top-level feed + composer + thread drawer. */
import React, { useEffect } from 'react';
import { Icon } from './Icon.jsx';
import { markConversationSeen } from '../lib/db.js';

export default function ConversationsView({ accountId, accountName, userId }) {
  // Mark this brand's conversation as fully seen when the view mounts
  // (or the active brand changes). Clears the sidebar Conversations
  // badge for this user — same pattern as the Calendar View clearing
  // the per-plan dot when a plan is opened. The data already lives in
  // the messages table after migration 0042, so any historical comment
  // backfilled from post_plan_comments counts toward "seen" once a
  // user opens this surface.
  useEffect(() => {
    if (!accountId || !userId) return;
    markConversationSeen({ userId, accountId }).catch((e) =>
      console.warn('markConversationSeen failed', e)
    );
  }, [accountId, userId]);

  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
      <div className="card-head">
        <div>
          <div className="card-title">Conversations</div>
          <div className="card-sub">
            Chat with your {accountName ? <strong>{accountName}</strong> : 'agency'} team in one place.
          </div>
        </div>
      </div>
      <div style={{ padding: '20px 24px 28px', display: 'grid', gap: 16, color: 'var(--ink-2)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--accent)', marginTop: 2 }}>
            <Icon name="chat" size={20} />
          </span>
          <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            We're moving every back-and-forth into a single thread. The chat
            UI lands in the next release — for now, comments still live in
            the <em>Conversation</em> tab inside each post plan.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--accent)', marginTop: 2 }}>
            <Icon name="sparkles" size={20} />
          </span>
          <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            When the chat ships you'll be able to tag a specific post plan
            in any message, reply in threads, and share images, videos, or
            links — all without leaving this page.
          </div>
        </div>
      </div>
    </div>
  );
}
