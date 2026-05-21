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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat, experimental_useObject as useObject } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { z } from "zod";
import { Icon } from "./Icon.jsx";
import { supabase } from "../lib/supabase.js";
import { buildTemplatedCopilotSuggestions } from "../lib/db.js";
import { formatPlanChipTime } from "./ConversationsView.jsx";
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

// Fallback suggestions used while the AI stream hasn't produced its first
// chip yet AND when both AI + templated paths fail. Same three strings
// as v1's hardcoded EMPTY_SUGGESTIONS so a cold first-render doesn't
// show a blank welcome state.
// Hardcoded fallback chips per caller role. Used during the cold first
// render (before the AI stream produces its own chips) and when the
// streaming + templated fallbacks both fail. Agency framing talks
// about planning client content; brand framing is about proposing
// posts the agency will review.
const FALLBACK_SUGGESTIONS_AGENCY = [
  "Draft an Instagram post about our newest product for next Tuesday at 10am",
  "Plan three posts for next week across IG and LinkedIn",
  "Brainstorm a campaign concept for the holiday season",
];
const FALLBACK_SUGGESTIONS_BRAND = [
  "Brainstorm a caption idea for our next launch",
  "Suggest copy variants for next week's Instagram post",
  "What angle should we test for our new product line?",
];

// Mirror of the server's SUGGESTIONS_SCHEMA (web/api/ai/suggestions.ts).
// experimental_useObject parses the streaming JSON deltas into a
// DeepPartial<typeof this>. Schema drops the server-side .describe()
// hints (those are for the model) and the .min(8)/.max(150)/.length(4)
// constraints (those are enforced server-side; the client just needs
// the shape to extract partials).
const SUGGESTIONS_SCHEMA = z.object({
  suggestions: z.array(z.string()),
});

