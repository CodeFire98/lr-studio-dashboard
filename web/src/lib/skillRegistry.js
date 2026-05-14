// =====================================================================
// Linkrunner Media — Marketing skills registry
// =====================================================================
//
// Static list of marketing playbooks the AI Co-pilot can load on demand
// via the `load_skill` and `load_skill_reference` tools. Each skill is a
// markdown playbook covering one craft area — social content, copywriting,
// launch strategy, etc. — plus optional reference docs for deeper material
// (post templates, copy frameworks, idea catalogues).
//
// Why a registry instead of inlining all skills into the system prompt:
//   - The 7 skills total ~3,800 lines of markdown (~38K tokens). Inlining
//     would bloat every chat turn even when the model doesn't need most
//     of the content. The registry only ships a ~700-token MENU in the
//     system prompt; the bodies are loaded by tool call when relevant.
//   - Each skill body is ~1,500-4,500 tokens. Loaded once per
//     conversation, then rides in context for subsequent steps.
//   - References (post-templates, copy-frameworks, etc.) are loaded
//     separately for two-tier depth: the top-level SKILL gives the
//     framework, references give the deep material.
//
// Source: https://github.com/coreyhaines31/marketingskills (MIT). The 7
// skills here are the ones directly relevant to a social-content creative
// agency. The other 24 (CRO, SEO, paid ads, RevOps, etc.) are off-topic
// and not bundled.
//
// File layout: web/src/data/skills/<slug>/SKILL.md + references/<ref>.md
//
// Bundling: the .md files are loaded at request time via fs.readFileSync.
// vercel.json's functions.includeFiles config ships them with the API
// route's serverless bundle. See PR notes / REFERENCE.md for the runtime
// path resolution detail.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// SKILL_MENU is the static metadata baked into the system prompt. Each
// entry has a slug (matching the directory name + the tool input enum),
// a human title, and a `when_to_load` description — phrased so the model
// can match the admin's request against the right skill without loading
// every body.
//
// references[] lists the slugs of available deep-dive docs for the
// load_skill_reference tool. Surfaced to the model in the load_skill
// response so it knows what additional material is available before
// deciding to fetch more.
export const SKILL_MENU = [
  {
    slug: 'social-content',
    title: 'Social Content',
    when_to_load:
      'Use for ongoing social-media post creation, weekly planning, repurposing one idea across platforms, hook formulas, content pillars, viral patterns. The default skill for "plan a post / plan my week / what should I post" requests.',
    references: ['platforms', 'post-templates', 'reverse-engineering'],
  },
  {
    slug: 'content-strategy',
    title: 'Content Strategy',
    when_to_load:
      'Use when the admin wants to plan a content strategy, decide what content to create across a quarter or year, build content pillars, or design an editorial calendar at a HIGHER level than individual posts. For individual post drafting, use social-content instead.',
    references: [],
  },
  {
    slug: 'copywriting',
    title: 'Copywriting',
    when_to_load:
      'Use when the admin needs help writing or rewriting captions/copy that feels generic, weak, or off-voice. Loads the AIDA / PAS / Before-After-Bridge frameworks plus hook patterns and natural transitions. Best when an existing draft needs to be SHARPER, not just longer.',
    references: ['copy-frameworks', 'natural-transitions'],
  },
  {
    slug: 'copy-editing',
    title: 'Copy Editing',
    when_to_load:
      'Use to edit/polish existing copy — plain-English swaps, weak-word removal, sentence variation, end-strong rule. Best when the admin says "tighten this", "edit this", "review this draft", or asks for a final polish pass on something close to done.',
    references: ['plain-english-alternatives'],
  },
  {
    slug: 'marketing-psychology',
    title: 'Marketing Psychology',
    when_to_load:
      'Use when a campaign needs an angle that taps a psychological lever (social proof, scarcity, curiosity gap, loss aversion, anchoring). Best when the admin wants to make a piece of content land harder, not just sound nicer.',
    references: [],
  },
  {
    slug: 'marketing-ideas',
    title: 'Marketing Ideas',
    when_to_load:
      'Use when the admin is stuck on "what should I post next" or brainstorming a campaign and wants a wide pool of starting points. Loads 140 idea prompts categorised by goal (awareness / acquisition / activation / retention). Great cold-start material.',
    references: ['ideas-by-category'],
  },
  {
    slug: 'launch-strategy',
    title: 'Launch Strategy',
    when_to_load:
      'Use when the brand has a product launch, feature announcement, or major milestone coming up. Loads the pre-launch / launch-day / post-launch playbook including teaser cadence, day-of moves, and the post-launch nurture sequence.',
    references: [],
  },
];

