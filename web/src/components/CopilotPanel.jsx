// =====================================================================
// CopilotPanel.jsx — Agency-side AI Co-pilot sidebar drawer
// =====================================================================
//
// Right-edge slide-in panel for chatting with the AI Co-pilot. Triggered
// from the topbar "✨ Co-pilot" button (App.jsx) when:
//   - The user is agency staff
//   - A brand is selected in BrandPicker (not All-clients mode)
//   - The active brand is in VITE_AI_COPILOT_BRAND_IDS allowlist
//
// All chat state lives here — message history is in-memory, reset when
// the panel unmounts (or the brand changes). No persistence in PR 2;
// that's a follow-up if anyone asks.
//
// Streaming: hits /api/ai/chat with the user's JWT, reads the SSE event
// stream, dispatches to the right renderer (text deltas, tool_call cards,
// tool_result cards, usage stats).
//
// Tools available in PR 2:
//   - create_post_plan_draft — Co-pilot writes a real post_plans row
//     with status='drafting', ai_generated=true. We render a card with
//     an "Open plan" button that navigates the user there.
// =====================================================================

/* eslint-disable */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Icon } from './Icon.jsx';
import { supabase } from '../lib/supabase.js';

// SSE-style event-stream reader. Vercel buffers serverless function
// responses by default, so we set X-Accel-Buffering: no on the server.
// Events arrive as:
//   event: <type>\n
//   data: <json>\n
//   \n
async function* parseSse(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); }
      catch { continue; }
      yield { event, data: parsed };
    }
  }
}

// Conversations are persisted to localStorage so closing the panel — or
// switching brands and switching back — doesn't lose history. Keyed by
// (userId, accountId) so different agency staff on the same browser get
// their own threads, and each brand has its own conversation context.
// Capped at MAX_PERSISTED_MESSAGES to keep localStorage from growing
// unboundedly; oldest user-message-and-response pairs drop off first.
const MAX_PERSISTED_MESSAGES = 60;
const storageKey = (userId, accountId) => `lr_copilot_conv_${userId}_${accountId}`;

