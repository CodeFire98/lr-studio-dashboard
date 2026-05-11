// =====================================================================
// AICopyPreview — inline streaming preview for AI-drafted post copy
// =====================================================================
//
// Used by PostPlanDetailView's per-platform copy editor. When the agency
// clicks "✨ Draft" next to the copy textarea, this component appears
// below it, streams the AI's caption suggestion in, and offers
// "Use this" / "Discard" actions.
//
// Streaming uses the same SSE protocol as /api/ai/chat — we parse it
// here inline since it's a single-purpose, single-stream consumer (no
// tool-use events to interleave). When the panel chat grows to share
// more code with this component, extract a shared SSE helper.
//
// The component owns its own stream lifecycle and aborts on unmount —
// if the user dismisses the preview mid-stream, we don't burn tokens
// generating text nobody will see.
// =====================================================================

/* eslint-disable */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Icon } from './Icon.jsx';
import { supabase } from '../lib/supabase.js';

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

const PLATFORM_LABEL = { instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X' };

const AICopyPreview = ({ accountId, planId, platform, hasExistingCopy, onAccept, onDismiss }) => {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(true);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null);
  const abortRef = useRef(null);
  const startedRef = useRef(false);

  const startStream = useCallback(async () => {
    setText('');
    setError('');
    setStreaming(true);
    setUsage(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const resp = await fetch('/api/ai/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          accountId,
          plan_id: planId,
          platform,
          mode: 'draft',
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(errBody.error || `HTTP ${resp.status}`);
      }

      for await (const evt of parseSse(resp)) {
        if (evt.event === 'text') {
          setText((prev) => prev + (evt.data.delta || ''));
        } else if (evt.event === 'usage') {
          setUsage({
            input: evt.data.input_tokens,
            output: evt.data.output_tokens,
            cacheRead: evt.data.cache_read_input_tokens,
          });
        } else if (evt.event === 'error') {
          setError(evt.data.error || 'Unknown error');
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || String(err));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [accountId, planId, platform]);

  // Auto-start once on mount; abort on unmount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startStream();
    return () => abortRef.current?.abort();
  }, [startStream]);

  const handleAccept = () => {
    if (!text.trim() || streaming) return;
    onAccept?.(text.trim());
  };

  const handleDismiss = () => {
    abortRef.current?.abort();
    onDismiss?.();
  };

  const handleRegenerate = () => {
    abortRef.current?.abort();
    startedRef.current = false;
    setTimeout(() => {
      startedRef.current = true;
      startStream();
    }, 0);
  };

  return (
    <div className="ai-copy-preview" role="region" aria-label={`AI draft for ${PLATFORM_LABEL[platform] || platform}`}>
      <div className="ai-copy-preview-head">
        <span className="ai-copy-preview-label">
          <span aria-hidden style={{ marginRight: 6 }}>✨</span>
          AI draft for {PLATFORM_LABEL[platform] || platform}
        </span>
        {streaming && <span className="ai-copy-preview-streaming">Generating…</span>}
        {!streaming && usage && (
          <span className="ai-copy-preview-meta" title="input / output tokens">
            {usage.input ?? 0} in {usage.cacheRead ? `(${usage.cacheRead} cached)` : ''} · {usage.output ?? 0} out
          </span>
        )}
      </div>

      <div className="ai-copy-preview-body">
        {text ? (
          <pre>{text}</pre>
        ) : streaming ? (
          <div className="ai-copy-preview-skeleton">
            <span className="ai-copy-dot" /><span className="ai-copy-dot" /><span className="ai-copy-dot" />
          </div>
        ) : null}
      </div>

      {error && (
        <div className="ai-copy-preview-error">
          <Icon name="alert" size={12} /> {error}
        </div>
      )}

      <div className="ai-copy-preview-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleDismiss}
          disabled={false}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleRegenerate}
          disabled={streaming}
          title="Generate a different draft"
        >
          Regenerate
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={handleAccept}
          disabled={streaming || !text.trim() || !!error}
          title={hasExistingCopy ? 'Replace current copy with this draft' : 'Use this draft'}
        >
          {hasExistingCopy ? 'Replace with this' : 'Use this'}
        </button>
      </div>
    </div>
  );
};

export { AICopyPreview };