// `variant`:
//   - 'panel' (default): right-side drawer with chrome (header + close
//     button). Mounted from App.jsx when the topbar "✨ Co-pilot" trigger
//     is on. Uses `.copilot-panel` styles in app.css.
//   - 'page': inline full-page render. Used by the new /c/:slug/linkai
//     route. Drops the close button (the sidebar nav owns route changes),
//     widens the layout, and renders a bigger empty-state hero. Uses
//     `.copilot-panel.copilot-panel--page` overrides in app.css.
const CopilotPanel = ({
  accountId,
  brandName,
  userId,
  isAgency = false,
  onClose,
  onNavigateToPlan,
  onCommitDraft,
  brandSlug,
  variant = 'panel',
}) => {
  const isPageVariant = variant === 'page';
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

  // Suggestion chips for the welcome screen.
  //
  // PRIMARY path: experimental_useObject streams JSON deltas from
  // /api/ai/suggestions (server uses streamObject + Haiku 4.5 +
  // temperature 0.9 for variety). The chips render PROGRESSIVELY as
  // each entry's string lands in the partial JSON — same UX pattern
  // as the image-ideas panel. Refresh button re-fires submit().
  //
  // FALLBACK path: when the hook errors (offline, auth, allowlist,
  // brand-kit missing), we fire `buildTemplatedCopilotSuggestions`
  // for deterministic brand-aware chips from Supabase data alone.
  // No AI cost, no streaming, no spinner — just a graceful safety net.
  //
  // FINAL FALLBACK: role-specific hardcoded set (FALLBACK_SUGGESTIONS_AGENCY
  // / _BRAND), so the welcome screen never renders blank even on outage.
  const suggestionsHook = useObject({
    api: "/api/ai/suggestions",
    schema: SUGGESTIONS_SCHEMA,
    fetch: async (url, init) => {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = new Headers(init?.headers);
      if (session?.access_token) {
        headers.set("Authorization", `Bearer ${session.access_token}`);
      }
      return fetch(url, { ...init, headers });
    },
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error("[Copilot/suggestions] stream error:", err);
    },
  });

  // Templated fallback — fires only when the AI hook errors. Stored
  // separately so we can prefer the (more recent) hook output if it
  // recovers on a subsequent refresh.
  const [templatedSuggestions, setTemplatedSuggestions] = useState(null);

  // Accumulated list of every suggestion the admin has been shown across
  // refreshes in this session. We forward it to the server on each
  // refresh so the model can explicitly avoid repeating them — the only
  // reliable way to defeat mode-collapse on identical prompts (temp 0.9
  // alone isn't enough; Anthropic models converge on the same answer for
  // the same prompt). Capped at 16 to keep the prompt small.
  const seenSuggestionsRef = useRef([]);

  // "Refresh in flight" flag. While true, we hide the currently-rendered
  // chips so the admin gets immediate feedback that NEW suggestions are
  // coming — without it, the old chips linger on screen until the new
  // stream's first partial arrives (~500ms), which feels like the refresh
  // did nothing.
  const [refreshingSuggestions, setRefreshingSuggestions] = useState(false);

  // Auto-submit on accountId change (mount + brand switch). Brand
  // switching also clears the templated fallback AND the seen-suggestions
  // history so we don't carry one brand's "avoid these" list into the
  // next brand's generation (would over-constrain the new brand's
  // suggestions for no reason).
  useEffect(() => {
    if (!accountId) return;
    setTemplatedSuggestions(null);
    seenSuggestionsRef.current = [];
    suggestionsHook.submit({ accountId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // On hook error, kick off the templated fallback. Best-effort — if
  // even Supabase fails, the FALLBACK_SUGGESTIONS hardcoded set wins
  // via the derived `suggestions` below.
  useEffect(() => {
    if (!suggestionsHook.error || !accountId) return;
    let cancelled = false;
    buildTemplatedCopilotSuggestions({ accountId })
      .then((rows) => {
        if (cancelled) return;
        if (Array.isArray(rows) && rows.length > 0) setTemplatedSuggestions(rows);
      })
      .catch(() => { /* swallow — FALLBACK_SUGGESTIONS will render */ });
    return () => { cancelled = true; };
  }, [suggestionsHook.error, accountId]);

  // Derived suggestion list — preference order:
  //   1. AI hook output (even partial — chips fill in progressively)
  //   2. Templated fallback (after hook error)
  //   3. Hardcoded FALLBACK_SUGGESTIONS (cold start / total outage)
  const suggestions = useMemo(() => {
    // While a refresh is in flight, suppress the prior chips so the
    // admin sees "new ones coming" rather than the old set lingering
    // until the new stream starts producing output (~500ms latency).
    if (refreshingSuggestions) return [];
    const fromHook = suggestionsHook.object?.suggestions;
    if (Array.isArray(fromHook)) {
      // Filter out undefined entries (DeepPartial — server hasn't
      // emitted that slot yet) and empty strings. As soon as we have
      // at least one valid chip, prefer the live stream over fallbacks.
      const cleaned = fromHook
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s) => s.length > 0);
      if (cleaned.length > 0) return cleaned;
    }
    if (Array.isArray(templatedSuggestions) && templatedSuggestions.length > 0) {
      return templatedSuggestions;
    }
    return isAgency ? FALLBACK_SUGGESTIONS_AGENCY : FALLBACK_SUGGESTIONS_BRAND;
  }, [refreshingSuggestions, suggestionsHook.object, templatedSuggestions, isAgency]);

  const suggestionsLoading = suggestionsHook.isLoading;

  // Accumulate every suggestion shown into seenSuggestionsRef so the next
  // refresh can tell the model not to repeat them. We dedupe (case-
  // insensitive) and cap at 16 to keep the prompt small.
  useEffect(() => {
    if (refreshingSuggestions) return;
    if (!Array.isArray(suggestions) || suggestions.length === 0) return;
    const seen = seenSuggestionsRef.current;
    const seenLower = new Set(seen.map((s) => s.toLowerCase()));
    let changed = false;
    for (const s of suggestions) {
      if (typeof s !== "string" || !s.trim()) continue;
      const key = s.toLowerCase();
      if (seenLower.has(key)) continue;
      seenLower.add(key);
      seen.push(s);
      changed = true;
    }
    if (changed) {
      // Keep only the most recent 16 entries — older ones don't need
      // to keep haunting the prompt forever.
      if (seen.length > 16) {
        seenSuggestionsRef.current = seen.slice(seen.length - 16);
      }
    }
  }, [suggestions, refreshingSuggestions]);

  // When a refresh produces output, clear the refreshing flag so the
  // new chips render. We key this on `isLoading` flipping false AFTER
  // it was true during a refresh — guards against the initial-mount
  // submit clearing the flag prematurely.
  useEffect(() => {
    if (refreshingSuggestions && !suggestionsHook.isLoading) {
      setRefreshingSuggestions(false);
    }
  }, [refreshingSuggestions, suggestionsHook.isLoading]);

  const refreshSuggestions = useCallback(() => {
    if (!accountId) return;
    setTemplatedSuggestions(null); // re-attempt AI path; drop stale fallback
    setRefreshingSuggestions(true); // hide old chips immediately
    suggestionsHook.submit({
      accountId,
      previousSuggestions: seenSuggestionsRef.current,
    });
  }, [accountId, suggestionsHook]);

  const isBusy = status === "streaming" || status === "submitted";

  // Stick-to-bottom logic. While the user is at (or near) the bottom of
  // the message feed, new tokens / new messages auto-scroll the view to
  // keep the latest content in sight. The moment the user scrolls UP
  // (mid-stream or otherwise), we stop pulling them back down — they can
  // read earlier messages while the model keeps generating. Scrolling
  // back to the bottom re-engages auto-follow.
  //
  // Implementation:
  //   - `stickToBottomRef` carries the current stickiness across renders
  //     without causing extra re-renders.
  //   - A scroll listener on the container updates the ref whenever
  //     scroll position changes (including programmatic scrolls, which
  //     re-affirm stickiness after we auto-pull to bottom).
  //   - The auto-scroll effect reads the ref and bails out when the
  //     user is detached.
  //
  // SLOP = px tolerance for "near bottom". Has to be larger than a single
  // streamed line of text so that fast token append doesn't accidentally
  // mark us unstuck between scroll-event firings.
  const SCROLL_SLOP = 64;
  const stickToBottomRef = useRef(true);
  // Mirror of the ref in state form, but ONLY for rendering the
  // "Jump to latest" affordance. Updating this on every scroll would
  // thrash; we update it lazily via the scroll listener.
  const [detached, setDetached] = useState(false);

  // Maintain stickToBottomRef as the user (and our own auto-scrolls)
  // move scrollTop. Only one listener; survives across mounts of inner
  // content because scrollRef points at the stable container div.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_SLOP;
      stickToBottomRef.current = atBottom;
      setDetached((prev) => (prev === !atBottom ? prev : !atBottom));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom when messages or streaming state change —
  // but ONLY when the user is currently sticking to the bottom. The
  // listener above keeps stickToBottomRef in sync.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isBusy]);

  // Programmatic "jump to latest" — clicked when the user has scrolled
  // up during streaming and wants to re-engage auto-follow. We scroll
  // to the bottom; the scroll listener picks that up and flips
  // stickToBottomRef back to true automatically.
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

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
    <div
      className={"copilot-panel" + (isPageVariant ? " copilot-panel--page" : "")}
      role={isPageVariant ? undefined : "dialog"}
      aria-label={isPageVariant ? undefined : "AI Co-pilot"}
    >
      {/* Page variant deliberately skips the in-panel header — the
          breadcrumb in the app's topbar already says "LinkAI" and the
          BrandPicker shows the brand context, so a second header inside
          the card was redundant and ate ~80px of vertical chat space.
          "Start new" surfaces as a small floating button (rendered below
          the .copilot-panel--page outer) only when there's a conversation
          to clear. */}
      {!isPageVariant && (
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
      )}
      {isPageVariant && messages.length > 0 && (
        <button
          type="button"
          className="copilot-page-startnew"
          onClick={startNew}
          title="Start a new conversation"
        >
          <Icon name="refresh" size={11} />
          <span>Start new</span>
        </button>
      )}

      <div className="copilot-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className={"copilot-welcome" + (isPageVariant ? " copilot-welcome--page" : "")}>
            {isPageVariant ? (
              <>
                <h2 className="copilot-welcome-hero">
                  Tell me what you want to make for <strong>{brandName || "this brand"}</strong>.
                </h2>
                <p>
                  I can ideate, research, draft posts, and plan your calendar — just ask.
                </p>
              </>
            ) : (
              <>
                <p>Hi! I'm your Co-pilot for <strong>{brandName || "this brand"}</strong>.</p>
                <p>Ask me to draft a post, plan next week's content, or brainstorm a campaign — I'll create real drafts in the Social Calendar that you can edit and submit.</p>
              </>
            )}
            <div className="copilot-suggestions-head">
              <span className="copilot-suggestions-label">Try one of these</span>
              <button
                type="button"
                className="copilot-suggestions-refresh"
                onClick={refreshSuggestions}
                disabled={suggestionsLoading || !accountId}
                title="Generate fresh suggestions"
                aria-label="Refresh suggestions"
              >
                {suggestionsLoading ? (
                  <span className="copilot-suggestions-spinner" aria-hidden />
                ) : (
                  <Icon name="refresh" size={11} />
                )}
                <span>Refresh</span>
              </button>
            </div>
            <div className="copilot-suggestions">
              {suggestions.map((s, i) => (
                <button
                  key={`${i}-${s.slice(0, 16)}`}
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
            {m.parts.map((part, idx) => renderPart(part, idx, m.id, m.role, { onNavigateToPlan, onCommitDraft, brandSlug }))}
          </div>
        ))}

        {isBusy && messages.length > 0 && (
          <CopilotStatus status={status} messages={messages} />
        )}

        {/* Gate the error banner on messages.length > 0 so that
            clicking "Start new" (which resets messages) doesn't leave a
            stale error from the previous conversation sitting around.
            useChat doesn't expose a setError, so this is the cleanest
            way to reset the error UI on conversation reset. The error
            naturally re-renders on the next failed sendMessage anyway. */}
        {error && messages.length > 0 && (
          <div className="copilot-error">
            <Icon name="alert" size={12} /> {error.message || String(error)}
          </div>
        )}
      </div>

      {/* "Jump to latest" pill — surfaces when the user has scrolled UP
          mid-conversation AND the model is mid-stream. Clicking it
          re-engages auto-follow by scrolling to the bottom; the scroll
          listener picks that up and flips stickToBottomRef back to true.
          Hidden when the user is already at the bottom (no need) and
          when there's no conversation yet (welcome screen). */}
      {detached && messages.length > 0 && (
        <button
          type="button"
          className="copilot-jump-latest"
          onClick={jumpToLatest}
          aria-label="Scroll to latest message"
        >
          {isBusy ? "New tokens below" : "Jump to latest"}
          <Icon name="chevron-down" size={12} />
        </button>
      )}

      <footer className={"copilot-input" + (isPageVariant ? " copilot-input--page" : "")}>
        <CopilotFollowUpChips
          messages={messages}
          isBusy={isBusy}
          onPick={(text) => {
            setDraft(text);
            // Focus on next tick so the textarea has the new value when
            // it gains focus — caret lands at the end.
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.focus();
                const end = el.value.length;
                el.setSelectionRange(end, end);
              }
            });
          }}
        />
        {isPageVariant ? (
          /* Page variant: textarea + Send button on a single row
             (Conversations-style), with a tiny "⌘↩ to send" hint
             below. Token-count meta is dropped here — it's a
             developer/debug detail that ate space without earning
             attention. */
          <>
            <div className="copilot-page-row">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isBusy ? "Generating…" : "Message LinkAI…"}
                disabled={isBusy}
                rows={1}
              />
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
            <div className="copilot-page-hint">⌘↩ to send</div>
          </>
        ) : (
          <>
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
          </>
        )}
      </footer>
    </div>
  );
};

