// =====================================================================
// AICopyPreview — instruction-driven inline AI copy generation
// =====================================================================
//
// Used by PostPlanDetailView's per-platform copy editor. When the agency
// clicks "✨ AI draft" or "✨ AI redraft", this component opens and
// asks for a short instruction ("what should this be about?" for draft,
// "what should I change?" for redraft). The admin types their direction,
// clicks Generate, and the AI streams a caption suggestion into the same
// preview block.
//
// State machine:
//   compose   → instruction textarea visible, Generate button
//   streaming → text deltas accumulating, Stop button
//   done      → final text + action buttons (Use this / Regenerate /
//               Discard). Instruction textarea STAYS visible so the
//               admin can refine it and click Regenerate to iterate.
//   error     → error message, Retry / Discard
//
// For mode=improve, the API reads the plan's current copy server-side
// AND we pass the in-flight draft (which may include unsaved edits) as
// `current_copy`. The server uses it as the starting point and only
// changes what the admin's instruction asks for — preserving the rest.
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

const AICopyPreview = ({ accountId, planId, platform, mode = 'draft', currentCopy = '', onAccept, onDismiss }) => {
  // 'compose' | 'streaming' | 'done' | 'error'
  const [phase, setPhase] = useState('compose');
  const [instruction, setInstruction] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null);
  const abortRef = useRef(null);
  const instructionInputRef = useRef(null);

  const isImprove = mode === 'improve';
  const platformLabel = PLATFORM_LABEL[platform] || platform;

  // Autofocus the instruction textarea on mount.
  useEffect(() => {
    instructionInputRef.current?.focus();
  }, []);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const startStream = useCallback(async () => {
    setText('');
    setError('');
    setUsage(null);
    setPhase('streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const payload = {
        accountId,
        plan_id: planId,
        platform,
        mode,
        instruction: instruction.trim(),
      };
      if (isImprove) payload.current_copy = currentCopy || '';

      const resp = await fetch('/api/ai/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
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
      setPhase((prev) => (prev === 'streaming' ? 'done' : prev));
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stop pressed mid-stream — keep what we have, move to done if
        // we got anything, otherwise back to compose.
        setPhase((prev) => {
          if (prev !== 'streaming') return prev;
          return text.trim() ? 'done' : 'compose';
        });
      } else {
        setError(err.message || String(err));
        setPhase('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, [accountId, planId, platform, mode, instruction, isImprove, currentCopy, text]);

  const handleGenerate = () => {
    if (phase === 'streaming') return;
    startStream();
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleAccept = () => {
    if (!text.trim() || phase === 'streaming') return;
    onAccept?.(text.trim());
  };

  const handleDismiss = () => {
    abortRef.current?.abort();
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
        {phase === 'done' && usage && (
          <span className="ai-copy-preview-meta" title="input / output tokens">
            {usage.input ?? 0} in {usage.cacheRead ? `(${usage.cacheRead} cached)` : ''} · {usage.output ?? 0} out
          </span>
        )}
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
          disabled={phase === 'streaming'}
        />
        <div className="ai-copy-preview-instruction-hint">
          {phase === 'compose' && '⌘↩ to generate'}
          {phase === 'done' && 'Edit your instruction and click Regenerate to iterate'}
        </div>
      </div>

      {(phase === 'streaming' || phase === 'done') && (
        <div className="ai-copy-preview-body">
          {text ? (
            <pre>{text}</pre>
          ) : (
            <div className="ai-copy-preview-skeleton">
              <span className="ai-copy-dot" /><span className="ai-copy-dot" /><span className="ai-copy-dot" />
            </div>
          )}
        </div>
      )}

      {phase === 'error' && error && (
        <div className="ai-copy-preview-error">
          <Icon name="alert" size={12} /> {error}
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
            disabled={!text.trim() || !!error}
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
