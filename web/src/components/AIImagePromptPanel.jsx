// =====================================================================
// AIImagePromptPanel — AI-driven image direction → prompt flow
// =====================================================================
//
// Surface: PostPlanDetailView, sits above the Deliverables card. Lets
// the admin generate detailed image prompts in two steps so they get
// directional choice rather than one random shot:
//
//   1) Ideas phase — admin types an optional brief, clicks "Generate
//      ideas". AI returns 3-5 image direction cards (different angles).
//   2) Prompt phase — admin clicks an idea card, optionally types extra
//      details, clicks "Generate prompt". AI streams a detailed
//      paste-ready image prompt for Midjourney / DALL-E / Imagen / etc.
//
// State machine:
//   idle             → just the "✨ Image ideas" button + collapsed help
//   ideas_compose    → optional brief textarea + Generate ideas
//   ideas_streaming  → JSON streaming in (raw text accumulator)
//   ideas_picking    → 3-5 idea cards, click to pick
//   prompt_compose   → chosen idea shown + details textarea + Generate
//   prompt_streaming → prompt text streaming
//   prompt_done      → final prompt + Copy + Try-another-idea + Regen
//   error            → error message + Retry
//
// The admin can navigate freely between phases — "Try another direction"
// from prompt_done goes back to ideas_picking; "Different brief" from
// ideas_picking goes back to ideas_compose with the brief preserved.
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

// Lenient JSON parse — model occasionally adds a stray newline / leading
// space despite the system prompt; strip markdown fences if it ignored
// our "no markdown" instruction.
function parseIdeasJson(raw) {
  if (!raw) return null;
  let text = raw.trim();
  // Strip ```json ... ``` fences if present.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.ideas)) return null;
    return parsed.ideas
      .filter((i) => i && typeof i === 'object')
      .map((i, idx) => ({
        id: `idea-${idx}`,
        title: String(i.title || '').trim() || `Direction ${idx + 1}`,
        description: String(i.description || '').trim(),
        styleKeywords: Array.isArray(i.style_keywords)
          ? i.style_keywords.map(String).filter(Boolean)
          : [],
      }));
  } catch {
    return null;
  }
}