// CopilotFollowUpChips — quick-reply chips above the textarea sourced
// from the model's `suggest_follow_ups` tool call on the latest
// assistant message. Click a chip → prefill the textarea (admin can
// edit, then send normally via Enter / Send button).
//
// Lifecycle:
//   - Chips appear after the assistant finishes a turn that ended with
//     a `suggest_follow_ups` tool call (the model is instructed to call
//     it at the end of every reply).
//   - Chips disappear the moment the admin sends a new message (the
//     "latest message" becomes a user message → no chips to extract).
//   - Chips disappear while a turn is streaming (isBusy → hidden).
//   - Chips disappear if there's no follow-up tool call on the latest
//     reply (model forgot to emit one — graceful degradation).
function CopilotFollowUpChips({ messages, isBusy, onPick }) {
  if (isBusy) return null;
  const chips = extractLatestFollowUpChips(messages);
  if (!chips || !chips.length) return null;
  return (
    <div className="copilot-followups" role="group" aria-label="Suggested follow-ups">
      {chips.map((chip, i) => (
        <button
          key={i}
          type="button"
          className="copilot-followup-chip"
          onClick={() => onPick(chip)}
          title="Click to prefill the message — edit if you want, then send."
        >
          {chip}
        </button>
      ))}
    </div>
  );
}

