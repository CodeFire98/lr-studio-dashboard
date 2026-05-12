// =====================================================================
// AICopyPreview — instruction-driven inline AI copy generation
// =====================================================================
//
// AI Co-pilot v2 Phase 2b: rewritten around `useCompletion` from
// @ai-sdk/react. The v1 implementation kept an explicit
// 'compose' | 'streaming' | 'done' | 'error' state machine, a hand-rolled
// SSE parser (parseSse async generator), a manual AbortController, and
// a separate `usage` state object that read SSE `usage` events.
// All of that collapses to a few derived booleans now — useCompletion
// owns the stream state, abort, and completion buffer.
//
// Wire protocol on /api/ai/copy switched in the same PR to the
// AI SDK's text-stream protocol (`pipeTextStreamToResponse`). The body
// shape changes: `instruction` is now `prompt` (useCompletion's primary
// field). Everything else (accountId, plan_id, platform, mode, current_copy)
// rides in the per-call body override.
//
// Behavior preserved exactly:
//   - Autofocus the instruction textarea on mount.
//   - Cmd/Ctrl+Enter from the instruction textarea fires Generate.
//   - Stop mid-stream keeps whatever text has accumulated and treats it
//     as "done" (useCompletion's abort behavior — completion buffer is
//     retained, isLoading flips to false).
//   - Instruction textarea stays visible after generation so the admin
//     can refine and click Regenerate to iterate.
//   - For mode=improve, the API reads the plan's current copy server-side
//     AND we pass the in-flight draft (which may include unsaved edits)
//     as `current_copy` so the model preserves the live edits.
//
// Behavior NOT preserved:
//   - The inline token-usage meter ("X in (Y cached) · Z out"). The
//     useCompletion data path doesn't surface usage to consumers, and
//     adding a side channel just for an inline debug indicator wasn't
//     worth the complexity. Cache observability moves to server logs —
//     /api/ai/copy logs `[copy] usage account=… cache_read=…` on every
//     completion, greppable in Vercel Function Logs.
// =====================================================================

/* eslint-disable */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCompletion } from '@ai-sdk/react';
import { Icon } from './Icon.jsx';
import { supabase } from '../lib/supabase.js';

const PLATFORM_LABEL = { instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X' };

// Custom fetch wrapper that resolves the Supabase session token at
// request time and adds it as Authorization. Mirrors the
// DefaultChatTransport headers() async pattern used in CopilotPanel.
async function fetchWithAuth(url, init) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  return fetch(url, { ...init, headers });
}

