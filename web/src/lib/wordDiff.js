// =====================================================================
// wordDiff — small LCS-based word diff for prose copy comparisons.
// =====================================================================
// Used by the brand-proposals copy-change review surface so the agency
// can see at a glance what the brand changed. Word-level granularity
// matches the way reviewers actually read prose (character-level is
// noisy on a 200-word caption; line-level misses inline tweaks).
//
// Output is a flat array of { type: 'unchanged' | 'added' | 'removed',
// text: string } tokens. Whitespace is preserved as part of the next
// word boundary so re-joining the tokens reconstructs the original
// strings exactly.
//
// Complexity: O(n*m) for n, m word counts. Fine for caption-length
// prose (typically <500 words). If a future use-case needs longer
// inputs, swap in jsdiff — same shape of return value.

function tokenize(text) {
  if (!text) return [];
  // Split into [word, space, word, space, ...] tokens. We want to keep
  // whitespace as separate tokens so multi-space / newline runs survive
  // the diff and re-joining is lossless.
  const parts = text.match(/\s+|\S+/g);
  return parts || [];
}

function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  // 1-D rolling tables would save memory; keep 2-D for clarity.
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }
  return dp;
}

/**
 * Word-level diff of two strings.
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array<{ type: 'unchanged'|'added'|'removed', text: string }>}
 */
export function diffWords(oldText, newText) {
  const a = tokenize(oldText || '');
  const b = tokenize(newText || '');
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ type: 'added',   text: b.join('') }];
  if (b.length === 0) return [{ type: 'removed', text: a.join('') }];

  const dp = lcsTable(a, b);
  // Walk back through the table to produce the edit script.
  const out = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ type: 'unchanged', text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ type: 'added', text: b[j - 1] });
      j--;
    } else {
      out.push({ type: 'removed', text: a[i - 1] });
      i--;
    }
  }
  out.reverse();
  // Coalesce adjacent same-type tokens so the rendered output isn't
  // littered with per-word spans. Keeps the DOM lighter and adjacent
  // whitespace flows naturally inside one span.
  const coalesced = [];
  for (const tok of out) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.type === tok.type) {
      prev.text += tok.text;
    } else {
      coalesced.push({ ...tok });
    }
  }
  return coalesced;
}

// True when there is at least one added or removed segment.
export function hasDiff(tokens) {
  return Array.isArray(tokens) && tokens.some((t) => t.type !== 'unchanged');
}