function extractLatestFollowUpChips(messages) {
  if (!Array.isArray(messages)) return null;
  // Walk backward — the latest message may be a user message (admin
  // just sent something and the next reply hasn't landed yet) or the
  // assistant's most recent turn. Chips ride on the latest ASSISTANT
  // message only.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role !== "assistant") return null; // newest message is user → chips gone
    if (!Array.isArray(m.parts)) return null;
    for (let j = m.parts.length - 1; j >= 0; j -= 1) {
      const part = m.parts[j];
      if (part?.type !== "tool-suggest_follow_ups") continue;
      if (part.state !== "output-available") return null;
      // execute() returns { ok: true, result: { chips: [...] } } — same
      // wrapping as the other tools. Unwrap defensively.
      const out = part.output;
      const inner = out && typeof out === "object" && "ok" in out ? out : null;
      const chips = inner?.ok && Array.isArray(inner.result?.chips) ? inner.result.chips : null;
      if (!chips || !chips.length) return null;
      return chips.filter((c) => typeof c === "string" && c.trim().length > 0);
    }
    return null; // latest assistant message has no follow-up call
  }
  return null;
}

// CopilotStatus — replaces the old 3-dot-only typing indicator with a
// descriptive label of what the copilot is currently doing. Derived
// entirely from useChat's `status` + the latest assistant message's
// parts — no extra server channel needed. Updates in real time as the
// model moves through tool calls / text generation.
//
// Heuristics:
//   - status === 'submitted'                  → "Thinking…"
//   - last part is a running tool call        → friendly tool headline
//     ("Consulting the launch-strategy playbook…")
//   - last part is text being streamed        → "Writing the response…"
//   - default                                 → "Thinking…"
//
// The 3-dot animation stays — it's small, lively, and reinforces "still
// working". The label sits beside it so the admin always knows WHAT.
function CopilotStatus({ status, messages }) {
  const label = deriveStatusLabel(status, messages);
  return (
    <div className="copilot-typing">
      <span className="copilot-dot" />
      <span className="copilot-dot" />
      <span className="copilot-dot" />
      <span className="copilot-status-label">{label}</span>
    </div>
  );
}

