// =====================================================================
// CopilotPanel.jsx — Agency-side AI Co-pilot sidebar drawer
// =====================================================================
//
// AI Co-pilot v2 Phase 2a: rewritten around `useChat` from @ai-sdk/react +
// selected AI Elements components (Conversation, Message, MessageResponse).
// The custom SSE parser, manual message state, and abort logic from v1
// are all replaced by useChat. Wire protocol on /api/ai/chat is now the
// AI SDK's native UIMessage stream — see web/api/ai/chat.ts for the
// server-side change that ships in the same PR.
//
// Visual identity: panel chrome (header, footer with textarea/send) stays
// on the hand-written `.copilot-*` CSS so it integrates with the rest of
// the dashboard. The message-rendering area inside the scroll is wrapped
// in `<div className="ai-elements">` so the shadcn-themed AI Elements
// components pick up their CSS-variable tokens (scoped block lives in
// web/src/styles/elements.css).
//
// Persistence: messages persist to localStorage keyed by (userId, accountId)
// under a v2 key (`lr_copilot_conv_v2_*`). v1 entries under the old key
// are orphaned — admin starts fresh on first open after deploy. By design;
// v1 message shape was incompatible with the new UIMessage `parts` model.
//
// Triggered from App.jsx topbar "✨ Co-pilot" button. Visibility gated by:
//   - User is agency staff
//   - A brand is selected (not All-clients mode)
//   - The brand is in VITE_AI_COPILOT_BRAND_IDS allowlist
//
// Tools rendered: create_post_plan_draft (with "Open plan →" navigation
// CTA when the tool succeeds), write_brand_note. Both surfaced via the
// UIMessage parts model — each tool call appears as a `tool-{name}` part
// with `state` cycling through input-streaming → input-available →
// output-available (or output-error).
// =====================================================================

/* eslint-disable */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Icon } from "./Icon.jsx";
import { supabase } from "../lib/supabase.js";
// AI Elements' `Conversation` was intentionally dropped from Phase 2a —
// its stick-to-bottom scroll behaviour conflicts with the existing
// `.copilot-scroll` overflow logic. We keep manual auto-scroll via a
// scrollRef + useEffect (same pattern as v1). Reconsider in Phase 3
// if there's a stick-to-bottom UX win that justifies the layout rework.
import { MessageResponse } from "@/components/ai-elements/message";

// localStorage key is v2-prefixed so v1 conversations (incompatible message
// shape) don't crash on load. v1 entries become orphaned and the first
// chat session after this deploy starts fresh — acceptable tradeoff per
// AI_COPILOT_V2_MIGRATION.md.
const MAX_PERSISTED_MESSAGES = 60;
const storageKey = (userId, accountId) => `lr_copilot_conv_v2_${userId}_${accountId}`;

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
    // localStorage full / unavailable — silent drop. Chat still works in-memory.
  }
}

const EMPTY_SUGGESTIONS = [
  "Draft an Instagram post about our newest product for next Tuesday at 10am",
  "Plan three posts for next week across IG and LinkedIn",
  "Brainstorm a campaign concept for the holiday season",
];

