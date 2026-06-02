// =====================================================================
// AIImagePromptPanel — AI-driven image direction → prompt flow
// =====================================================================
//
// LinkAI v2 Phase 2c: rewritten around two AI SDK hooks —
// `experimental_useObject` for the schema-driven ideas pass and
// `useCompletion` for the freeform prompt expansion. The v1 implementation
// kept a 7-phase state machine ('idle' → 'ideas_compose' → 'ideas_streaming'
// → 'ideas_picking' → 'prompt_compose' → 'prompt_streaming' → 'prompt_done'),
// hand-rolled `parseSse` async generator, a lenient `parseIdeasJson` parser
// that stripped ```json fences and tried to JSON.parse on done, manual
// abort controllers, and explicit usage state. All of that collapses
// to a `section` enum + two hooks' state. Progressive disclosure on the
// idea cards is a bonus — the cards render fields as the JSON streams in
// rather than waiting for stream completion.
//
// Wire protocol on /api/ai/image switched in the same PR — both modes
// now use the AI SDK's text-stream protocol via `pipeTextStreamToResponse`.
// The ideas mode streams JSON deltas (parsed by `useObject`); the prompt
// mode streams raw text (consumed by `useCompletion`).
//
// Request body shape change (prompt mode only): `details` → `prompt`.
// useCompletion always sends the admin's free-form direction as `prompt`
// (first arg to `complete()`); the server reads from `body.prompt`.
// Ideas-mode body shape is unchanged (useObject.submit() posts the
// input object verbatim).
//
// Behavior preserved:
//   - Two-step flow: ideas first, then expanded prompt for the chosen idea.
//   - Free navigation between sections via "← Different brief" and
//     "← Try another direction" buttons.
//   - Stop mid-stream keeps partial output (useObject + useCompletion
//     retain whatever streamed before abort).
//   - Copy-to-clipboard with 2s "Copied" confirmation pill.
//
// Behavior tweaked (intentional improvements):
//   - Idea cards render PROGRESSIVELY as the JSON streams (each card
//     fills in title → description → keywords as the stream lands).
//     v1 waited for the full stream then parsed-on-done.
//   - The inline usage meter is dropped (same tradeoff as Phase 2b
//     copy panel — useObject/useCompletion don't surface usage).
//     Cache observability moves to server logs (`[image] usage …`
//     in Vercel Function Logs).
// =====================================================================

/* eslint-disable */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { experimental_useObject as useObject, useCompletion } from '@ai-sdk/react';
import { z } from 'zod';
import { Icon } from './Icon.jsx';
import { supabase } from '../lib/supabase.js';
import { downscaleImageToDataUrl } from '../lib/imageDownscale.js';

// Mirror of the server's IDEAS_SCHEMA (web/api/ai/image.ts). useObject's
// `schema` option drives the type-validation behaviour of the hook —
// the streamed JSON deltas get parsed into DeepPartial<typeof schema>
// via parsePartialJson, so the schema must match the server's exactly.
// We intentionally drop the .min(3)/.max(5)/.describe() decorations from
// the server schema here — those are server-side hints to Claude; the
// client only needs the shape.
const IDEAS_SCHEMA = z.object({
  ideas: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      style_keywords: z.array(z.string()),
    }),
  ),
});

// Custom fetch wrapper that resolves the Supabase session token at
// request time and adds it as Authorization. Same pattern as
// AICopyPreview.jsx (Phase 2b) and the DefaultChatTransport in
// LinkAIPanel.jsx (Phase 2a).
async function fetchWithAuth(url, init) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  return fetch(url, { ...init, headers });
}