function deriveStatusLabel(status, messages) {
  if (status === "submitted") return "Thinking…";
  if (status !== "streaming") return "Thinking…";

  // Find the latest assistant message and inspect its newest part.
  let lastAssistant = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = messages[i];
      break;
    }
  }
  if (!lastAssistant || !Array.isArray(lastAssistant.parts) || lastAssistant.parts.length === 0) {
    return "Thinking…";
  }

  // Walk from the end backwards, skipping framework markers, until we
  // find something signal-bearing.
  for (let i = lastAssistant.parts.length - 1; i >= 0; i -= 1) {
    const part = lastAssistant.parts[i];
    const partType = part?.type;
    if (partType === "step-start" || partType === "step-end") continue;
    // suggest_follow_ups is the model's "emit chips at the end" call —
    // not a user-visible action. Skip past it so the status reflects
    // the actual work that preceded it.
    if (partType === "tool-suggest_follow_ups") continue;
    if (typeof partType === "string" && partType.startsWith("tool-")) {
      const toolName = partType.slice("tool-".length);
      const isRunning = part.state === "input-streaming" || part.state === "input-available";
      if (isRunning) {
        return runningToolLabel(toolName, part.input);
      }
      // Tool finished — that means a step boundary just passed and the
      // model is composing its next move. Show "Thinking…" rather than
      // mirroring the just-completed tool's headline.
      return "Thinking…";
    }
    if (partType === "text") {
      // Text is the most recent activity → model is writing.
      // If text is empty, we're still in "thinking" mode just before
      // the first token lands.
      const text = typeof part.text === "string" ? part.text : "";
      return text.trim().length === 0 ? "Thinking…" : "Writing the response…";
    }
  }
  return "Thinking…";
}