function loadPersistedMessages(userId, accountId) {
  if (!userId || !accountId) return [];
  try {
    const raw = localStorage.getItem(storageKey(userId, accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistMessages(userId, accountId, messages) {
  if (!userId || !accountId) return;
  try {
    const trimmed = messages.length > MAX_PERSISTED_MESSAGES
      ? messages.slice(messages.length - MAX_PERSISTED_MESSAGES)
      : messages;
    localStorage.setItem(storageKey(userId, accountId), JSON.stringify(trimmed));
  } catch {
    // localStorage full / unavailable — drop the persistence silently.
    // Chat still works in-memory; only the cross-session continuity breaks.
  }
}

const CopilotPanel = ({ accountId, brandName, userId, onClose, onNavigateToPlan, brandSlug }) => {
  // Each message: { id, role, content, parts? }
  //   role: 'user' | 'assistant' | 'system'
  //   content: text for user; for assistant, the streamed text so far
  //   parts: array of { type: 'tool_call' | 'tool_result', ... } interleaved with text
  const [messages, setMessages] = useState(() => loadPersistedMessages(userId, accountId));
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null); // { input, output, cacheRead, cacheWrite }
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // When the brand changes, swap to that brand's persisted conversation.
  // (User changes are rare — same user keeps their threads — but we key on
  // both so multi-staff sessions on the same browser stay separate.)
  useEffect(() => {
    setMessages(loadPersistedMessages(userId, accountId));
    setError('');
    setUsage(null);
  }, [accountId, userId]);

  // Persist on every message change. Trimmed in persistMessages.
  useEffect(() => {
    persistMessages(userId, accountId, messages);
  }, [userId, accountId, messages]);

  // Cancel in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // "Start new" — clear the current brand's conversation. Confirms first
  // since this is destructive (no undo).
  const startNew = () => {
    if (streaming) {
      abortRef.current?.abort();
      setStreaming(false);
    }
    if (messages.length > 0 && !window.confirm('Start a new conversation? The current one will be cleared.')) {
      return;
    }
    setMessages([]);
    setError('');
    setUsage(null);
    try {
      localStorage.removeItem(storageKey(userId, accountId));
    } catch {
      // ignore
    }
  };

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || streaming) return;

    setDraft('');
    setError('');
    const userMsg = { id: `u-${Date.now()}`, role: 'user', content: text, parts: [] };
    const assistantMsg = { id: `a-${Date.now()}`, role: 'assistant', content: '', parts: [] };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    // Build the payload — entire history except the empty placeholder we just pushed.
    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ accountId, messages: history }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(errBody.error || `HTTP ${resp.status}`);
      }

      for await (const evt of parseSse(resp)) {
        if (evt.event === 'text') {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content + (evt.data.delta || '') }
              : m
          ));
        } else if (evt.event === 'tool_call') {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  parts: [...m.parts, {
                    type: 'tool_call',
                    id: evt.data.id,
                    name: evt.data.name,
                    input: evt.data.input,
                    status: 'running',
                  }],
                  // Pin position by inserting a text snapshot marker — tool cards render after the current text.
                  contentAtToolCall: (m.contentAtToolCall || []).concat([{ id: evt.data.id, length: m.content.length }]),
                }
              : m
          ));
        } else if (evt.event === 'tool_result') {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  parts: m.parts.map((p) =>
                    p.id === evt.data.id
                      ? { ...p, type: 'tool_result', status: evt.data.ok ? 'ok' : 'error', result: evt.data.result, error: evt.data.error }
                      : p
                  ),
                }
              : m
          ));
        } else if (evt.event === 'usage') {
          setUsage({
            input: evt.data.input_tokens,
            output: evt.data.output_tokens,
            cacheRead: evt.data.cache_read_input_tokens,
            cacheWrite: evt.data.cache_creation_input_tokens,
          });
        } else if (evt.event === 'error') {
          setError(evt.data.error || 'Unknown error');
        } else if (evt.event === 'done') {
          // Just close the stream.
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message || String(err));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [draft, streaming, accountId, messages]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  return (
    <div className="copilot-panel" role="dialog" aria-label="AI Co-pilot">
      <header className="copilot-header">
        <div>
          <h4>
            <span className="copilot-spark" aria-hidden>✨</span>
            <span>Co-pilot</span>
          </h4>
          <div className="copilot-sub">{brandName || 'Brand'}</div>
        </div>
        <div className="copilot-header-actions">
          {messages.length > 0 && (
            <button
              className="copilot-header-btn"
              onClick={startNew}
              title="Start a new conversation"
            >
              Start new
            </button>
          )}
          <button className="copilot-close" onClick={onClose} aria-label="Close Co-pilot">
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <div className="copilot-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="copilot-welcome">
            <p>Hi! I'm your Co-pilot for <strong>{brandName || 'this brand'}</strong>.</p>
            <p>Ask me to draft a post, plan next week's content, or brainstorm a campaign — I'll create real drafts in the Social Calendar that you can edit and submit.</p>
            <div className="copilot-suggestions">
              {[
                'Draft an Instagram post about our newest product for next Tuesday at 10am',
                'Plan three posts for next week across IG and LinkedIn',
                'Brainstorm a campaign concept for the holiday season',
              ].map((s, i) => (
                <button
                  key={i}
                  className="copilot-suggestion"
                  onClick={() => { setDraft(s); textareaRef.current?.focus(); }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`copilot-msg copilot-msg-${m.role}`}>
            {m.role === 'user' ? (
              <div className="copilot-bubble">{m.content}</div>
            ) : (
              <>
                {m.content && <div className="copilot-prose">{renderProse(m.content)}</div>}
                {m.parts.map((p) => (
                  <ToolCard key={p.id} part={p} onNavigateToPlan={onNavigateToPlan} brandSlug={brandSlug} />
                ))}
              </>
            )}
          </div>
        ))}

        {streaming && messages.length > 0 && (
          <div className="copilot-typing">
            <span className="copilot-dot" />
            <span className="copilot-dot" />
            <span className="copilot-dot" />
          </div>
        )}

        {error && (
          <div className="copilot-error">
            <Icon name="alert" size={12} /> {error}
          </div>
        )}
      </div>

      <footer className="copilot-input">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={streaming ? 'Generating…' : 'Message the Co-pilot…  (⌘↩ to send)'}
          disabled={streaming}
          rows={2}
        />
        <div className="copilot-input-row">
          <div className="copilot-meta">
            {usage && (
              <span title="input / output tokens (cache reads in parens)">
                {usage.input ?? 0} in {usage.cacheRead ? `(${usage.cacheRead} cached)` : ''} · {usage.output ?? 0} out
              </span>
            )}
          </div>
          {streaming ? (
            <button className="copilot-send copilot-cancel" onClick={cancel}>Stop</button>
          ) : (
            <button
              className="copilot-send"
              onClick={sendMessage}
              disabled={!draft.trim()}
            >
              Send
            </button>
          )}
        </div>
      </footer>
    </div>
  );
};

// Render assistant prose with minimal markdown — paragraphs + bold + inline code.
// Deliberately conservative; we don't want a full markdown engine for this panel.
function renderProse(text) {
  const parts = text.split(/\n\n+/);
  return parts.map((p, i) => (
    <p key={i}>{inlineMd(p)}</p>
  ));
}

function inlineMd(text) {
  // Split on **bold** and `code` while preserving order.
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      out.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<code key={`c-${key++}`}>{token.slice(1, -1)}</code>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const ToolCard = ({ part, onNavigateToPlan, brandSlug }) => {
  const isPlan = part.name === 'create_post_plan_draft';
  const planId = isPlan && part.status === 'ok' ? part.result?.id : null;
  const headline = part.status === 'running'
    ? (isPlan ? 'Drafting a post plan…' : `Running ${part.name}…`)
    : part.status === 'ok'
      ? (isPlan ? 'Created an AI draft plan' : `Ran ${part.name}`)
      : `${part.name} failed`;

  return (
    <div className={`copilot-tool copilot-tool-${part.status}`}>
      <div className="copilot-tool-head">
        <Icon name={part.status === 'running' ? 'sparkles' : part.status === 'ok' ? 'check' : 'alert'} size={12} />
        <span>{headline}</span>
      </div>
      {isPlan && part.input?.concept && (
        <div className="copilot-tool-body">
          <div className="copilot-tool-concept">{part.input.concept}</div>
          {Array.isArray(part.input.platforms) && (
            <div className="copilot-tool-platforms">
              {part.input.platforms.map((p) => (
                <span key={p} className="copilot-tool-pill">{p}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {part.status === 'error' && part.error && (
        <div className="copilot-tool-error">{part.error}</div>
      )}
      {planId && (
        <button
          className="copilot-tool-cta"
          onClick={() => onNavigateToPlan?.(planId, brandSlug)}
        >
          Open plan →
        </button>
      )}
    </div>
  );
};

export { CopilotPanel };