const PLATFORM_LABEL = { instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X' };

// Ephemeral reference-image limits. These images are held in component
// state and sent inline in the request body for ONE generation — never
// persisted. Server caps at the same count (web/api/ai/image.ts).
const MAX_REF_IMAGES = 3;
const REF_ACCEPTED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const REF_MAX_SOURCE_BYTES = 15 * 1024 * 1024; // pre-downscale guard

// Image downscaling lives in the shared `lib/imageDownscale.js` util
// (`downscaleImageToDataUrl`) — same one the LinkAI composer uses — so the
// ~1568px / JPEG / 4.5MB-body-limit rationale has a single source of truth.

// ---------------------------------------------------------------------------
// ProductRefStrip — EPHEMERAL reference-image uploader. Images live only in
// component state (held by the parent panel) and ride inline in the request
// body for ONE generation. Nothing is uploaded to storage or persisted.
// Controlled: `value` is the array of { id, dataUrl, mediaType, name },
// `onChange` updates it.
// ---------------------------------------------------------------------------
function ProductRefStrip({ value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const images = Array.isArray(value) ? value : [];

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setErr(''); setBusy(true);
    try {
      const room = MAX_REF_IMAGES - images.length;
      if (room <= 0) { setErr(`Up to ${MAX_REF_IMAGES} reference images.`); return; }
      const added = [];
      for (const f of files.slice(0, room)) {
        if (!REF_ACCEPTED_MIMES.includes(f.type)) { setErr('Use a PNG, JPEG, WebP or GIF image.'); continue; }
        if (f.size > REF_MAX_SOURCE_BYTES) { setErr(`"${f.name}" is too large.`); continue; }
        const dataUrl = await downscaleImageToDataUrl(f);
        added.push({
          id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          dataUrl,
          mediaType: 'image/jpeg',
          name: f.name || 'image',
        });
      }
      if (added.length) onChange([...images, ...added].slice(0, MAX_REF_IMAGES));
      if (files.length > room) setErr(`Up to ${MAX_REF_IMAGES} reference images — extra files skipped.`);
    } catch (ex) {
      setErr(ex?.message || 'Could not add the image.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = (id) => onChange(images.filter((i) => i.id !== id));

  return (
    <div className="ai-image-prodrefs">
      <div className="ai-image-prodrefs-head">
        <label className="ai-image-label" style={{ margin: 0 }}>Reference images (optional)</label>
        <span className="ai-image-prodrefs-hint">
          {images.length === 0
            ? 'Attach the real product / a moodboard — used for this prompt only, not saved'
            : `${images.length}/${MAX_REF_IMAGES} attached · the AI references these for this prompt only`}
        </span>
      </div>

      <div className="ai-image-prodrefs-row">
        {images.map((p) => (
          <div key={p.id} className="ai-image-prodref-thumb" title={p.name || 'Reference image'}>
            <span
              className="ai-image-prodref-img"
              style={{ backgroundImage: `url(${JSON.stringify(p.dataUrl)})` }}
              role="img"
              aria-label={p.name || 'Reference image'}
            />
            <button
              type="button"
              className="ai-image-prodref-remove"
              onClick={() => remove(p.id)}
              title="Remove"
              aria-label="Remove reference image"
            ><Icon name="x" size={10}/></button>
          </div>
        ))}

        {images.length < MAX_REF_IMAGES && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => addFiles(e.target.files)}
            />
            <button
              type="button"
              className="ai-image-prodref-add"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title="Attach a reference image for this prompt"
            >
              {busy ? <span className="ai-image-prodref-spin">…</span> : (
                <><Icon name="plus" size={14}/><span>Add</span></>
              )}
            </button>
          </>
        )}
      </div>

      {err && <div className="ai-image-error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

const AIImagePromptPanel = ({ accountId, planId, platform, defaultOpen = false }) => {
  // Top-level navigation:
  //   'idle'  — collapsed entry-point card with the launch button
  //   'ideas' — ideas section (compose / streaming / picking sub-phases
  //             derived from ideasHook state)
  //   'prompt'— prompt section (compose / streaming / done sub-phases
  //             derived from promptHook state)
  // Note: there's no explicit 'error' section — hook errors render
  // inline in whichever section is active, with a Retry affordance.
  const [section, setSection] = useState(defaultOpen ? 'ideas' : 'idle');

  // Composer state for the two textareas. Persisted across section
  // changes so the admin's typing isn't lost if they navigate back.
  const [brief, setBrief] = useState('');
  const [details, setDetails] = useState('');

  // The idea the admin picked from the ideas grid. Cleared when they
  // "← Try another direction" back to the picker, or close the panel.
  const [chosenIdea, setChosenIdea] = useState(null);

  // Ephemeral reference images for THIS prompt-gen session. Held in memory
  // as downscaled JPEG data URLs, sent inline in the request body for both
  // modes, and discarded on reset/close — never persisted. Kept across the
  // ideas→prompt step so the chosen direction expands with the same refs.
  const [refImages, setRefImages] = useState([]);
  const refImagesBody = useMemo(
    () => refImages.map((i) => ({ dataUrl: i.dataUrl, mediaType: i.mediaType })),
    [refImages],
  );

  // Copy-to-clipboard confirmation pill toggle.
  const [copied, setCopied] = useState(false);

  const briefRef = useRef(null);
  const detailsRef = useRef(null);

  // ----- ideas hook -----
  // experimental_useObject expects the server to stream JSON deltas
  // that match `schema` (text-stream protocol via pipeTextStreamToResponse
  // server-side). `object` is DeepPartial<infer<schema>> and updates as
  // the stream progresses — cards render progressively.
  const ideasHook = useObject({
    api: '/api/ai/image',
    schema: IDEAS_SCHEMA,
    fetch: fetchWithAuth,
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error('[AIImagePromptPanel/ideas] error:', err);
    },
  });

  // ----- prompt hook -----
  // useCompletion w/ streamProtocol: 'text' — same pattern as Phase 2b
  // AICopyPreview. Sends `{ prompt, ...body }` where `prompt` is the
  // admin's "additional details" input.
  const promptHook = useCompletion({
    api: '/api/ai/image',
    streamProtocol: 'text',
    fetch: fetchWithAuth,
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error('[AIImagePromptPanel/prompt] error:', err);
    },
  });

  // Cancel any in-flight streams on unmount. Capture stops via refs so
  // the cleanup runs ONLY on unmount and sees the latest controllers.
  // Same pattern as Phase 2b — useObject/useCompletion's stop closes
  // over the active AbortController so the initial render's stop is a
  // no-op.
  const ideasStopRef = useRef(ideasHook.stop);
  ideasStopRef.current = ideasHook.stop;
  const promptStopRef = useRef(promptHook.stop);
  promptStopRef.current = promptHook.stop;
  useEffect(() => () => {
    ideasStopRef.current();
    promptStopRef.current();
  }, []);

  // Autofocus the right input when switching into a compose phase.
  useEffect(() => {
    if (section === 'ideas' && !ideasHook.isLoading && !hasParsedIdeas()) {
      briefRef.current?.focus();
    }
    if (section === 'prompt' && chosenIdea && !promptHook.isLoading && !promptHook.completion) {
      detailsRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, chosenIdea, ideasHook.isLoading, promptHook.isLoading]);

  // Reset copy-confirmation pill after 2s.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Derive the ideas list from useObject's DeepPartial output. Each
  // entry may have undefined / empty fields while streaming — we
  // preserve incomplete entries so the UI can show progressive cards.
  // `hasParsedIdeas` is the gate that decides "show picker vs compose".
  const ideas = useMemo(() => {
    const arr = ideasHook.object?.ideas;
    if (!Array.isArray(arr)) return [];
    return arr.map((i, idx) => ({
      id: `idea-${idx}`,
      title: typeof i?.title === 'string' ? i.title.trim() : '',
      description: typeof i?.description === 'string' ? i.description.trim() : '',
      styleKeywords: Array.isArray(i?.style_keywords)
        ? i.style_keywords.map(String).filter((k) => k.trim())
        : [],
    }));
  }, [ideasHook.object]);

  function hasParsedIdeas() {
    return ideas.some((i) => i.title && i.description);
  }

  // ----- navigation handlers -----

  const open = () => setSection('ideas');

  const reset = () => {
    ideasHook.stop();
    promptHook.stop();
    ideasHook.clear();
    promptHook.setCompletion('');
    setSection('idle');
    setBrief('');
    setDetails('');
    setChosenIdea(null);
    setRefImages([]);
  };

  const generateIdeas = useCallback(() => {
    setChosenIdea(null);
    promptHook.setCompletion('');
    ideasHook.submit({
      accountId,
      plan_id: planId,
      platform,
      mode: 'ideas',
      brief: brief.trim(),
      reference_images: refImagesBody,
    });
  }, [accountId, planId, platform, brief, refImagesBody, ideasHook, promptHook]);

  const backToBrief = () => {
    // "← Different brief" — clear the ideas state and the chosen idea,
    // keep the brief textarea so admin can refine. The ideas grid
    // disappears and the brief composer reappears.
    ideasHook.clear();
    setChosenIdea(null);
    promptHook.setCompletion('');
  };

  const pickIdea = (idea) => {
    setChosenIdea(idea);
    promptHook.setCompletion('');
    setDetails('');
    setSection('prompt');
  };

  const generatePrompt = useCallback(() => {
    if (!chosenIdea) return;
    promptHook.complete(details.trim(), {
      body: {
        accountId,
        plan_id: planId,
        platform,
        mode: 'prompt',
        idea_title: chosenIdea.title,
        idea_description: chosenIdea.description,
        idea_style_keywords: chosenIdea.styleKeywords,
        reference_images: refImagesBody,
      },
    });
  }, [accountId, planId, platform, chosenIdea, details, refImagesBody, promptHook]);

  const backToPicking = () => {
    // From prompt_compose OR prompt_done. Keep the ideas state intact
    // so the user can pick a different one without regenerating.
    promptHook.stop();
    promptHook.setCompletion('');
    setChosenIdea(null);
    setSection('ideas');
  };

  const handleCopy = async () => {
    const text = promptHook.completion?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Old-school selection fallback for browsers that block
      // clipboard API on insecure / iframe contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); } catch {}
      document.body.removeChild(ta);
    }
  };

  const platformLabel = PLATFORM_LABEL[platform] || platform;

  // ----- derived UI sub-phase -----
  // The render path is determined by section + hook state. Kept in
  // local vars (not state) so it can never drift out of sync with the
  // hooks' isLoading / completion / error.
  let subPhase = 'compose';
  if (section === 'ideas') {
    if (ideasHook.error) subPhase = 'error';
    else if (ideasHook.isLoading && !hasParsedIdeas()) subPhase = 'streaming';
    else if (hasParsedIdeas()) subPhase = 'picking';
    else subPhase = 'compose';
  } else if (section === 'prompt') {
    if (promptHook.error) subPhase = 'error';
    else if (promptHook.isLoading) subPhase = 'streaming';
    else if (promptHook.completion) subPhase = 'done';
    else subPhase = 'compose';
  }

  // ----- collapsed idle state -----
  if (section === 'idle') {
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

  // ----- full expanded card -----
  const cardSub = (() => {
    if (section === 'ideas') {
      if (subPhase === 'compose') return `Tell us roughly what you have in mind — or just hit Generate to see ${platformLabel} directions from the brand voice + concept.`;
      if (subPhase === 'streaming') return 'Generating directions…';
      if (subPhase === 'picking') return ideasHook.isLoading
        ? 'Picking up directions as they stream in — wait for them to finish, then choose one.'
        : 'Pick a direction to expand into a detailed prompt.';
      if (subPhase === 'error') return 'Something went wrong generating ideas.';
    }
    if (section === 'prompt') {
      if (subPhase === 'compose') return 'Add any extra details, or hit Generate to write the prompt from the chosen direction.';
      if (subPhase === 'streaming') return 'Writing the detailed prompt…';
      if (subPhase === 'done') return 'Detailed prompt ready — copy it into your image tool.';
      if (subPhase === 'error') return 'Something went wrong generating the prompt.';
    }
    return '';
  })();

  const activeError = section === 'ideas' ? ideasHook.error : promptHook.error;

  return (
    <div className="card ai-image-card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">
            <span aria-hidden style={{ marginRight: 6 }}>✨</span>
            AI image prompts
          </div>
          <div className="card-sub">{cardSub}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
        {/* Ephemeral reference images for this generation only — attached
            inline, sent in the request body, never persisted. Shown on the
            compose steps where the admin is about to generate. */}
        {((section === 'ideas' && subPhase === 'compose') ||
          (section === 'prompt' && subPhase === 'compose')) && (
          <ProductRefStrip value={refImages} onChange={setRefImages} />
        )}

        {/* IDEAS — COMPOSE */}
        {section === 'ideas' && subPhase === 'compose' && (
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

        {/* IDEAS — STREAMING (no cards parsed yet) */}
        {section === 'ideas' && subPhase === 'streaming' && (
          <div className="ai-image-section">
            <div className="ai-image-streaming-row">
              <span className="link-ai-dot"/>
              <span className="link-ai-dot"/>
              <span className="link-ai-dot"/>
              <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--ink-4)' }}>
                Generating direction ideas…
              </span>
            </div>
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              <button type="button" className="btn btn-sm btn-ghost" onClick={ideasHook.stop}>
                Stop
              </button>
            </div>
          </div>
        )}

        {/* IDEAS — PICKING (cards present; may still be streaming additional ones) */}
        {section === 'ideas' && subPhase === 'picking' && (
          <div className="ai-image-section">
            <div className="ai-image-ideas-grid">
              {ideas.map((idea) => {
                const isComplete = idea.title && idea.description;
                return (
                  <button
                    key={idea.id}
                    type="button"
                    className="ai-image-idea-card"
                    onClick={() => isComplete && pickIdea(idea)}
                    disabled={!isComplete || ideasHook.isLoading}
                    title={isComplete ? undefined : 'Still streaming…'}
                  >
                    <div className="ai-image-idea-title">
                      {idea.title || <span style={{ opacity: 0.4 }}>…</span>}
                    </div>
                    <div className="ai-image-idea-desc">
                      {idea.description || <span style={{ opacity: 0.4 }}>generating…</span>}
                    </div>
                    {idea.styleKeywords.length > 0 && (
                      <div className="ai-image-idea-keywords">
                        {idea.styleKeywords.map((k, i) => (
                          <span key={i} className="ai-image-idea-keyword">{k}</span>
                        ))}
                      </div>
                    )}
                    {isComplete && <div className="ai-image-idea-cta">Use this direction →</div>}
                  </button>
                );
              })}
            </div>
            <div className="ai-image-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={backToBrief}
                disabled={ideasHook.isLoading}
              >
                ← Different brief
              </button>
              <span style={{ flex: 1 }}/>
              {ideasHook.isLoading ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={ideasHook.stop}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={generateIdeas}
                  title="Get 3-5 fresh directions with the same brief"
                >
                  Regenerate ideas
                </button>
              )}
            </div>
          </div>
        )}

        {/* PROMPT — COMPOSE */}
        {section === 'prompt' && subPhase === 'compose' && chosenIdea && (
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
                onClick={backToPicking}
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

        {/* PROMPT — STREAMING */}
        {section === 'prompt' && subPhase === 'streaming' && (
          <div className="ai-image-section">
            {chosenIdea && (
              <div className="ai-image-chosen ai-image-chosen-compact">
                <span className="ai-image-chosen-label">Direction:</span>
                <span style={{ marginLeft: 6, fontWeight: 500 }}>{chosenIdea.title}</span>
              </div>
            )}
            <div className="ai-image-prompt-box">
              {promptHook.completion ? <pre>{promptHook.completion}</pre> : (
                <div className="ai-image-streaming-row">
                  <span className="link-ai-dot"/>
                  <span className="link-ai-dot"/>
                  <span className="link-ai-dot"/>
                </div>
              )}
            </div>
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              <button type="button" className="btn btn-sm btn-ghost" onClick={promptHook.stop}>
                Stop
              </button>
            </div>
          </div>
        )}

        {/* PROMPT — DONE */}
        {section === 'prompt' && subPhase === 'done' && (
          <div className="ai-image-section">
            {chosenIdea && (
              <div className="ai-image-chosen ai-image-chosen-compact">
                <span className="ai-image-chosen-label">Direction:</span>
                <span style={{ marginLeft: 6, fontWeight: 500 }}>{chosenIdea.title}</span>
              </div>
            )}
            <div className="ai-image-prompt-box">
              <pre>{promptHook.completion}</pre>
            </div>
            <div className="ai-image-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={backToPicking}
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

        {/* ERROR (inline; section determines the Retry path) */}
        {subPhase === 'error' && (
          <div className="ai-image-section">
            <div className="ai-image-error">
              <Icon name="alert" size={12}/> {activeError?.message || String(activeError)}
            </div>
            <div className="ai-image-actions">
              <span style={{ flex: 1 }}/>
              {section === 'ideas' ? (
                <>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={backToBrief}>
                    Back to brief
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={generateIdeas}>
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={backToPicking}>
                    Pick a different direction
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={generatePrompt}>
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export { AIImagePromptPanel };