// Mirror of ToolCard's running-state headlines. Duplicated rather than
// extracted because the two components have different ergonomics
// (ToolCard needs state + input + output; CopilotStatus only sees the
// in-flight tool call) and the headlines themselves are short.
function runningToolLabel(toolName, input) {
  if (toolName === "create_post_plan_draft") return "Drafting a post plan…";
  if (toolName === "write_brand_note") return "Saving a brand note…";
  if (toolName === "load_skill") {
    const slug = typeof input?.slug === "string" ? input.slug : "";
    const title = SKILL_SLUG_TITLES[slug] || slug;
    return title ? `Consulting the ${title} playbook…` : "Consulting a marketing playbook…";
  }
  if (toolName === "load_skill_reference") {
    const slug = typeof input?.slug === "string" ? input.slug : "";
    const ref = typeof input?.reference_name === "string"
      ? input.reference_name.replace(/-/g, " ")
      : "";
    const title = SKILL_SLUG_TITLES[slug] || slug;
    if (ref && title) return `Pulling “${ref}” from the ${title} playbook…`;
    if (ref) return `Pulling “${ref}”…`;
    return "Pulling a deep-dive reference…";
  }
  if (toolName === "web_search") {
    const q = typeof input?.query === "string" ? input.query.trim() : "";
    if (q) {
      const truncated = q.length > 60 ? q.slice(0, 57) + "…" : q;
      return `Searching the web for “${truncated}”…`;
    }
    return "Searching the web…";
  }
  return `Running ${toolName}…`;
}