const CopilotPanel = ({ accountId, brandName, userId, onClose, onNavigateToPlan, brandSlug }) => {
  // DefaultChatTransport handles auth header injection per request and
  // appends accountId to the request body. Memoized on accountId so brand
  // switches rebuild the transport (otherwise it closes over stale value).
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/chat",
        headers: async () => {
          const { data: { session } } = await supabase.auth.getSession();
          return session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {};
        },
        body: () => ({ accountId }),
      }),
    [accountId],
  );

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
  } = useChat({
    transport,
    onError: (err) => {
      // useChat surfaces the error via the `error` state already; log
      // for debugging without spamming the user.
      // eslint-disable-next-line no-console
      console.error("[Copilot] stream error:", err);
    },
  });

  const [draft, setDraft] = useState("");
  const textareaRef = useRef(null);
  const scrollRef = useRef(null);

  const isBusy = status === "streaming" || status === "submitted";

  // Auto-scroll to bottom when messages or streaming state change.
  // Same pattern as v1; simpler than the AI Elements Conversation
  // stick-to-bottom approach, integrates cleanly with .copilot-scroll's
  // overflow-y: auto.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isBusy]);

  // Hydrate from localStorage on mount and whenever (userId, accountId)
  // change — switching brands swaps to that brand's persisted thread.
  useEffect(() => {
    const persisted = loadPersistedMessages(userId, accountId);
    setMessages(persisted);
  }, [userId, accountId, setMessages]);

  // Persist on every messages-array change. Trimmed in persistMessages.
  useEffect(() => {
    persistMessages(userId, accountId, messages);
  }, [userId, accountId, messages]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    sendMessage({ text });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const startNew = () => {
    if (isBusy) stop();
    if (messages.length > 0 && !window.confirm("Start a new conversation? The current one will be cleared.")) {
      return;
    }
    setMessages([]);
    try {
      localStorage.removeItem(storageKey(userId, accountId));
    } catch {
      // ignore
    }
  };

  // The token-usage meter reads from the LAST assistant message's metadata.
  // The server attaches usage in messageMetadata on the `finish` event —
  // see web/api/ai/chat.ts. Older messages have stale usage relative to
  // the cumulative conversation, so we surface the most recent one.
  const lastUsage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant" && m.metadata?.usage) return m.metadata.usage;
    }
    return null;
  }, [messages]);

  return (
    <div className="copilot-panel" role="dialog" aria-label="AI Co-pilot">
      <header className="copilot-header">
        <div>
          <h4>
            <span className="copilot-spark" aria-hidden>✨</span>
            <span>Co-pilot</span>
          </h4>
          <div className="copilot-sub">{brandName || "Brand"}</div>
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
            <p>Hi! I'm your Co-pilot for <strong>{brandName || "this brand"}</strong>.</p>
            <p>Ask me to draft a post, plan next week's content, or brainstorm a campaign — I'll create real drafts in the Social Calendar that you can edit and submit.</p>
            <div className="copilot-suggestions">
              {EMPTY_SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  className="copilot-suggestion"
                  onClick={() => {
                    setDraft(s);
                    textareaRef.current?.focus();
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`copilot-msg copilot-msg-${m.role}`}>
            {m.parts.map((part, idx) => renderPart(part, idx, m.id, m.role, { onNavigateToPlan, brandSlug }))}
          </div>
        ))}

        {isBusy && messages.length > 0 && (
          <div className="copilot-typing">
            <span className="copilot-dot" />
            <span className="copilot-dot" />
            <span className="copilot-dot" />
          </div>
        )}

        {error && (
          <div className="copilot-error">
            <Icon name="alert" size={12} /> {error.message || String(error)}
          </div>
        )}
      </div>

      <footer className="copilot-input">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isBusy ? "Generating…" : "Message the Co-pilot…  (⌘↩ to send)"}
          disabled={isBusy}
          rows={2}
        />
        <div className="copilot-input-row">
          <div className="copilot-meta">
            {lastUsage && (
              <span title="input / output tokens (cache reads in parens)">
                {lastUsage.input_tokens ?? 0} in {lastUsage.cache_read_input_tokens ? `(${lastUsage.cache_read_input_tokens} cached)` : ""} · {lastUsage.output_tokens ?? 0} out
              </span>
            )}
          </div>
          {isBusy ? (
            <button className="copilot-send copilot-cancel" onClick={stop}>Stop</button>
          ) : (
            <button
              className="copilot-send"
              onClick={handleSend}
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

// renderPart — dispatches a UIMessage `parts[]` entry to the right component.
//
// User messages keep v1's coral-on-white `.copilot-bubble` styling so they
// integrate with the rest of the dashboard's coral palette. Assistant text
// uses AI Elements MessageResponse (Streamdown-backed markdown — proper
// support for headers, lists, code blocks, etc., something v1's tiny
// inline-md parser couldn't do). Both render inside the `.ai-elements`
// wrapper so the Conversation's stick-to-bottom + scroll behaviour works.
//
// Tool parts use our custom ToolCard which preserves v1's visual identity
// (concept + platforms pills for create_post_plan_draft, note body for
// write_brand_note, "Open plan →" CTA when applicable).
function renderPart(part, idx, messageId, role, ctx) {
  if (part.type === "text") {
    if (role === "user") {
      return <div key={`${messageId}-t${idx}`} className="copilot-bubble">{part.text}</div>;
    }
    // `.ai-elements` MUST be tight-scoped to JUST the Streamdown render area.
    // If it covered the scroll surface or the whole message, shadcn's
    // neutral `--accent: 0 0% 96.1%` would override the global coral
    // `--accent: #E8553D` for any descendant using `var(--accent)` —
    // most importantly `.copilot-bubble` (white text on coral). Same
    // regression as Phase 0 hotfix; same fix: keep `.ai-elements` only
    // where shadcn-token-aware components actually render.
    //
    // `controls.table.fullscreen: false` disables Streamdown's table
    // expand-to-modal button — the modal's positioning broke in our
    // panel context (overflowed below the chat with no backdrop). Copy
    // + download buttons stay (useful when AI returns comparison tables).
    return (
      <div key={`${messageId}-t${idx}`} className="copilot-prose ai-elements">
        <MessageResponse controls={{ table: { copy: true, download: true, fullscreen: false } }}>
          {part.text}
        </MessageResponse>
      </div>
    );
  }
  if (part.type === "step-start" || part.type === "step-end") {
    return null; // SDK-internal step markers; we don't render these.
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    const toolName = part.type.slice("tool-".length);
    return (
      <ToolCard
        key={`${messageId}-${part.toolCallId || idx}`}
        toolName={toolName}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText}
        onNavigateToPlan={ctx.onNavigateToPlan}
        brandSlug={ctx.brandSlug}
      />
    );
  }
  return null;
}

// ToolCard — preserves v1's visual identity (compact, headline + minimal
// body, "Open plan →" CTA when the tool succeeded). Reads from the AI
// SDK's UIMessage tool-part shape: `state` cycles through
// 'input-streaming' → 'input-available' → 'output-available' | 'output-error'.
// We treat 'input-streaming' / 'input-available' as "running" visually.
function ToolCard({ toolName, state, input, output, errorText, onNavigateToPlan, brandSlug }) {
  const isPlan = toolName === "create_post_plan_draft";
  const isNote = toolName === "write_brand_note";

  const isRunning = state === "input-streaming" || state === "input-available";
  const isOk = state === "output-available";
  const isError = state === "output-error" || state === "output-denied";

  // Our v1 tool implementations return { ok: true, result } / { ok: false, error }
  // as the execute() return value, which the SDK wraps as `output`. Unwrap
  // for display.
  const inner = output && typeof output === "object" && "ok" in output ? output : null;
  const ok = inner ? inner.ok : isOk;
  const result = inner && inner.ok ? inner.result : null;
  const innerError = inner && !inner.ok ? inner.error : null;
  const displayError = innerError || errorText;

  const planId = isPlan && ok && result?.id ? result.id : null;

  let statusKey = "running";
  if (isError || !ok && inner) statusKey = "error";
  else if (isOk) statusKey = "ok";

  let headline;
  if (statusKey === "running") {
    headline = isPlan
      ? "Drafting a post plan…"
      : isNote
        ? "Saving a brand note…"
        : `Running ${toolName}…`;
  } else if (statusKey === "ok") {
    headline = isPlan
      ? "Created an AI draft plan"
      : isNote
        ? (input?.is_pinned ? "Saved a pinned brand note" : "Saved a brand note")
        : `Ran ${toolName}`;
  } else {
    headline = `${toolName} failed`;
  }

  return (
    <div className={`copilot-tool copilot-tool-${statusKey}`}>
      <div className="copilot-tool-head">
        <Icon name={statusKey === "running" ? "sparkles" : statusKey === "ok" ? "check" : "alert"} size={12} />
        <span>{headline}</span>
      </div>
      {isPlan && input?.concept && (
        <div className="copilot-tool-body">
          <div className="copilot-tool-concept">{input.concept}</div>
          {Array.isArray(input.platforms) && (
            <div className="copilot-tool-platforms">
              {input.platforms.map((p) => (
                <span key={p} className="copilot-tool-pill">{p}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {isNote && input?.body && (
        <div className="copilot-tool-body">
          <div className="copilot-tool-note-body">"{input.body}"</div>
          {input.is_pinned && (
            <div className="copilot-tool-note-pinned">
              <Icon name="check" size={10} /> Pinned — rides on every AI call
            </div>
          )}
        </div>
      )}
      {statusKey === "error" && displayError && (
        <div className="copilot-tool-error">{displayError}</div>
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
}

export { CopilotPanel };
// Default export so React.lazy() in App.jsx can code-split the entire panel
// (and its heavy dependency tree — Streamdown, shiki language packs, mermaid)
// behind admin clicking the topbar Co-pilot trigger.
export default CopilotPanel;