export const SKILL_SLUGS = SKILL_MENU.map((s) => s.slug);

// ---------- file loaders ---------------------------------------------

// Resolve the skills directory through multiple candidates. Robust against
// Vercel's @vercel/node bundler, which inlines ESM modules in ways that
// can move `import.meta.url`, AND against local dev where cwd may not be
// the project root. We pick the first path under which `social-content/
// SKILL.md` exists. The check runs once at module init.
//
// vercel.json's functions["api/ai/chat.ts"].includeFiles = "src/data/
// skills/**" ensures the .md files ship with the function bundle in
// production. The candidates list below is what we try at runtime once
// the bundle is in place.
let __dirname;
try {
  __dirname = path.dirname(fileURLToPath(import.meta.url));
} catch {
  __dirname = process.cwd();
}

const SKILL_DIR_CANDIDATES = [
  path.resolve(__dirname, '../data/skills'),
  path.resolve(process.cwd(), 'src/data/skills'),
  path.resolve(process.cwd(), 'web/src/data/skills'),
  path.resolve(__dirname, '../../src/data/skills'),
];

function resolveSkillsDir() {
  for (const candidate of SKILL_DIR_CANDIDATES) {
    if (existsSync(path.join(candidate, 'social-content', 'SKILL.md'))) {
      return candidate;
    }
  }
  // Don't throw at module-init time — defer so a healthy server still
  // starts and only fails on the actual tool call. Returns the first
  // candidate so the error surfaces with a concrete path the operator
  // can paste into a bug report.
  return SKILL_DIR_CANDIDATES[0];
}

const SKILLS_DIR = resolveSkillsDir();

