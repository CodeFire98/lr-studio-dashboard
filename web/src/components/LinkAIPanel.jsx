// =====================================================================
// LinkAIPanel.jsx — Agency-side LinkAI sidebar drawer
// =====================================================================
//
// LinkAI v2 Phase 2a: rewritten around `useChat` from @ai-sdk/react +
// selected AI Elements components (Conversation, Message, MessageResponse).
// The custom SSE parser, manual message state, and abort logic from v1
// are all replaced by useChat. Wire protocol on /api/ai/chat is now the
// AI SDK's native UIMessage stream — see web/api/ai/chat.ts for the
// server-side change that ships in the same PR.
//
// Visual identity: panel chrome (header, footer with textarea/send) stays
// on the hand-written `.link-ai-*` CSS so it integrates with the rest of
// the dashboard. The message-rendering area inside the scroll is wrapped
// in `<div className="ai-elements">` so the shadcn-themed AI Elements
// components pick up their CSS-variable tokens (scoped block lives in
// web/src/styles/elements.css).
//
// Persistence: messages persist to localStorage keyed by (userId, accountId)
// under a v2 key (`lr_copilot_conv_v2_*`). The literal "copilot" in that
// key string is deliberately preserved through the 2026-05-21 Co-pilot →
// LinkAI rename so existing users don't lose their chat history. v1 entries
// under the old (non-v2) key are orphaned — admin starts fresh on first
// open after deploy. By design; v1 message shape was incompatible with the
// new UIMessage `parts` model.
//
// Triggered from App.jsx topbar "✨ LinkAI" button. Visibility gated by:
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
import { buildTemplatedLinkAISuggestions } from "../lib/db.js";
import { useCoarsePointer } from "../lib/useCoarsePointer.ts";
import { CopyButton } from "./primitives.jsx";
import { formatPlanChipTime } from "./ConversationsView.jsx";
// AI Elements' `Conversation` was intentionally dropped from Phase 2a —
// its stick-to-bottom scroll behaviour conflicts with the existing
// `.link-ai-scroll` overflow logic. We keep manual auto-scroll via a
// scrollRef + useEffect (same pattern as v1). Reconsider in Phase 3
// if there's a stick-to-bottom UX win that justifies the layout rework.
import { MessageResponse } from "@/components/ai-elements/message";

// ----- Storage layer ----------------------------------------------------
//
// Two key schemes live side-by-side during the LinkAI history-rail
// rollout:
//
// (1) DRAWER variant (right-side panel from the topbar "✨ LinkAI"
//     trigger): single conversation per (user, brand), stored at
//     `lr_copilot_conv_v2_${userId}_${accountId}`. The literal "copilot"
//     in the key is preserved through the 2026-05-21 rename so existing
//     users don't lose history. Will be retired in PR D when the drawer
//     itself goes away.
//
// (2) PAGE variant (full-page surface at /c/:slug/linkai): multi-
//     conversation store. An *index* lists every conversation; each
//     conversation's message array lives at its own per-conv key.
//
//     Index:        lr_link_ai_index_v1_${userId}_${accountId}
//                   → [{ id, title, createdAt, updatedAt }, …]   (newest first)
//     Per-conv:     lr_link_ai_conv_v3_${userId}_${accountId}_${convId}
//                   → UIMessage[]
//
//     On first page load for a user with drawer history (i.e. the v2
//     key exists and the v3 index is empty), we *copy* the v2 messages
//     into a new v3 entry titled "Previous chat (sidebar)" so the
//     history rail isn't empty on day one. The v2 key is left in place
//     so the drawer keeps working until PR D.
const MAX_PERSISTED_MESSAGES = 60;
const LEGACY_V2_KEY = (userId, accountId) => `lr_copilot_conv_v2_${userId}_${accountId}`;
const INDEX_KEY    = (userId, accountId) => `lr_link_ai_index_v1_${userId}_${accountId}`;
const CONV_KEY     = (userId, accountId, convId) => `lr_link_ai_conv_v3_${userId}_${accountId}_${convId}`;

// Drawer single-conv helpers (legacy, preserved verbatim — PR D retires).
function loadPersistedMessages(userId, accountId) {
  if (!userId || !accountId) return [];
  try {
    const raw = localStorage.getItem(LEGACY_V2_KEY(userId, accountId));
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
    localStorage.setItem(LEGACY_V2_KEY(userId, accountId), JSON.stringify(trimmed));
  } catch {
    // localStorage full / unavailable — silent drop. Chat still works in-memory.
  }
}

