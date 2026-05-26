// web/api/_shared/textNormalize.ts
//
// Server-side text normalisation for LinkAI output. The flagship rule:
// strip em-dashes (the U+2014 character) and en-dashes (U+2013) from
// every character of LinkAI's output before it reaches the user.
//
// Why server-side strip, not prompt-only:
// Claude is heavily trained to use em-dashes for elegant prose. A
// negative instruction ("do not use em-dashes") has a known soft floor
// in LLMs (negative-priming + reduced-but-nonzero violation rate),
// AND the rule lives inside a system prompt that itself was historically
// written with em-dashes everywhere, which primed the model further.
// Server-side substitution makes the rule load-bearing: the user is
// GUARANTEED never to see an em-dash, regardless of how many times the
// model slips. The prompt rule is now the secondary signal; this is
// the load-bearing one.
//
// Substitution: both em-dash and en-dash become a regular hyphen "-".
// Surrounding whitespace is left untouched ("X - Y" instead of "X — Y").
// This is the lowest-risk substitution: no risk of double-space artefacts
// from cross-chunk replacement boundaries (which a ", " substitution
// would produce when an em-dash lands at a streaming token boundary
// between two chunks of text), and it reads cleanly on every platform.

import type { TextStreamPart, ToolSet } from "ai";

/**
 * Strip em-dashes (U+2014) and en-dashes (U+2013) from a string. Use
 * for in-memory text (tool input copy, brand notes, the SYSTEM_PROMPT
 * constant at module load, anywhere the model writes prose).
 */
export function stripDashes(text: string): string {
  return text.replaceAll("—", "-").replaceAll("–", "-");
}

/**
 * Deeply walk a value and apply stripDashes to every string leaf. Used
 * to normalise tool-call inputs after zod validation but before they
 * reach execute() or get echoed back to the client.
 */
export function stripDashesDeep<T>(value: T): T {
  if (typeof value === "string") return stripDashes(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripDashesDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripDashesDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * StreamTextTransform that strips dashes from text-delta and
 * tool-input-delta parts of an AI SDK streamText result. Drop it into
 * the `experimental_transform` option of streamText().
 *
 * Catches em-dashes in TWO stream-part types:
 *   - text-delta - the assistant's prose reply (in chat) or the body
 *     of inline-copy streaming (in /api/ai/copy).
 *   - tool-input-delta - JSON fragments of streaming tool calls. The
 *     model emits em-dashes inside string values (e.g. inside
 *     copy_variants.linkedin), which are valid JSON. Replacing the
 *     character in a fragment is safe because em-dashes never appear
 *     in JSON STRUCTURE (only inside string literals).
 *
 * The tool-call's parsed INPUT object is ALSO scrubbed via
 * stripDashesDeep() at execute() time for create_post_plan_draft -
 * that's the defence-in-depth covering the case where the SDK assembles
 * the tool input from buffered raw fragments instead of from the
 * transformed stream.
 */
export function stripDashesStreamTransform<TOOLS extends ToolSet>() {
  return () =>
    new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          controller.enqueue({ ...chunk, text: stripDashes(chunk.text) });
        } else if (chunk.type === "tool-input-delta") {
          controller.enqueue({ ...chunk, delta: stripDashes(chunk.delta) });
        } else {
          controller.enqueue(chunk);
        }
      },
    });
}