const PLATFORM_LABEL = { instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X' };

const AIImagePromptPanel = ({ accountId, planId, platform, defaultOpen = false }) => {
  // Phase tracks where we are in the flow.
  const [phase, setPhase] = useState(defaultOpen ? 'ideas_compose' : 'idle');
  const [brief, setBrief] = useState('');
  const [ideasRaw, setIdeasRaw] = useState('');
  const [ideas, setIdeas] = useState([]);
  const [chosenIdea, setChosenIdea] = useState(null);
  const [details, setDetails] = useState('');
  const [promptText, setPromptText] = useState('');
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);
  const briefRef = useRef(null);
  const detailsRef = useRef(null);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Autofocus the right input when we switch into a compose phase.
  useEffect(() => {
    if (phase === 'ideas_compose') briefRef.current?.focus();
    if (phase === 'prompt_compose') detailsRef.current?.focus();
  }, [phase]);

  // Reset copy-confirmation pill after 2s.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const open = () => setPhase('ideas_compose');
  const reset = () => {
    abortRef.current?.abort();
    setPhase('idle');
    setBrief('');
    setIdeasRaw('');
    setIdeas([]);
    setChosenIdea(null);
    setDetails('');
    setPromptText('');
    setUsage(null);
    setError('');
  };

  const generateIdeas = useCallback(async () => {
    setIdeasRaw('');
    setIdeas([]);
    setUsage(null);
    setError('');
    setPhase('ideas_streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const resp = await fetch('/api/ai/image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          accountId,
          plan_id: planId,
          platform,
          mode: 'ideas',
          brief: brief.trim(),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(errBody.error || `HTTP ${resp.status}`);
      }

      let accum = '';
      for await (const evt of parseSse(resp)) {
        if (evt.event === 'text') {
          accum += evt.data.delta || '';
          setIdeasRaw(accum);
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

      const parsed = parseIdeasJson(accum);
      if (!parsed || parsed.length === 0) {
        setError("Couldn't parse the AI's response into idea cards. Try regenerating.");
        setPhase('error');
        return;
      }
      setIdeas(parsed);
      setPhase('ideas_picking');
    } catch (err) {
      if (err.name === 'AbortError') {
        setPhase('ideas_compose');
        return;
      }
      setError(err.message || String(err));
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }, [accountId, planId, platform, brief]);

  const pickIdea = (idea) => {
    setChosenIdea(idea);
    setDetails('');
    setPromptText('');
    setUsage(null);
    setError('');
    setPhase('prompt_compose');
  };

  const generatePrompt = useCallback(async () => {
    if (!chosenIdea) return;
    setPromptText('');
    setError('');
    setUsage(null);
    setPhase('prompt_streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const resp = await fetch('/api/ai/image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          accountId,
          plan_id: planId,
          platform,
          mode: 'prompt',
          idea_title: chosenIdea.title,
          idea_description: chosenIdea.description,
          idea_style_keywords: chosenIdea.styleKeywords,
          details: details.trim(),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(errBody.error || `HTTP ${resp.status}`);
      }

      for await (const evt of parseSse(resp)) {
        if (evt.event === 'text') {
          setPromptText((prev) => prev + (evt.data.delta || ''));
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
      setPhase((prev) => (prev === 'prompt_streaming' ? 'prompt_done' : prev));
    } catch (err) {
      if (err.name === 'AbortError') {
        setPhase((prev) => prev === 'prompt_streaming' && promptText.trim() ? 'prompt_done' : 'prompt_compose');
        return;
      }
      setError(err.message || String(err));
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }, [accountId, planId, platform, chosenIdea, details, promptText]);

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleCopy = async () => {
    if (!promptText.trim()) return;
    try {
      await navigator.clipboard.writeText(promptText.trim());
      setCopied(true);
    } catch {
      // Fallback — old-school selection
      const ta = document.createElement('textarea');
      ta.value = promptText.trim();
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); } catch {}
      document.body.removeChild(ta);
    }
  };

  const platformLabel = PLATFORM_LABEL[platform] || platform;

  // Render — collapsed entry point when idle, full card otherwise.
  if (phase === 'idle') {
    return (
      <div className="card ai-image-card-collapsed" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">AI image prompts</div>
            <div className="card-sub">
              Get 3-5 image direction ideas, pick one, and generate a detailed prompt to paste into your image tool.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm ai-image-launch"
            onClick={open}
          >
            <span aria-hidden style={{ marginRight: 4 }}>✨</span>
            Start image ideas
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card ai-image-card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">
            <span aria-hidden style={{ marginRight: 6 }}>✨</span>
            AI image prompts
          </div>
          <div className="card-sub">
            {phase === 'ideas_compose' && `Tell us roughly what you have in mind — or just hit Generate to see ${platformLabel} directions from the brand voice + concept.`}
            {phase === 'ideas_streaming' && 'Generating directions…'}
            {phase === 'ideas_picking' && 'Pick a direction to expand into a detailed prompt.'}
            {phase === 'prompt_compose' && 'Add any extra details, or hit Generate to write the prompt from the chosen direction.'}
            {phase === 'prompt_streaming' && 'Writing the detailed prompt…'}
            {phase === 'prompt_done' && 'Detailed prompt ready — copy it into your image tool.'}
            {phase === 'error' && 'Something went wrong.'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {usage && (
            <span className="ai-image-meta" title="input / output tokens">
              {usage.input ?? 0} in {usage.cacheRead ? `(${usage.cacheRead} cached)` : ''} · {usage.output ?? 0} out
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={reset}
            title="Close and reset"
          >
            <Icon name="x" size={12}/>
          </button>
        </div>
      </div>

      <div style={{ padding: '0 16px 16px' }}>
        {/* IDEAS COMPOSE */}
        {phase === 'ideas_compose' && (
          <div className="ai-image-section">
            <label className="ai-image-label">Optional brief</label>
            <textarea
              ref={briefRef}
              rows={2}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. 'something playful for the holiday line' — leave empty to draft from the post concept alone"
              className="ai-image-input"
            />
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              <button
                type="button"
                className="btn btn-sm btn-primary ai-draft-btn"
                onClick={generateIdeas}
              >
                <span aria-hidden style={{ marginRight: 4 }}>✨</span>
                Generate ideas
              </button>
            </div>
          </div>
        )}

        {/* IDEAS STREAMING */}
        {phase === 'ideas_streaming' && (
          <div className="ai-image-section">
            <div className="ai-image-streaming-row">
              <span className="copilot-dot"/>
              <span className="copilot-dot"/>
              <span className="copilot-dot"/>
              <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--ink-4)' }}>
                Generating direction ideas…
              </span>
            </div>
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              <button type="button" className="btn btn-sm btn-ghost" onClick={handleStop}>
                Stop
              </button>
            </div>
          </div>
        )}

        {/* IDEAS PICKING */}
        {phase === 'ideas_picking' && (
          <div className="ai-image-section">
            <div className="ai-image-ideas-grid">
              {ideas.map((idea) => (
                <button
                  key={idea.id}
                  type="button"
                  className="ai-image-idea-card"
                  onClick={() => pickIdea(idea)}
                >
                  <div className="ai-image-idea-title">{idea.title}</div>
                  <div className="ai-image-idea-desc">{idea.description}</div>
                  {idea.styleKeywords.length > 0 && (
                    <div className="ai-image-idea-keywords">
                      {idea.styleKeywords.map((k, i) => (
                        <span key={i} className="ai-image-idea-keyword">{k}</span>
                      ))}
                    </div>
                  )}
                  <div className="ai-image-idea-cta">Use this direction →</div>
                </button>
              ))}
            </div>
            <div className="ai-image-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setPhase('ideas_compose')}
              >
                ← Different brief
              </button>
              <span style={{ flex: 1 }}/>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={generateIdeas}
                title="Get 3-5 fresh directions with the same brief"
              >
                Regenerate ideas
              </button>
            </div>
          </div>
        )}

        {/* PROMPT COMPOSE */}
        {phase === 'prompt_compose' && chosenIdea && (
          <div className="ai-image-section">
            <div className="ai-image-chosen">
              <div className="ai-image-chosen-label">Chosen direction</div>
              <div className="ai-image-chosen-title">{chosenIdea.title}</div>
              <div className="ai-image-chosen-desc">{chosenIdea.description}</div>
              {chosenIdea.styleKeywords.length > 0 && (
                <div className="ai-image-idea-keywords" style={{ marginTop: 6 }}>
                  {chosenIdea.styleKeywords.map((k, i) => (
                    <span key={i} className="ai-image-idea-keyword">{k}</span>
                  ))}
                </div>
              )}
            </div>
            <label className="ai-image-label" style={{ marginTop: 12 }}>
              Additional details (optional)
            </label>
            <textarea
              ref={detailsRef}
              rows={3}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="e.g. 'include hands holding the product', 'overcast morning light', 'shot on film' — anything you want the prompt to incorporate"
              className="ai-image-input"
            />
            <div className="ai-image-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setPhase('ideas_picking')}
              >
                ← Pick a different direction
              </button>
              <span style={{ flex: 1 }}/>
              <button
                type="button"
                className="btn btn-sm btn-primary ai-draft-btn"
                onClick={generatePrompt}
              >
                <span aria-hidden style={{ marginRight: 4 }}>✨</span>
                Generate prompt
              </button>
            </div>
          </div>
        )}

        {/* PROMPT STREAMING */}
        {phase === 'prompt_streaming' && (
          <div className="ai-image-section">
            {chosenIdea && (
              <div className="ai-image-chosen ai-image-chosen-compact">
                <span className="ai-image-chosen-label">Direction:</span>
                <span style={{ marginLeft: 6, fontWeight: 500 }}>{chosenIdea.title}</span>
              </div>
            )}
            <div className="ai-image-prompt-box">
              {promptText ? <pre>{promptText}</pre> : (
                <div className="ai-image-streaming-row">
                  <span className="copilot-dot"/>
                  <span className="copilot-dot"/>
                  <span className="copilot-dot"/>
                </div>
              )}
            </div>
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              <button type="button" className="btn btn-sm btn-ghost" onClick={handleStop}>
                Stop
              </button>
            </div>
          </div>
        )}

        {/* PROMPT DONE */}
        {phase === 'prompt_done' && (
          <div className="ai-image-section">
            {chosenIdea && (
              <div className="ai-image-chosen ai-image-chosen-compact">
                <span className="ai-image-chosen-label">Direction:</span>
                <span style={{ marginLeft: 6, fontWeight: 500 }}>{chosenIdea.title}</span>
              </div>
            )}
            <div className="ai-image-prompt-box">
              <pre>{promptText}</pre>
            </div>
            <div className="ai-image-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setPhase('ideas_picking')}
              >
                ← Try another direction
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={generatePrompt}
                title="Regenerate the prompt with the current details"
              >
                Regenerate
              </button>
              <span style={{ flex: 1 }}/>
              <button
                type="button"
                className={"btn btn-sm btn-primary ai-image-copy " + (copied ? 'is-copied' : '')}
                onClick={handleCopy}
              >
                {copied ? (
                  <><Icon name="check" size={12} style={{ marginRight: 4 }}/>Copied</>
                ) : (
                  'Copy prompt'
                )}
              </button>
            </div>
          </div>
        )}

        {/* ERROR */}
        {phase === 'error' && (
          <div className="ai-image-section">
            <div className="ai-image-error">
              <Icon name="alert" size={12}/> {error}
            </div>
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPhase('ideas_compose')}>
                Back to start
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export { AIImagePromptPanel };