// Multi-conv helpers (page variant).
function loadConvIndex(userId, accountId) {
  if (!userId || !accountId) return [];
  try {
    const raw = localStorage.getItem(INDEX_KEY(userId, accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveConvIndex(userId, accountId, index) {
  if (!userId || !accountId) return;
  try {
    localStorage.setItem(INDEX_KEY(userId, accountId), JSON.stringify(index));
  } catch { /* silent */ }
}

function loadConvMessages(userId, accountId, convId) {
  if (!userId || !accountId || !convId) return [];
  try {
    const raw = localStorage.getItem(CONV_KEY(userId, accountId, convId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveConvMessages(userId, accountId, convId, messages) {
  if (!userId || !accountId || !convId) return;
  try {
    const trimmed = messages.length > MAX_PERSISTED_MESSAGES
      ? messages.slice(messages.length - MAX_PERSISTED_MESSAGES)
      : messages;
    localStorage.setItem(CONV_KEY(userId, accountId, convId), JSON.stringify(trimmed));
  } catch { /* silent */ }
}

function removeConvMessages(userId, accountId, convId) {
  if (!userId || !accountId || !convId) return;
  try { localStorage.removeItem(CONV_KEY(userId, accountId, convId)); } catch { /* silent */ }
}

// In-memory cache of FULL multimodal messages, keyed by
// (userId, accountId, convId). Survives LinkAIPanel mount/unmount
// (navigating to /calendar and back doesn't lose the image bubbles
// in the chat) within the same tab session. Cleared on hard reload,
// at which point the localStorage-persisted, attachment-stripped
// breadcrumb takes over — same as before this addition. Bounded only
// by the per-conv MAX_PERSISTED_MESSAGES cap; convs are short-lived
// in practice. A future PR (Supabase Storage uploads) can replace
// this with stable URLs that persist past hard reload too.
const sessionConvCache = new Map();
const sessionCacheKey = (userId, accountId, convId) =>
  `${userId}|${accountId}|${convId}`;
function cacheSessionConv(userId, accountId, convId, messages) {
  if (!userId || !accountId || !convId) return;
  sessionConvCache.set(sessionCacheKey(userId, accountId, convId), messages);
}
function readSessionConv(userId, accountId, convId) {
  if (!userId || !accountId || !convId) return null;
  return sessionConvCache.get(sessionCacheKey(userId, accountId, convId)) ?? null;
}
function dropSessionConv(userId, accountId, convId) {
  if (!userId || !accountId || !convId) return;
  sessionConvCache.delete(sessionCacheKey(userId, accountId, convId));
}

// Drop every cache entry that doesn't belong to the given (userId,
// accountId). Called on brand switch as belt-and-suspenders insurance:
// the cache is already keyed per-brand so wrong-brand lookups MISS by
// construction, but if any future bug ever writes a conv under the
// wrong key, the stale entry would linger in memory until tab close.
// Wiping non-matching entries on every brand switch is the simple,
// defensive answer. Cost: multimodal attachment bubbles for any OTHER
// brand the user toggled through this session reset to the
// localStorage breadcrumb when they come back — acceptable, attachments
// are session-only by design anyway.
function pruneSessionCacheToBrand(userId, accountId) {
  if (!userId || !accountId) return;
  const prefix = `${userId}|${accountId}|`;
  for (const k of Array.from(sessionConvCache.keys())) {
    if (!k.startsWith(prefix)) sessionConvCache.delete(k);
  }
}

function makeConvId() {
  // Date-prefixed for natural sort/display + a 4-char random suffix to
  // avoid collisions when two new chats land in the same millisecond.
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// Derive a 50-char title from the first user-text part of the first
// user message. If we can't find one (e.g. a tool-only message), fall
// back to "Untitled chat" — the rail row stays readable while the user
// builds out the conversation.
function deriveConvTitle(messages) {
  for (const m of messages) {
    if (m?.role !== "user") continue;
    for (const part of (m.parts || [])) {
      if (part?.type !== "text" || typeof part?.text !== "string") continue;
      const text = part.text.trim();
      if (!text) continue;
      return text.length > 50 ? text.slice(0, 47).trimEnd() + "…" : text;
    }
  }
  return "Untitled chat";
}

// One-time copy: bring the drawer's old conversation into the page's
// new multi-conv store as a single entry. Returns true if anything was
// imported. The v2 key is NOT deleted — the drawer keeps reading from
// it until PR D retires the drawer entirely.
function importLegacyV2ToIndex(userId, accountId) {
  if (!userId || !accountId) return false;
  // Only import if the v3 index is empty (don't duplicate on every load).
  const existing = loadConvIndex(userId, accountId);
  if (existing.length > 0) return false;
  const legacy = loadPersistedMessages(userId, accountId);
  if (legacy.length === 0) return false;
  const convId = makeConvId();
  saveConvMessages(userId, accountId, convId, legacy);
  const now = new Date().toISOString();
  saveConvIndex(userId, accountId, [{
    id: convId,
    title: deriveConvTitle(legacy) || "Previous chat (sidebar)",
    createdAt: now,
    updatedAt: now,
  }]);
  return true;
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
//     button). Mounted from App.jsx when the topbar "✨ LinkAI" trigger
//     is on. Uses `.link-ai-panel` styles in app.css.
//   - 'page': inline full-page render. Used by the new /c/:slug/linkai
//     route. Drops the close button (the sidebar nav owns route changes),
//     widens the layout, and renders a bigger empty-state hero. Uses
//     `.link-ai-panel.link-ai-panel--page` overrides in app.css.
const LinkAIPanel = ({
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
      console.error("[LinkAI] stream error:", err);
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
  // brand-kit missing), we fire `buildTemplatedLinkAISuggestions`
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
      console.error("[LinkAI/suggestions] stream error:", err);
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
    buildTemplatedLinkAISuggestions({ accountId })
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

  // ----- Multi-conversation state (page variant only) -----------------
  //
  // Two ids govern the entire chat-routing machine:
  //
  //   - `activeConvId` = which conversation the USER is currently
  //     VIEWING (drives the rail's highlighted row + the displayed
  //     messages). Null = "fresh empty chat, will materialise on
  //     first send".
  //
  //   - `sdkConvId` = which conversation the SDK's `messages` array
  //     currently BELONGS TO. The AI SDK gives us a single messages
  //     array — at any moment it's "the state of one specific conv".
  //     We track which one separately so we can let the two diverge
  //     during a stream.
  //
  // The two diverge in exactly two cases:
  //
  //   1. During a stream: sdkConvId is the conv being streamed into.
  //      The user can switch activeConvId freely — the rail click
  //      doesn't touch the SDK. The display layer routes from the
  //      session cache for the off-stream active conv; the SDK keeps
  //      appending tokens to sdkConvId in the background and the
  //      persist effect routes those tokens to sdkConvId's slot.
  //
  //   2. Right after an idle rail click: activeConvId changes
  //      immediately, sdkConvId stays. The align effect (below) sees
  //      `!isBusy && active !== sdk`, swaps the SDK's messages array
  //      over to active's content, and updates sdkConvId.
  //
  // Drawer variant: both ids stay null; the drawer's single-conv code
  // below handles persistence via the legacy v2 key.
  //
  // BLOCKER (deliberate, not a bug): the Send button stays disabled
  // while a stream is in flight. The SDK's single messages array
  // can only host one in-flight request at a time, so we can't fire
  // a second sendMessage for a different conv. The user can switch
  // and draft, but pressing Send waits until the current stream ends.
  const [convIndex, setConvIndex] = useState(() =>
    isPageVariant ? loadConvIndex(userId, accountId) : []
  );
  const [activeConvId, setActiveConvId] = useState(() => {
    if (!isPageVariant) return null;
    const idx = loadConvIndex(userId, accountId);
    return idx[0]?.id || null;
  });
  const [sdkConvId, setSdkConvId] = useState(null);
  // Ref mirror of sdkConvId so the persist effect can target the right
  // slot WITHOUT putting sdkConvId in its dependency array (we want
  // persist to fire on messages changes only — see the persist effect
  // comments for the failure mode if these end up in the deps).
  //
  // Must be declared AFTER the useState above — the mirror effect
  // captures sdkConvId by name, and JS's temporal dead zone rejects
  // reads before the `const [sdkConvId, ...] = useState(...)` line
  // runs in the render function.
  const sdkConvIdRef = useRef(null);
  useEffect(() => { sdkConvIdRef.current = sdkConvId; }, [sdkConvId]);

  // ----- Artifact pane (PR C4) -----------------------------------------
  //
  // `artifact` is null when nothing's open. Otherwise:
  //   { kind: 'plan-draft', toolCallId, draft, committedId | null }
  // — committedId flips from null to the new post_plans.id after the
  // user clicks "Add to calendar" inside the pane.
  //
  // The history rail auto-collapses while the artifact is open (one row
  // is enough screen real-estate when three columns are competing).
  // Closing the artifact restores the rail to its default expanded
  // state. There's no manual collapse toggle — the user's only way to
  // see a narrow rail is by opening a preview. Closing the preview =
  // expanded again, deterministic, no localStorage state.
  const [artifact, setArtifact] = useState(null);
  const railCollapsed = !!artifact;
  // Mobile-only state: the chat history rail is CSS-hidden by default
  // on phones (no room alongside the chat). The new mobile header
  // exposes a "Chats" button that flips this open — the rail then
  // slides in as a fixed-position overlay. Tap a chat row or the
  // scrim to close. Desktop ignores this state entirely.
  const [historyOpen, setHistoryOpen] = useState(false);

  const openArtifact = useCallback((next) => {
    setArtifact(next);
  }, []);
  const closeArtifact = useCallback(() => {
    setArtifact(null);
  }, []);

  // ----- Composer attachments (PR C2) ----------------------------------
  //
  // Drag-drop an image (or click the paperclip button) into the composer
  // to attach it. The image is read as a base64 data: URL and passed
  // through to Claude as an AI SDK `file` part on the next sendMessage.
  // `convertToModelMessages` server-side maps it to Claude's vision
  // input automatically — no /api/ai/chat change required.
  //
  // Constraints:
  //   - Only image/* mime types accepted (Claude vision supports PNG,
  //     JPEG, GIF, WebP). PDFs deferred to a future PR.
  //   - 5 MB per file (Claude's vision limit is 5 MB per image).
  //   - 4 attachments per message (Claude allows up to 100 images in a
  //     single request, but a chat composer rarely needs more than a
  //     handful and the UI gets cramped beyond 4).
  //   - Attachments are NOT persisted to localStorage — see the persist
  //     effect above. On reload, the data URLs would balloon the v3
  //     conv key past the 5 MB quota fast. Acceptable tradeoff: image
  //     is "in this turn only", which is also how the chat reads.
  const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  const MAX_ATTACHMENTS_PER_MESSAGE = 4;
  const ACCEPTED_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);

  const readAsDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });

  const isAcceptedMime = (mime) =>
    typeof mime === "string" && ACCEPTED_MIMES.includes(mime.toLowerCase());

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAttachmentError(null);

    const accepted = [];
    let firstError = null;
    for (const f of files) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        firstError = firstError || `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`;
        break;
      }
      if (!isAcceptedMime(f.type)) {
        firstError = firstError || `"${f.name}" isn't a supported image type (PNG, JPEG, WebP, GIF).`;
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        firstError = firstError || `"${f.name}" exceeds the 5 MB attachment limit.`;
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(f);
        accepted.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: f.name,
          mimeType: f.type,
          size: f.size,
          dataUrl,
        });
      } catch (e) {
        firstError = firstError || (e?.message || `Could not read "${f.name}".`);
      }
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    if (firstError) setAttachmentError(firstError);
  }, [attachments.length]);

  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setAttachmentError(null);
  };

  // Drag-and-drop. Track enter/leave on a refcounter so overlapping
  // child enter/leave events don't flicker the overlay.
  const onDragEnter = (e) => {
    e.preventDefault();
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    dragCounterRef.current += 1;
    setDragActive(true);
  };
  const onDragOver = (e) => {
    // Required so the browser allows the drop.
    e.preventDefault();
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) addFiles(files);
  };

  const onPickClick = () => fileInputRef.current?.click();
  const onFileInputChange = (e) => {
    addFiles(e.target.files);
    // Reset so picking the same file twice in a row fires the change.
    e.target.value = "";
  };

  // Clipboard paste — third entry point alongside the paperclip button
  // and drag-drop. Catches OS screenshot tools (Cmd+Shift+4 → buffer,
  // Cmd+V here) and image-copy from other apps. Wired onto the textarea
  // so it only fires when the composer has focus.
  //
  // Mixed-content paste (clipboard contains both an image AND text,
  // e.g. copying a rich block from Slack/Notion) is treated as
  // "image attached + text pasted into the textarea normally" — we
  // don't preventDefault when there's also text. Image-only paste
  // (the common screenshot path) does preventDefault to suppress the
  // browser's no-op paste-image-into-textarea attempt.
  //
  // Browsers name clipboard images "image.png" generically. When
  // multiple images get pasted in one go, all four chips would show
  // the same label. Rename to a timestamped form so the tray reads
  // sensibly (`pasted-2026-05-26T14-30-22.png`, etc.).
  const onPaste = useCallback((e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(
      (it) => it.kind === "file" && isAcceptedMime(it.type),
    );
    if (imageItems.length === 0) return; // no image — let default paste behavior run

    const rawFiles = imageItems.map((it) => it.getAsFile()).filter(Boolean);
    if (rawFiles.length === 0) return;

    const hasPlainText = items.some(
      (it) => it.kind === "string" && it.type === "text/plain",
    );
    if (!hasPlainText) e.preventDefault();

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const renamed = rawFiles.map((f, i) => {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const name = rawFiles.length > 1
        ? `pasted-${ts}-${i + 1}.${ext}`
        : `pasted-${ts}.${ext}`;
      // The File constructor is supported in every modern browser. We
      // keep the original blob bytes — only the name is changed.
      return new File([f], name, { type: f.type, lastModified: f.lastModified });
    });
    addFiles(renamed);
  }, [addFiles]);

  const formatAttachmentSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // One-time legacy v2 → v3 import (drawer → page rail) per (user, brand).
  // Runs on mount and on brand switch. Idempotent (importLegacyV2ToIndex
  // bails when the v3 index is non-empty).
  //
  // Brand switch also has to reset sdkConvId synchronously so the
  // persist effect — which fires on the userId/accountId dep change
  // with the OLD messages array still in scope — doesn't write the
  // prior brand's content into a slot under the new brand keys.
  // (See the persist effect comments for the full failure mode.)
  useEffect(() => {
    if (!isPageVariant || !userId || !accountId) return;
    importLegacyV2ToIndex(userId, accountId);
    const fresh = loadConvIndex(userId, accountId);
    setConvIndex(fresh);
    setActiveConvId((prev) => {
      // If the prior activeConvId belongs to a different brand, drop it.
      if (prev && fresh.some((c) => c.id === prev)) return prev;
      return fresh[0]?.id || null;
    });
    // Reset SDK state so persist skips the next fire (no targetId).
    // The align effect below will then load the new brand's active
    // conv into the SDK as soon as it sees active !== sdk.
    sdkConvIdRef.current = null;
    setSdkConvId(null);
    setMessages([]);
    // Drop module-level session cache entries from any OTHER brand we
    // may have toggled through this session. The cache is already
    // brand-keyed (lookups miss on wrong key), but stale entries don't
    // need to live in memory — and wiping them closes a class of bug
    // where any future race writes a conv under the wrong (userId,
    // accountId, convId) tuple. See pruneSessionCacheToBrand for the
    // full rationale.
    pruneSessionCacheToBrand(userId, accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, accountId, isPageVariant]);

  // Drawer variant: load the legacy single-conv key once per (user, brand).
  // The drawer is single-conversation by design — no rail, no multi-id
  // bookkeeping needed. Page variant uses the align effect below.
  useEffect(() => {
    if (isPageVariant) return;
    setMessages(loadPersistedMessages(userId, accountId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPageVariant, userId, accountId]);

  // Align (page variant): whenever the SDK's loaded conv differs from
  // what the user is viewing AND we're idle, swap the SDK's messages
  // array over to the active conv's content. This single effect covers
  // every "the SDK needs to catch up to the rail" scenario:
  //
  //   - Initial mount: sdkConvId starts null, active is the latest
  //     conv from storage → swap loads it.
  //   - Rail click while idle: active changes → swap loads target.
  //   - Stream completion after the user navigated away mid-stream:
  //     isBusy flips false with active still pointed at the conv they
  //     navigated TO → swap loads that one.
  //   - "+ New chat" while idle: active goes null → swap empties.
  //
  // While `isBusy` is true the SDK array must stay pinned to sdkConvId
  // (the streaming conv). The display layer routes from cache for the
  // off-stream conv in the meantime; persist keeps cache + storage
  // current as tokens land.
  useEffect(() => {
    if (!isPageVariant) return;
    if (isBusy) return;
    if (activeConvId === sdkConvId) return;
    // CRITICAL: write sdkConvIdRef.current SYNCHRONOUSLY before
    // setMessages. The AI SDK's `setMessages` flushes synchronously —
    // calling it triggers an immediate re-render that fires the
    // persist effect mid-align, BEFORE `setSdkConvId(activeConvId)`
    // below can apply. If the ref still points at the OLD conv when
    // that persist fires, persist writes the NEW conv's `messages`
    // into the OLD conv's localStorage + cache slot.
    //
    // Symptom (discovered 2026-05-22): every rail click silently
    // corrupted the previous conv's slot with the next conv's
    // content. After clicking through 3 chats, all 3 slots held the
    // last-viewed conv's messages — clicking back to any earlier
    // conv showed the corrupted (latest-viewed) content. Caught
    // from a `__linkaiDebug()` dump showing every `persist: WRITE`
    // landing in the prior conv's slot:
    //   `targetId: OLD, sdkConvId: OLD, activeConvId: NEW`
    //
    // The plain `setSdkConvId` setter below queues for the NEXT
    // render and the mirror effect updates the ref then — too late
    // for the persist that fires from this effect's `setMessages`
    // flush. Only the synchronous ref write closes the race.
    //
    // See memory: feedback_sdk_setmessages_flush_sync.md
    sdkConvIdRef.current = activeConvId;
    if (activeConvId == null) {
      setMessages([]);
    } else {
      // Prefer in-memory session cache (multimodal file parts intact)
      // over localStorage (stripped to a breadcrumb to fit the quota).
      const cached = readSessionConv(userId, accountId, activeConvId);
      const msgs = cached !== null
        ? cached
        : loadConvMessages(userId, accountId, activeConvId);
      setMessages(msgs);
    }
    setSdkConvId(activeConvId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPageVariant, isBusy, activeConvId, sdkConvId, userId, accountId, setMessages]);

  // Persist on every messages change. Page variant also bumps the index
  // entry's updatedAt + back-fills the title if it was still the default.
  //
  // Attachment file parts get stripped before persistence (PR C2): a
  // 5 MB base64 data URL on every saved message would torch the
  // localStorage 5–10 MB quota in a handful of turns. The chat stays
  // multimodal in-memory during the session; on reload only the text
  // (and tool parts) remain. A small placeholder text part flags that
  // attachments were here, so the conversation still makes narrative
  // sense after reload.
  const stripAttachmentsForPersist = (msgs) =>
    msgs.map((m) => {
      if (!m || !Array.isArray(m.parts)) return m;
      let imageCount = 0;
      const kept = m.parts.filter((p) => {
        if (p?.type === "file") { imageCount += 1; return false; }
        return true;
      });
      if (imageCount === 0) return m;
      // Prepend a tiny breadcrumb so the user can see on reload that
      // their previous turn had images attached, even if the data
      // itself is gone.
      const breadcrumb = {
        type: "text",
        text: imageCount === 1
          ? "_[attached 1 image — not retained after reload]_"
          : `_[attached ${imageCount} images — not retained after reload]_`,
      };
      return { ...m, parts: [breadcrumb, ...kept] };
    });

  useEffect(() => {
    if (!isPageVariant) {
      persistMessages(userId, accountId, stripAttachmentsForPersist(messages));
      return;
    }
    // Always write to the conv the SDK's messages array belongs to —
    // NEVER to activeConvId. The two diverge during a stream (sdk is
    // the streaming conv, active is wherever the user clicked) and
    // briefly right after an idle rail click (active is the new conv,
    // sdk is the old one until the align effect swaps it). Writing to
    // active in either case would clobber an unrelated slot:
    //
    //   - Click conv A → click conv B (idle): persist would fire with
    //     A's `messages` (the SDK hasn't swapped yet) but the new
    //     active = B → A's content gets written into B's slot.
    //   - Stream into A, click "+ New chat" → tokens for A would land
    //     in active = null (no target, dropped on the floor).
    //
    // sdkConvIdRef is the truth: it tracks which conv the SDK's
    // `messages` array represents at the moment of the write.
    //
    // We read it from a REF (not state) to keep sdkConvId out of this
    // effect's deps. The effect should only fire when `messages` (or
    // isBusy, for the bump-gate below) actually changes — not on
    // every rail click that nudges sdkConvId via the align effect.
    const targetId = sdkConvIdRef.current;
    if (!targetId) return;
    // SAFEGUARD: never clobber a non-empty slot with an empty array.
    // In the happy path, persist only sees `messages = []` when
    // `sdkConvIdRef.current` is also null (the early return above
    // catches it). This guard is belt-and-suspenders for any future
    // race where messages momentarily flushes to [] while the ref
    // still points at a real conv — kept after the 2026-05-22
    // cross-contamination root-cause was fixed in the align effect
    // (sync ref write before setMessages). Cheap insurance.
    if (messages.length === 0) {
      const existingCache = readSessionConv(userId, accountId, targetId);
      const existingStored = loadConvMessages(userId, accountId, targetId);
      const existingLen = Math.max(existingCache?.length || 0, existingStored.length);
      if (existingLen > 0) return;
    }
    cacheSessionConv(userId, accountId, targetId, messages);
    saveConvMessages(userId, accountId, targetId, stripAttachmentsForPersist(messages));
    // Bump updatedAt + re-sort the rail ONLY when the SDK is actively
    // streaming — that's the only legitimate cause for "this conv
    // moved up in the list". The align effect's setMessages also
    // triggers this persist, but isBusy is false then, so we skip
    // the bump. Matches Claude / ChatGPT: a conv climbs the list on
    // real send activity, not on a passive view.
    if (!isBusy) return;
    setConvIndex((prev) => {
      const entry = prev.find((c) => c.id === targetId);
      if (!entry) return prev;
      const now = new Date().toISOString();
      // Re-derive the title only when it's still the placeholder OR when
      // we have a real user message and the stored title is the legacy
      // import default. Avoids title flapping on every assistant token.
      const derived = deriveConvTitle(messages);
      const titleNeedsUpdate =
        (entry.title === "Untitled chat" || !entry.title) &&
        derived &&
        derived !== "Untitled chat";
      const updated = prev.map((c) =>
        c.id === targetId
          ? { ...c, updatedAt: now, title: titleNeedsUpdate ? derived : c.title }
          : c
      );
      // Re-sort: most-recently-updated first so the rail order matches
      // user expectation (latest activity on top).
      updated.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      saveConvIndex(userId, accountId, updated);
      return updated;
    });
  }, [isPageVariant, userId, accountId, messages, isBusy]);

  const handleSend = () => {
    const text = draft.trim();
    // Allow attachment-only sends (no text). Useful for "look at this
    // and tell me what you think" — paste/drop an image, hit Send.
    if ((!text && attachments.length === 0) || isBusy) return;
    // Page variant: if no active conversation, mint one just-in-time so
    // the message can be persisted from the very first token.
    let targetConvId = activeConvId;
    if (isPageVariant && !activeConvId) {
      const id = makeConvId();
      targetConvId = id;
      const now = new Date().toISOString();
      // Title prefers the text; falls back to a generic attachments
      // label if the message is image-only.
      const titleSeed = text.length > 0
        ? text
        : (attachments.length === 1
            ? `Image: ${attachments[0].name}`
            : `${attachments.length} images`);
      const title = titleSeed.length > 50 ? titleSeed.slice(0, 47).trimEnd() + "…" : titleSeed;
      setConvIndex((prev) => {
        const next = [{ id, title, createdAt: now, updatedAt: now }, ...prev];
        saveConvIndex(userId, accountId, next);
        return next;
      });
      setActiveConvId(id);
    }
    // Synchronise sdkConvId (and its ref mirror) to the conv we're
    // sending INTO, BEFORE sendMessage triggers its first setMessages.
    // The persist effect reads sdkConvIdRef to route tokens to the
    // right localStorage slot; setting the ref synchronously here
    // avoids depending on the mirror effect's render-after-render
    // catch-up. Without this, the very first user message of a fresh
    // conv could land with sdkConvIdRef still pointing at the prior
    // (or null) conv and be dropped on the floor.
    if (isPageVariant) {
      sdkConvIdRef.current = targetConvId;
      setSdkConvId(targetConvId);
    }
    // Build the parts array. AI SDK v6 expects `type: 'file'` for
    // images/files; the server's convertToModelMessages turns these
    // into Claude's vision image blocks. Text goes last so the model
    // sees the attachments first, then the prompt referring to them.
    const parts = [];
    for (const a of attachments) {
      parts.push({
        type: "file",
        mediaType: a.mimeType,
        filename: a.name,
        url: a.dataUrl,
      });
    }
    if (text) parts.push({ type: "text", text });
    setDraft("");
    setAttachments([]);
    setAttachmentError(null);
    sendMessage({ parts });
  };

  // Send-key behaviour: ⌘↩ / Ctrl+Enter sends, Enter inserts a newline,
  // everywhere. The visible Send button is the only submit affordance
  // on mobile — Enter on touch should never accidentally send a half-
  // typed message. Matches the Conversations composer convention.
  const isCoarsePointer = useCoarsePointer();
  const handleKeyDown = (e) => {
    if (e.key !== "Enter") return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // "Start new" from the page surface: clear the active conversation
  // (which renders the hero/empty state). The next sendMessage will
  // mint a fresh conversation in handleSend. The CURRENT conversation
  // stays in the rail and on disk — nothing's deleted.
  //
  // Allowed mid-stream: the SDK's messages array stays pinned to
  // sdkConvId (the streaming conv); clearing the displayed conv
  // (activeConvId = null) only flips what the display shows. The
  // align effect will catch up and clear the SDK array AFTER the
  // stream finishes. The user can't SEND a new message until the
  // current stream ends — Send button stays disabled while isBusy.
  //
  // Drawer variant keeps its prior "wipe the single persisted conv"
  // behaviour for now — PR D retires the drawer.
  const startNew = () => {
    if (isPageVariant) {
      if (activeConvId == null) return; // already in fresh state
      setActiveConvId(null);
      // Don't touch the SDK's messages here — the align effect handles
      // the swap once it sees active=null and we're idle. Touching it
      // mid-stream would corrupt the in-flight conv's array.
    } else {
      if (isBusy) return;
      if (messages.length > 0 && !window.confirm("Start a new conversation? The current one will be cleared.")) {
        return;
      }
      setMessages([]);
      try { localStorage.removeItem(LEGACY_V2_KEY(userId, accountId)); } catch { /* ignore */ }
    }
  };

  // Rail handlers (page variant only). Mid-stream switching is
  // ALLOWED — the SDK keeps streaming for sdkConvId in the
  // background while the user browses other convs. Display layer
  // routes from cache for the off-stream active conv; the align
  // effect catches the SDK up once the stream finishes.
  const switchToConv = (convId) => {
    if (convId === activeConvId) return;
    setActiveConvId(convId);
  };

  const deleteConv = (convId) => {
    // Block deleting the currently-streaming conv — that would
    // orphan the in-flight request. All other convs (including
    // the displayed one if idle, or any historical one) are fair
    // game. The SDK can only stream into one conv at a time, so
    // sdkConvId + isBusy uniquely identifies the "live" one.
    if (sdkConvId === convId && isBusy) return;
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    removeConvMessages(userId, accountId, convId);
    dropSessionConv(userId, accountId, convId);
    setConvIndex((prev) => {
      const next = prev.filter((c) => c.id !== convId);
      saveConvIndex(userId, accountId, next);
      return next;
    });
    if (activeConvId === convId) {
      // Switch to the next-most-recent conv (or null = hero state).
      // Don't call setMessages here — the align effect handles it
      // once it sees active !== sdk and we're idle.
      const remaining = convIndex.filter((c) => c.id !== convId);
      setActiveConvId(remaining[0]?.id || null);
    }
    // If we deleted the conv the SDK still holds (only possible when
    // !isBusy, per the guard above), reset sdkConvId so the align
    // effect re-loads the new active conv into the SDK array.
    if (sdkConvId === convId) {
      sdkConvIdRef.current = null;
      setSdkConvId(null);
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

  // What messages does the UI render?
  //   - Drawer variant: always the SDK's `messages` (single-conv).
  //   - Page variant, sdk === active: SDK's `messages` (live, with
  //     in-flight stream tokens if any).
  //   - Page variant, sdk !== active: a static snapshot of
  //     activeConvId from the session cache (full multimodal) or
  //     localStorage (text + breadcrumb fallback) — the SDK keeps
  //     streaming for sdkConvId in the background; the align effect
  //     will swap to active once we go idle.
  const displayMessages = (() => {
    if (!isPageVariant) return messages;
    if (activeConvId === sdkConvId) return messages;
    if (!activeConvId) return [];
    const cached = readSessionConv(userId, accountId, activeConvId);
    return cached !== null ? cached : loadConvMessages(userId, accountId, activeConvId);
  })();
  // Is the SDK currently streaming a reply into the conv the user is
  // VIEWING? (vs streaming for a different background conv.) Used to
  // gate the "Generating…" indicator + the error banner so they only
  // surface on the conv they describe.
  const streamingActiveConv = isBusy && (!isPageVariant || sdkConvId === activeConvId);

  const panelContent = (
    <div
      className={"link-ai-panel" + (isPageVariant ? " link-ai-panel--page" : "")}
      role={isPageVariant ? undefined : "dialog"}
      aria-label={isPageVariant ? undefined : "LinkAI"}
    >
      {/* Page variant deliberately skips the in-panel header on
          desktop — the breadcrumb in the app's topbar already says
          "LinkAI" and the BrandPicker shows the brand context. On
          mobile the rail is CSS-hidden so we need to expose "Chats"
          (history toggle) and "+ New" inside the page itself; the
          mobile header below appears only at ≤640px via CSS. */}
      {isPageVariant && (
        <header className="link-ai-header link-ai-header--mobile">
          <button
            type="button"
            className="link-ai-header-btn"
            onClick={() => setHistoryOpen((v) => !v)}
            title="Recent chats"
            aria-expanded={historyOpen}
            aria-label="Recent chats"
          >
            <Icon name="list" size={14} />
            <span>Chats</span>
          </button>
          <div className="link-ai-header-spacer" />
          <button
            type="button"
            className="link-ai-header-btn"
            onClick={startNew}
            title="Start a new conversation"
            aria-label="Start a new conversation"
          >
            <Icon name="plus" size={14} />
            <span>New</span>
          </button>
        </header>
      )}
      {!isPageVariant && (
        <header className="link-ai-header">
          <div>
            <h4>
              <span className="link-ai-spark" aria-hidden>✨</span>
              <span>LinkAI</span>
            </h4>
            <div className="link-ai-sub">{brandName || "Brand"}</div>
          </div>
          <div className="link-ai-header-actions">
            {messages.length > 0 && (
              <button
                className="link-ai-header-btn"
                onClick={startNew}
                title="Start a new conversation"
              >
                Start new
              </button>
            )}
            <button className="link-ai-close" onClick={onClose} aria-label="Close LinkAI">
              <Icon name="x" size={14} />
            </button>
          </div>
        </header>
      )}
      {/* The floating "Start new" pill from PR A is gone — the rail's
          "+ New chat" button is the canonical entrypoint now. */}

      <div className="link-ai-scroll" ref={scrollRef}>
        {displayMessages.length === 0 && (
          <div className={"link-ai-welcome" + (isPageVariant ? " link-ai-welcome--page" : "")}>
            {isPageVariant ? (
              <>
                <h2 className="link-ai-welcome-hero">
                  Tell me what you want to make for <strong>{brandName || "this brand"}</strong>.
                </h2>
                <p>
                  I can ideate, research, draft posts, and plan your calendar — just ask.
                </p>
              </>
            ) : (
              <>
                <p>Hi! I'm your LinkAI for <strong>{brandName || "this brand"}</strong>.</p>
                <p>Ask me to draft a post, plan next week's content, or brainstorm a campaign — I'll create real drafts in the Social Calendar that you can edit and submit.</p>
              </>
            )}
            <div className="link-ai-suggestions-head">
              <span className="link-ai-suggestions-label">Try one of these</span>
              <button
                type="button"
                className="link-ai-suggestions-refresh"
                onClick={refreshSuggestions}
                disabled={suggestionsLoading || !accountId}
                title="Generate fresh suggestions"
                aria-label="Refresh suggestions"
              >
                {suggestionsLoading ? (
                  <span className="link-ai-suggestions-spinner" aria-hidden />
                ) : (
                  <Icon name="refresh" size={11} />
                )}
                <span>Refresh</span>
              </button>
            </div>
            <div className="link-ai-suggestions">
              {suggestions.map((s, i) => (
                <button
                  key={`${i}-${s.slice(0, 16)}`}
                  className="link-ai-suggestion"
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

        {displayMessages.map((m) => (
          <div key={m.id} className={`link-ai-msg link-ai-msg-${m.role}`}>
            {m.parts.map((part, idx) => renderPart(part, idx, m.id, m.role, { onNavigateToPlan, onCommitDraft, brandSlug, onPreviewPlan: isPageVariant ? openArtifact : null, openArtifactId: artifact?.toolCallId || null }))}
          </div>
        ))}

        {/* "Generating…" status only when the SDK is streaming INTO the
            conv currently on screen. If a stream is in flight for a
            different background conv, the streamingActiveConv flag
            stays false and the indicator stays hidden on the snapshot. */}
        {streamingActiveConv && displayMessages.length > 0 && (
          <LinkAIStatus status={status} messages={messages} />
        )}

        {/* Same gating for the error banner — only show on the conv the
            error describes (the one the SDK was streaming to). */}
        {error && streamingActiveConv && displayMessages.length > 0 && (
          <div className="link-ai-error">
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
          className="link-ai-jump-latest"
          onClick={jumpToLatest}
          aria-label="Scroll to latest message"
        >
          {isBusy ? "New tokens below" : "Jump to latest"}
          <Icon name="chevron-down" size={12} />
        </button>
      )}

      <footer className={"link-ai-input" + (isPageVariant ? " link-ai-input--page" : "")}>
        <LinkAIFollowUpChips
          messages={displayMessages}
          isBusy={streamingActiveConv}
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
          /* Page variant: textarea + paperclip + Send button on a
             single row (Conversations-style), with a tiny "⌘↩ to send"
             hint below. Attachment chips appear above the row when
             files are queued. */
          <>
            {(attachments.length > 0 || attachmentError) && (
              <div className="link-ai-attach-tray">
                {attachments.map((a) => (
                  <div key={a.id} className="link-ai-attach-chip">
                    {a.mimeType.startsWith("image/") && (
                      <img className="link-ai-attach-thumb" src={a.dataUrl} alt={a.name} />
                    )}
                    <div className="link-ai-attach-meta">
                      <span className="link-ai-attach-name" title={a.name}>{a.name}</span>
                      <span className="link-ai-attach-size">{formatAttachmentSize(a.size)}</span>
                    </div>
                    <button
                      type="button"
                      className="link-ai-attach-remove"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.name}`}
                      title="Remove"
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </div>
                ))}
                {attachmentError && (
                  <div className="link-ai-attach-error" role="alert">{attachmentError}</div>
                )}
              </div>
            )}
            <div className="link-ai-page-row">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_MIMES.join(",")}
                multiple
                hidden
                onChange={onFileInputChange}
              />
              <button
                type="button"
                className="link-ai-attach-btn"
                onClick={onPickClick}
                disabled={isBusy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                title={
                  attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE
                    ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`
                    : "Attach image (PNG, JPEG, WebP, GIF — 5 MB max)"
                }
                aria-label="Attach image"
              >
                <Icon name="paperclip" size={14} />
              </button>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                placeholder={
                  isBusy && streamingActiveConv
                    ? "Generating… type your next message"
                    : isBusy
                      ? "Type while LinkAI finishes the other chat…"
                      : "Message LinkAI…"
                }
                rows={1}
              />
              {/* Stop button shows only when the user is VIEWING the
                  conv that's currently streaming — clicking Stop while
                  looking at a different background conv would be
                  confusing. From the off-stream view, only Send is
                  available (disabled until the stream ends or they
                  switch back to the streaming conv to hit Stop). */}
              {isBusy && streamingActiveConv ? (
                <button className="link-ai-send link-ai-cancel" onClick={stop}>Stop</button>
              ) : (
                <button
                  className="link-ai-send"
                  onClick={handleSend}
                  disabled={isBusy || (!draft.trim() && attachments.length === 0)}
                  title={isBusy ? "Wait for the current generation to finish, or click Stop." : undefined}
                >
                  Send
                </button>
              )}
            </div>
            <div className="link-ai-page-hint">⌘↩ to send · paste or drop an image to attach</div>
          </>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isBusy ? "Generating…" : "Message the LinkAI…  (⌘↩ to send)"}
              disabled={isBusy}
              rows={2}
            />
            <div className="link-ai-input-row">
              <div className="link-ai-meta">
                {lastUsage && (
                  <span title="input / output tokens (cache reads in parens)">
                    {lastUsage.input_tokens ?? 0} in {lastUsage.cache_read_input_tokens ? `(${lastUsage.cache_read_input_tokens} cached)` : ""} · {lastUsage.output_tokens ?? 0} out
                  </span>
                )}
              </div>
              {isBusy ? (
                <button className="link-ai-send link-ai-cancel" onClick={stop}>Stop</button>
              ) : (
                <button
                  className="link-ai-send"
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

  // Drawer variant: just the panel, no rail.
  if (!isPageVariant) return panelContent;

  // Page variant: history rail + panel content + (optional) artifact pane.
  return (
    <div
      className={"link-ai-page-wrapper" + (dragActive ? " is-drag-active" : "")}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Scrim — only meaningful on mobile when the rail is open as
          an overlay. Desktop sees opacity:0 + pointer-events:none. */}
      <div
        className={"link-ai-history-scrim" + (historyOpen ? " is-open" : "")}
        onClick={() => setHistoryOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={
          "link-ai-history"
          + (railCollapsed ? " link-ai-history--collapsed" : "")
          + (historyOpen ? " is-open" : "")
        }
        aria-label="LinkAI chat history"
      >
        <button
          type="button"
          className={railCollapsed ? "link-ai-history-new-collapsed" : "link-ai-history-new"}
          onClick={() => { startNew(); setHistoryOpen(false); }}
          title="Start a new conversation"
        >
          <Icon name="plus" size={12} />
          {!railCollapsed && <span>New chat</span>}
        </button>
        {!railCollapsed && (
          <div className="link-ai-history-list">
            {convIndex.length === 0 ? (
              <div className="link-ai-history-empty">
                Your past chats will appear here.
              </div>
            ) : (
              convIndex.map((c) => {
                const isStreamingHere = isBusy && sdkConvId === c.id;
                return (
                  <div
                    key={c.id}
                    className={
                      "link-ai-history-row" +
                      (c.id === activeConvId ? " is-active" : "") +
                      (isStreamingHere ? " is-streaming" : "")
                    }
                  >
                    <button
                      type="button"
                      className="link-ai-history-row-main"
                      onClick={() => { switchToConv(c.id); setHistoryOpen(false); }}
                      title={c.title}
                    >
                      <span className="link-ai-history-row-title">{c.title}</span>
                      <span className="link-ai-history-row-time">
                        {isStreamingHere ? (
                          <>
                            <span className="link-ai-history-row-streaming-dot" aria-hidden />
                            Generating…
                          </>
                        ) : (
                          formatRelativeTime(c.updatedAt)
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="link-ai-history-row-delete"
                      onClick={() => deleteConv(c.id)}
                      disabled={isStreamingHere}
                      aria-label={`Delete "${c.title}"`}
                      title={isStreamingHere ? "Can't delete a chat that's still generating. Wait or click Stop." : "Delete"}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </aside>
      {panelContent}
      {artifact && (
        <ArtifactPane
          artifact={artifact}
          brandSlug={brandSlug}
          onClose={closeArtifact}
          onCommitDraft={onCommitDraft}
          onNavigateToPlan={onNavigateToPlan}
          onCommitted={(planId) =>
            setArtifact((prev) => (prev ? { ...prev, committedId: planId } : prev))
          }
        />
      )}
      {dragActive && (
        <div className="link-ai-drop-overlay" aria-hidden>
          <div className="link-ai-drop-overlay-card">
            <Icon name="paperclip" size={24} />
            <div className="link-ai-drop-overlay-title">Drop to attach</div>
            <div className="link-ai-drop-overlay-sub">
              PNG, JPEG, WebP, or GIF · up to {MAX_ATTACHMENTS_PER_MESSAGE} files, 5 MB each
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ----- ArtifactPane (PR C4) ------------------------------------------
// Right-side pane on the LinkAI page. Renders a preview of a tool's
// output (currently only `create_post_plan_draft` — future kinds:
// brand-note edits, web-search result detail, etc.).
//
// IMPORTANT contract per the C4 design note (memory:
// linkai-pr-c4-side-panel-explicit-commit):
//   - Opening the pane DOES NOT write anything to the database. The
//     draft lives only in chat memory + this pane's local state until
//     the user clicks "Add to calendar".
//   - "Add to calendar" calls onCommitDraft (the same handler the
//     drawer variant uses) → on success, the pane stays open and
//     swaps its CTA to "Open in Calendar view" (which navigates).
//   - The brand_draft status flow downstream (brand must "Propose
//     plan" from the calendar detail) is unchanged.
function ArtifactPane({ artifact, brandSlug, onClose, onCommitDraft, onNavigateToPlan, onCommitted }) {
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState(null);

  if (!artifact || artifact.kind !== "plan-draft") return null;
  const draft = artifact.draft || {};
  const committedId = artifact.committedId;

  const onAddToCalendar = async () => {
    if (committing || committedId) return;
    if (!onCommitDraft) {
      setError("Commit handler missing — refresh and retry.");
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      const plan = await onCommitDraft(draft);
      if (plan?.id) {
        onCommitted(plan.id);
      } else {
        setError("Could not add to calendar (no plan id returned).");
      }
    } catch (e) {
      setError(e?.message || "Could not add to calendar.");
    } finally {
      setCommitting(false);
    }
  };

  const onOpenInCalendar = () => {
    if (committedId) onNavigateToPlan?.(committedId, brandSlug);
  };

  // copy_variants is an OBJECT keyed by platform slug ({ instagram?, linkedin?, x? })
  // per the create_post_plan_draft tool's Zod schema in web/api/ai/chat.ts.
  // Iterate the keys, drop empty strings, preserve the natural platform
  // order (ig → li → x) instead of Object.keys' insertion order so the
  // pane always reads consistently regardless of which platforms the
  // model emitted.
  const variantsObj = draft.copy_variants && typeof draft.copy_variants === "object" ? draft.copy_variants : {};
  const PLATFORM_ORDER = ["instagram", "linkedin", "x"];
  const copyVariants = PLATFORM_ORDER
    .filter((p) => typeof variantsObj[p] === "string" && variantsObj[p].trim().length > 0)
    .map((p) => ({ platform: p, body: variantsObj[p] }));

  return (
    <aside className="link-ai-artifact" aria-label="Plan preview">
      <header className="link-ai-artifact-head">
        <div className="link-ai-artifact-head-titles">
          <div className="link-ai-artifact-kicker">Post plan preview</div>
          <h3 className="link-ai-artifact-title">{draft.concept || "Untitled plan"}</h3>
          {(draft.scheduled_at || (Array.isArray(draft.platforms) && draft.platforms.length > 0)) && (
            <div className="link-ai-artifact-meta">
              {draft.scheduled_at && (
                <span className="link-ai-artifact-meta-item">
                  <Icon name="calendar" size={11} />
                  <span>{formatPlanChipTime(draft.scheduled_at)}</span>
                </span>
              )}
              {Array.isArray(draft.platforms) && draft.platforms.map((p) => (
                <span key={p} className="link-ai-tool-pill">{p}</span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="link-ai-artifact-close"
          onClick={onClose}
          aria-label="Close preview"
          title="Close"
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className="link-ai-artifact-body">
        {copyVariants.length === 0 ? (
          <div className="link-ai-artifact-empty">No copy variants drafted yet.</div>
        ) : (
          copyVariants.map((cv, i) => {
            const platform = cv?.platform || `Variant ${i + 1}`;
            const body = cv?.body || cv?.copy || "";
            return (
              <section key={`${platform}-${i}`} className="link-ai-artifact-variant">
                <div className="link-ai-artifact-variant-head">
                  <span className="link-ai-tool-pill">{platform}</span>
                  {/* One-click copy of this variant's body — lets users
                      grab the AI-drafted caption straight into IG /
                      LinkedIn / X composer without having to open the
                      plan detail page first. */}
                  {body && <CopyButton text={body} title={`Copy ${platform} copy`} />}
                </div>
                {body && (
                  <pre className="link-ai-artifact-variant-body">{body}</pre>
                )}
              </section>
            );
          })
        )}
      </div>

      <footer className="link-ai-artifact-footer">
        {error && (
          <div className="link-ai-tool-error" role="alert">{error}</div>
        )}
        {committedId ? (
          <>
            <div className="link-ai-artifact-status">
              <Icon name="check" size={12} />
              <span>Added to calendar</span>
            </div>
            <button
              type="button"
              className="link-ai-artifact-primary"
              onClick={onOpenInCalendar}
            >
              Open in Calendar view →
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="link-ai-artifact-primary"
              onClick={onAddToCalendar}
              disabled={committing}
            >
              {committing ? "Adding…" : "Add to calendar"}
            </button>
            <div className="link-ai-artifact-hint">
              The draft lives only in this chat until you add it.
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}

// LinkAIFollowUpChips — quick-reply chips above the textarea sourced
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
function LinkAIFollowUpChips({ messages, isBusy, onPick }) {
  if (isBusy) return null;
  const chips = extractLatestFollowUpChips(messages);
  if (!chips || !chips.length) return null;
  return (
    <div className="link-ai-followups" role="group" aria-label="Suggested follow-ups">
      {chips.map((chip, i) => (
        <button
          key={i}
          type="button"
          className="link-ai-followup-chip"
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

// LinkAIStatus — replaces the old 3-dot-only typing indicator with a
// descriptive label of what the LinkAI is currently doing. Derived
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
function LinkAIStatus({ status, messages }) {
  const label = deriveStatusLabel(status, messages);
  return (
    <div className="link-ai-typing">
      <span className="link-ai-dot" />
      <span className="link-ai-dot" />
      <span className="link-ai-dot" />
      <span className="link-ai-status-label">{label}</span>
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
// (ToolCard needs state + input + output; LinkAIStatus only sees the
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
// User messages keep v1's coral-on-white `.link-ai-bubble` styling so they
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
      return <div key={`${messageId}-t${idx}`} className="link-ai-bubble">{part.text}</div>;
    }
    // `.ai-elements` MUST be tight-scoped to JUST the Streamdown render area.
    // If it covered the scroll surface or the whole message, shadcn's
    // neutral `--accent: 0 0% 96.1%` would override the global coral
    // `--accent: #E8553D` for any descendant using `var(--accent)` —
    // most importantly `.link-ai-bubble` (white text on coral). Same
    // regression as Phase 0 hotfix; same fix: keep `.ai-elements` only
    // where shadcn-token-aware components actually render.
    //
    // `controls.table.fullscreen: false` disables Streamdown's table
    // expand-to-modal button — the modal's positioning broke in our
    // panel context (overflowed below the chat with no backdrop). Copy
    // + download buttons stay (useful when AI returns comparison tables).
    return (
      <div key={`${messageId}-t${idx}`} className="link-ai-prose ai-elements">
        <MessageResponse controls={{ table: { copy: true, download: true, fullscreen: false } }}>
          {part.text}
        </MessageResponse>
      </div>
    );
  }
  if (part.type === "step-start" || part.type === "step-end") {
    return null; // SDK-internal step markers; we don't render these.
  }
  if (part.type === "file") {
    // Inline attachment shown on the user's message bubble. Images get
    // a clickable thumbnail (click → open the full image in a new tab);
    // anything else (PDFs etc., future) gets a filename chip.
    const isImage = typeof part.mediaType === "string" && part.mediaType.startsWith("image/");
    if (isImage) {
      return (
        <a
          key={`${messageId}-f${idx}`}
          className="link-ai-attachment-img"
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          title={part.filename || "Attached image"}
        >
          <img src={part.url} alt={part.filename || "Attached image"} loading="lazy" />
        </a>
      );
    }
    return (
      <div key={`${messageId}-f${idx}`} className="link-ai-attachment-chip">
        <Icon name="paperclip" size={11} />
        <span>{part.filename || "attachment"}</span>
      </div>
    );
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    const toolName = part.type.slice("tool-".length);
    // suggest_follow_ups is a UI-only signal — chips render above the
    // textarea via LinkAIFollowUpChips, not as a tile in the message
    // thread. Drop the part to avoid a redundant tile.
    if (toolName === "suggest_follow_ups") return null;
    return (
      <ToolCard
        key={`${messageId}-${part.toolCallId || idx}`}
        toolName={toolName}
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText}
        onNavigateToPlan={ctx.onNavigateToPlan}
        onCommitDraft={ctx.onCommitDraft}
        brandSlug={ctx.brandSlug}
        onPreviewPlan={ctx.onPreviewPlan}
        isArtifactOpen={ctx.openArtifactId === part.toolCallId}
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
function ToolCard({ toolName, toolCallId, state, input, output, errorText, onNavigateToPlan, onCommitDraft, brandSlug, onPreviewPlan, isArtifactOpen }) {
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
      console.warn("[LinkAI] suppressed tool error tile", { toolName, displayError });
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
    <div className={`link-ai-tool link-ai-tool-${statusKey}`}>
      <div className="link-ai-tool-head">
        <Icon name={statusKey === "running" ? "sparkles" : statusKey === "ok" ? "check" : "alert"} size={12} />
        <span>{headline}</span>
      </div>
      {isPlan && input?.concept && (
        <div className="link-ai-tool-body">
          <div className="link-ai-tool-concept">{input.concept}</div>
          {input?.scheduled_at && (
            <div className="link-ai-tool-when">
              <Icon name="calendar" size={11} />
              <span>{formatPlanChipTime(input.scheduled_at)}</span>
            </div>
          )}
          {Array.isArray(input.platforms) && (
            <div className="link-ai-tool-platforms">
              {input.platforms.map((p) => (
                <span key={p} className="link-ai-tool-pill">{p}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {isNote && input?.body && (
        <div className="link-ai-tool-body">
          <div className="link-ai-tool-note-body">"{input.body}"</div>
          {input.is_pinned && (
            <div className="link-ai-tool-note-pinned">
              <Icon name="check" size={10} /> Pinned — rides on every AI call
            </div>
          )}
        </div>
      )}
      {statusKey === "error" && displayError && (
        <div className="link-ai-tool-error">{displayError}</div>
      )}
      {isPlan && ok && (isProposedPlan || committedId) && (
        <>
          {onPreviewPlan ? (
            /* Page variant: "Preview" opens the side-by-side artifact pane
               (no DB write). Commit happens inside the pane via "Add to
               calendar". This separation lets the user iterate with LinkAI
               without every interim draft landing in the calendar. */
            <button
              className={"link-ai-tool-cta" + (isArtifactOpen ? " is-active" : "")}
              onClick={() => {
                onPreviewPlan({
                  kind: "plan-draft",
                  toolCallId,
                  draft: result,
                  committedId: committedId || null,
                });
              }}
            >
              {committedId ? "Open" : (isArtifactOpen ? "Showing in side panel" : "Preview")}
            </button>
          ) : (
            /* Drawer variant (no side panel — there's no room for a third
               column inside the 420px drawer). Same legacy commit+navigate
               behaviour as before C4. */
            <button
              className="link-ai-tool-cta"
              disabled={committing}
              onClick={async () => {
                if (committing) return;
                if (committedId) {
                  onNavigateToPlan?.(committedId, brandSlug);
                  return;
                }
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
              {committing ? "Adding to calendar…" : "Open plan →"}
            </button>
          )}
          {commitError && (
            <div className="link-ai-tool-error" role="alert">{commitError}</div>
          )}
        </>
      )}
    </div>
  );
}

export { LinkAIPanel };
// Default export so React.lazy() in App.jsx can code-split the entire panel
// (and its heavy dependency tree — Streamdown, shiki language packs, mermaid)
// behind admin clicking the topbar LinkAI trigger.
export default LinkAIPanel;