function readMarkdownFile(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to read skill file ${absPath}: ${msg}. ` +
        `Tried candidate dirs: ${SKILL_DIR_CANDIDATES.join(', ')}`,
    );
  }
}

// Strip the YAML frontmatter from a SKILL.md so the model gets just the
// body content. The original files use `---\n<yaml>\n---\n<body>` format.
function stripFrontmatter(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.replace(/^﻿/, ''); // BOM safety
  if (!trimmed.startsWith('---')) return trimmed;
  const closeIdx = trimmed.indexOf('\n---', 3);
  if (closeIdx === -1) return trimmed;
  const afterClose = trimmed.indexOf('\n', closeIdx + 4);
  return (afterClose === -1 ? '' : trimmed.slice(afterClose + 1)).trim();
}

export function loadSkill(slug) {
  if (!SKILL_SLUGS.includes(slug)) {
    return { ok: false, error: `unknown skill slug: ${slug}. Available: ${SKILL_SLUGS.join(', ')}` };
  }
  const filePath = path.join(SKILLS_DIR, slug, 'SKILL.md');
  const raw = readMarkdownFile(filePath);
  const body = stripFrontmatter(raw);
  const entry = SKILL_MENU.find((s) => s.slug === slug);
  return {
    ok: true,
    result: {
      slug,
      title: entry?.title,
      body,
      available_references: entry?.references || [],
    },
  };
}

export function loadSkillReference(slug, referenceName) {
  const entry = SKILL_MENU.find((s) => s.slug === slug);
  if (!entry) {
    return { ok: false, error: `unknown skill slug: ${slug}` };
  }
  if (!entry.references.includes(referenceName)) {
    return {
      ok: false,
      error: `skill "${slug}" has no reference named "${referenceName}". Available references: ${entry.references.join(', ') || '(none)'}`,
    };
  }
  const filePath = path.join(SKILLS_DIR, slug, 'references', `${referenceName}.md`);
  const body = readMarkdownFile(filePath);
  return {
    ok: true,
    result: {
      slug,
      reference: referenceName,
      body: body.trim(),
    },
  };
}

// =====================================================================
// Inline-copy guidance compiler — used by /api/ai/copy
// =====================================================================
//
// The inline "AI draft" / "Redraft" surface is single-shot, not agentic
// — it can't call load_skill at runtime. Instead, we extract the
// platform-specific section from social-content/references/platforms.md
// AND the full copywriting SKILL.md body, and inject them up front as
// a cached system block. Two things change vs the hardcoded
// PLATFORM_GUIDANCE that used to live in /api/ai/copy:
//
//   1. The platform conventions are now sourced from the skill files
//      (single source of truth — update once, all surfaces benefit).
//   2. The copywriting frameworks (AIDA / PAS / Before-After-Bridge /
//      hooks) flow into every inline draft, not just chat-loaded ones.
//
// Token cost: ~2-3K cached tokens per inline call. Cache hits across
// back-to-back drafts within the same 5-min TTL.

const PLATFORM_TO_HEADING = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  x: 'Twitter/X',
};

// Extract a single H2 section from a markdown file by its heading text.
// Returns the section body (the heading itself is included for context).
// Used to pull just one platform's guidance from platforms.md instead of
// dumping all 5 platforms (~1.4K tokens of which 80% would be irrelevant).
function extractSection(markdown, heading) {
  if (typeof markdown !== 'string' || !heading) return '';
  const lines = markdown.split('\n');
  const startMarker = `## ${heading}`;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === startMarker) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return '';
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

let _cachedCopywritingSkillBody = null;
let _cachedPlatformsMarkdown = null;

function getCopywritingSkillBody() {
  if (_cachedCopywritingSkillBody !== null) return _cachedCopywritingSkillBody;
  const raw = readMarkdownFile(path.join(SKILLS_DIR, 'copywriting', 'SKILL.md'));
  _cachedCopywritingSkillBody = stripFrontmatter(raw);
  return _cachedCopywritingSkillBody;
}

function getPlatformsMarkdown() {
  if (_cachedPlatformsMarkdown !== null) return _cachedPlatformsMarkdown;
  _cachedPlatformsMarkdown = readMarkdownFile(
    path.join(SKILLS_DIR, 'social-content', 'references', 'platforms.md'),
  );
  return _cachedPlatformsMarkdown;
}

// Returns a markdown-formatted system-prompt block tailored to one
// platform. Caches the underlying file reads in module memory so that
// back-to-back inline-copy calls don't re-hit disk.
//
// Falls back to an empty string on unknown platform — caller can choose
// to skip injection entirely in that case.
export function compileCopyGuidance(platform) {
  const heading = PLATFORM_TO_HEADING[platform];
  if (!heading) return '';

  let platformSection = '';
  try {
    platformSection = extractSection(getPlatformsMarkdown(), heading);
  } catch {
    // file missing in this bundle — skip the platform section, still
    // ship copywriting guidance below.
  }

  let copywritingBody = '';
  try {
    copywritingBody = getCopywritingSkillBody();
  } catch {
    // same: degrade gracefully.
  }

  const blocks = ['# Marketing playbook excerpts (loaded for this inline draft)'];
  blocks.push(
    'Two pieces of universal craft below — apply them on top of the brand voice. The brand voice from the context above always wins on tension; these are how-to-write defaults, not what-to-say constraints.',
  );

  if (platformSection) {
    blocks.push('## Platform conventions');
    blocks.push(platformSection);
  }

  if (copywritingBody) {
    blocks.push('## Copywriting frameworks & hooks (universal)');
    blocks.push(copywritingBody);
  }

  return blocks.join('\n\n');
}

// Returns the menu block to inject into the system prompt. Kept terse —
// just enough for the model to route to the right skill without loading.
export function compileSkillMenu() {
  const lines = ['## Available marketing playbooks (load on demand)\n'];
  lines.push(
    "You have access to 7 specialised marketing playbooks. When the admin's request is well-served by one, call `load_skill(slug)` to read the full playbook first, THEN apply its frameworks/templates when drafting or planning. Don't load a skill speculatively — load when its description matches the work. Loaded skill bodies stay in context for the rest of this conversation, so you don't need to re-load.\n",
  );
  lines.push(
    'Each skill may also expose deeper reference docs (e.g. copy frameworks, post templates, idea catalogues). The load_skill response lists `available_references`. If a reference looks directly relevant, call `load_skill_reference(slug, reference_name)` to pull it in too.\n',
  );
  lines.push('Available skills:');
  for (const s of SKILL_MENU) {
    lines.push(`- **${s.slug}** — ${s.when_to_load}`);
  }
  return lines.join('\n');
}
