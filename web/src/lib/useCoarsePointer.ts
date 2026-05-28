import { useEffect, useState } from 'react';

// Returns `true` when the primary input is a coarse pointer (finger), e.g.
// phones and most tablets. Used to fork interactions that must diverge
// between mouse + keyboard (Enter inserts newline, ⌘↩ sends) and touch
// (Enter sends, Shift+Enter newlines; visible "..." menus instead of
// right-click / hover-reveal; camera-capture button alongside paperclip).
//
// On every desktop browser this returns `false`, so behaviour is identical
// to today. Touch laptops with a mouse return `false` too — `(hover: hover)`
// reflects the *primary* input device, not whether a touchscreen exists.
// This is the same signal CSS uses via `@media (hover: none) and (pointer:
// coarse)`, kept in sync so styles and behaviour never disagree.
//
// Returns `false` during SSR / pre-mount so we don't render a mobile
// branch on a desktop and then snap to a different layout on hydration.
// The first effect run flips to the real value on the next tick.
export function useCoarsePointer(): boolean {
  const [isCoarse, setIsCoarse] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const update = () => setIsCoarse(mq.matches);
    update();
    if (mq.addEventListener) mq.addEventListener('change', update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', update);
      else mq.removeListener(update);
    };
  }, []);
  return isCoarse;
}