// Skill slug → human title — duplicated from ToolCard for the same
// reason. If this list grows, lift it to a shared module.
const SKILL_SLUG_TITLES = {
  "social-content": "social content",
  "content-strategy": "content strategy",
  "copywriting": "copywriting",
  "copy-editing": "copy editing",
  "marketing-psychology": "marketing psychology",
  "marketing-ideas": "marketing ideas",
  "launch-strategy": "launch strategy",
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
    // suggest_follow_ups is a UI-only signal — chips render above the
    // textarea via CopilotFollowUpChips, not as a tile in the message
    // thread. Drop the part to avoid a redundant tile.
    if (toolName === "suggest_follow_ups") return null;
    return (
      <ToolCard
        key={`${messageId}-${part.toolCallId || idx}`}
        toolName={toolName}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText}
        onNavigateToPlan={ctx.onNavigateToPlan}
        onCommitDraft={ctx.onCommitDraft}
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
//
// Failed tool calls render as null — we don't show the red "tool failed"
// tile to the admin. Reasons:
//   - The server's experimental_repairToolCall handler silently fixes
//     malformed inputs before they reach the client. If a tile would
//     have been an error, the server already retried it. By the time
//     we render, the SAME toolCallId is on a successful retry that we
//     do want to show; or the model gave up and produced a text reply
//     instead, which is enough.
//   - When the server-side repair AND the model retry both fail, the
//     admin sees the model's natural-language explanation. They don't
//     need to see a red plumbing artifact.
// The SYSTEM_PROMPT also instructs the model not to announce internal
// failures, so the post-recovery text reads as if the first attempt
// worked.
function ToolCard({ toolName, state, input, output, errorText, onNavigateToPlan, onCommitDraft, brandSlug }) {
  const isPlan = toolName === "create_post_plan_draft";
  const isNote = toolName === "write_brand_note";
  const isLoadSkill = toolName === "load_skill";
  const isLoadSkillRef = toolName === "load_skill_reference";
  const isWebSearch = toolName === "web_search";

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

  // Plan tile state. The tool no longer inserts on the server — the
  // result is `{ proposed: true, scheduled_at, platforms, concept,
  // copy_variants, status }` (see web/api/ai/chat.ts). The "Open plan"
  // click is what actually inserts the post_plans row. Once committed,
  // we stash the resulting plan id locally so subsequent clicks just
  // navigate instead of double-inserting.
  const isProposedPlan = isPlan && ok && result?.proposed === true;
  // Tolerate legacy/server-committed shape too — if some path still
  // returns a real id (e.g. older history before this change), we'll
  // treat it as already-committed and skip the commit step on click.
  const legacyCommittedId = isPlan && ok && result?.id ? result.id : null;
  const [committedId, setCommittedId] = useState(legacyCommittedId);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState(null);

  let statusKey = "running";
  if (isError || (!ok && inner)) statusKey = "error";
  else if (isOk) statusKey = "ok";

  // Suppress error tiles entirely. See the comment block above for the
  // rationale. We still log the failure so we can debug from the browser
  // devtools when something genuinely goes wrong.
  if (statusKey === "error") {
    if (typeof console !== "undefined" && displayError) {
      console.warn("[copilot] suppressed tool error tile", { toolName, displayError });
    }
    return null;
  }

  // Friendly slug → title mapping for the skill tiles. Kept inline (and
  // small) so the tile doesn't need to wait on a tool response to render
  // a nice headline. Slugs that don't match fall back to the raw slug.
  const skillSlugTitles = {
    "social-content": "social content",
    "content-strategy": "content strategy",
    "copywriting": "copywriting",
    "copy-editing": "copy editing",
    "marketing-psychology": "marketing psychology",
    "marketing-ideas": "marketing ideas",
    "launch-strategy": "launch strategy",
  };
  const skillTitle = input?.slug ? (skillSlugTitles[input.slug] || input.slug) : null;
  const refTitle = input?.reference_name ? String(input.reference_name).replace(/-/g, " ") : null;

  // Web search input.query is the searched phrase; useful to surface
  // in the tile headline.
  const webSearchQuery = isWebSearch && typeof input?.query === "string" ? input.query.trim() : "";
  const webSearchResultCount = isWebSearch && typeof result?.result_count === "number" ? result.result_count : null;

  let headline;
  if (statusKey === "running") {
    headline = isPlan
      ? "Drafting a post plan…"
      : isNote
        ? "Saving a brand note…"
        : isLoadSkill
          ? (skillTitle ? `Consulting the ${skillTitle} playbook…` : "Consulting a marketing playbook…")
          : isLoadSkillRef
            ? (skillTitle && refTitle ? `Pulling “${refTitle}” from the ${skillTitle} playbook…` : "Pulling a deep-dive reference…")
            : isWebSearch
              ? (webSearchQuery ? `Searching the web for “${webSearchQuery.length > 60 ? webSearchQuery.slice(0, 57) + "…" : webSearchQuery}”…` : "Searching the web…")
              : `Running ${toolName}…`;
  } else if (statusKey === "ok") {
    headline = isPlan
      ? (committedId ? "Added to the calendar" : "Drafted a post plan — open to add")
      : isNote
        ? (input?.is_pinned ? "Saved a pinned brand note" : "Saved a brand note")
        : isLoadSkill
          ? (skillTitle ? `Loaded the ${skillTitle} playbook` : "Loaded a marketing playbook")
          : isLoadSkillRef
            ? (skillTitle && refTitle ? `Loaded “${refTitle}” from ${skillTitle}` : "Loaded a deep-dive reference")
            : isWebSearch
              ? (webSearchResultCount != null ? `Read ${webSearchResultCount} result${webSearchResultCount === 1 ? "" : "s"} from the web` : "Searched the web")
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
          {input?.scheduled_at && (
            <div className="copilot-tool-when">
              <Icon name="calendar" size={11} />
              <span>{formatPlanChipTime(input.scheduled_at)}</span>
            </div>
          )}
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
      {isPlan && ok && (isProposedPlan || committedId) && (
        <>
          <button
            className="copilot-tool-cta"
            disabled={committing}
            onClick={async () => {
              if (committing) return;
              // Already committed once — just navigate.
              if (committedId) {
                onNavigateToPlan?.(committedId, brandSlug);
                return;
              }
              // First click on a proposed draft → commit, then navigate.
              if (!onCommitDraft) {
                setCommitError("Commit handler missing — refresh and retry.");
                return;
              }
              setCommitting(true);
              setCommitError(null);
              try {
                const plan = await onCommitDraft(result);
                if (plan?.id) {
                  setCommittedId(plan.id);
                  onNavigateToPlan?.(plan.id, brandSlug);
                } else {
                  setCommitError("Could not add to calendar (no plan id returned).");
                }
              } catch (e) {
                setCommitError(e?.message || "Could not add to calendar.");
              } finally {
                setCommitting(false);
              }
            }}
          >
            {committing
              ? "Adding to calendar…"
              : committedId
                ? "Open plan →"
                : "Open plan →"}
          </button>
          {commitError && (
            <div className="copilot-tool-error" role="alert">{commitError}</div>
          )}
        </>
      )}
    </div>
  );
}

export { CopilotPanel };
// Default export so React.lazy() in App.jsx can code-split the entire panel
// (and its heavy dependency tree — Streamdown, shiki language packs, mermaid)
// behind admin clicking the topbar Co-pilot trigger.
export default CopilotPanel;