const AICopyPreview = ({ accountId, planId, platform, mode = 'draft', currentCopy = '', onAccept, onDismiss }) => {
  const [instruction, setInstruction] = useState('');
  const instructionInputRef = useRef(null);

  const isImprove = mode === 'improve';
  const platformLabel = PLATFORM_LABEL[platform] || platform;

  // useCompletion owns:
  //   - completion (the accumulating caption text)
  //   - isLoading (true while streaming)
  //   - error (HTTP / parse error)
  //   - stop() (abort the in-flight request, keep partial text)
  //   - complete(prompt, { body }) (kick off a new generation)
  //
  // streamProtocol: 'text' matches /api/ai/copy's pipeTextStreamToResponse.
  // The hook posts to `api` with body `{ prompt, ...body }` — we put
  // accountId / plan_id / platform / mode / current_copy in the per-call
  // body override so the server gets everything it needs in one POST.
  const { completion, complete, isLoading, error, stop } = useCompletion({
    api: '/api/ai/copy',
    streamProtocol: 'text',
    fetch: fetchWithAuth,
    onError: (err) => {
      // useCompletion surfaces err via the `error` state already; log
      // for debugging without spamming the user.
      // eslint-disable-next-line no-console
      console.error('[AICopyPreview] stream error:', err);
    },
  });

  // Derived "phase" for UI dispatch. Pure function of the three useCompletion
  // signals — no separate state to keep in sync.
  //   compose:   first render OR after Discard-then-reopen (no completion yet)
  //   streaming: stream in flight
  //   done:      stream finished (or was stopped mid-flight) and we have text
  //   error:     HTTP / parse error surfaced by the hook
  let phase = 'compose';
  if (isLoading) phase = 'streaming';
  else if (error) phase = 'error';
  else if (completion) phase = 'done';

  // Autofocus the instruction textarea on mount.
  useEffect(() => {
    instructionInputRef.current?.focus();
  }, []);

  // Cancel any in-flight stream on unmount — useCompletion doesn't
  // auto-abort when the component unmounts. We capture stop via a ref
  // so the cleanup runs ONLY on unmount and always sees the latest
  // controller (useCompletion's `stop` closes over the active
  // AbortController, so the initial render's `stop` is a no-op).
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  const handleGenerate = useCallback(() => {
    if (isLoading) return;
    const payload = {
      accountId,
      plan_id: planId,
      platform,
      mode,
    };
    if (isImprove) payload.current_copy = currentCopy || '';
    // complete() calls setCompletion('') internally before kicking off
    // the stream, so the previous result is cleared atomically.
    complete(instruction.trim(), { body: payload });
  }, [accountId, planId, platform, mode, isImprove, currentCopy, instruction, complete, isLoading]);

  const handleStop = () => {
    stop();
  };

  const handleAccept = () => {
    const text = completion?.trim();
    if (!text || isLoading) return;
    onAccept?.(text);
  };

  const handleDismiss = () => {
    stop();
    onDismiss?.();
  };

  const handleKeyDown = (e) => {
    // Cmd/Ctrl+Enter from the instruction textarea fires Generate.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const headTitle = isImprove
    ? `AI redraft for ${platformLabel}`
    : `AI draft for ${platformLabel}`;
  const instructionPlaceholder = isImprove
    ? "What should I change? e.g. 'make the hook punchier', 'add a call to action', 'shorter, no emojis'"
    : "What should this post be about? e.g. 'a Mother's Day post celebrating moms who run small businesses'. Leave empty to draft from the concept + brand voice alone.";
  const instructionLabel = isImprove ? "What to change" : "What this post should be about";

  return (
    <div className="ai-copy-preview" role="region" aria-label={headTitle}>
      <div className="ai-copy-preview-head">
        <span className="ai-copy-preview-label">
          <span aria-hidden style={{ marginRight: 6 }}>✨</span>
          {headTitle}
        </span>
        {phase === 'streaming' && <span className="ai-copy-preview-streaming">Generating…</span>}
      </div>

      <div className="ai-copy-preview-instruction">
        <label className="ai-copy-preview-instruction-label">{instructionLabel}</label>
        <textarea
          ref={instructionInputRef}
          className="ai-copy-preview-instruction-input"
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={instructionPlaceholder}
          disabled={isLoading}
        />
        <div className="ai-copy-preview-instruction-hint">
          {phase === 'compose' && '⌘↩ to generate'}
          {phase === 'done' && 'Edit your instruction and click Regenerate to iterate'}
        </div>
      </div>

      {(phase === 'streaming' || phase === 'done') && (
        <div className="ai-copy-preview-body">
          {completion ? (
            <pre>{completion}</pre>
          ) : (
            <div className="ai-copy-preview-skeleton">
              <span className="ai-copy-dot" /><span className="ai-copy-dot" /><span className="ai-copy-dot" />
            </div>
          )}
        </div>
      )}

      {phase === 'error' && error && (
        <div className="ai-copy-preview-error">
          <Icon name="alert" size={12} /> {error.message || String(error)}
        </div>
      )}

      <div className="ai-copy-preview-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleDismiss}
        >
          Discard
        </button>
        <span style={{ flex: 1 }} />
        {phase === 'streaming' && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleStop}
          >
            Stop
          </button>
        )}
        {(phase === 'done' || phase === 'error') && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleGenerate}
            title="Run again with the current instruction"
          >
            Regenerate
          </button>
        )}
        {phase === 'compose' && (
          <button
            type="button"
            className="btn btn-sm btn-primary ai-draft-btn"
            onClick={handleGenerate}
          >
            <span aria-hidden style={{ marginRight: 4 }}>✨</span>
            Generate
          </button>
        )}
        {phase === 'done' && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleAccept}
            disabled={!completion?.trim() || !!error}
            title={isImprove ? 'Replace current copy with this version' : 'Use this as the caption'}
          >
            {isImprove ? 'Replace with this' : 'Use this'}
          </button>
        )}
      </div>
    </div>
  );
};

export { AICopyPreview };
