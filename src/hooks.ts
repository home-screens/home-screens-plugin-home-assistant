// Small React hooks shared by the views. Pure view plumbing, no HA logic.

import React from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/** An element's rendered box in px, kept current through resizes. The
 *  timeline reads the width to pick tick spacing and feed columns; the
 *  energy view reads both axes to choose side-by-side versus stacked and
 *  to size its SVG. Zero until the first layout pass. */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, ElementSize] {
  const ref = React.useRef<T | null>(null);
  const [size, setSize] = React.useState<ElementSize>({ width: 0, height: 0 });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setSize((prev) => (
      prev.width === el.clientWidth && prev.height === el.clientHeight
        ? prev
        : { width: el.clientWidth, height: el.clientHeight }
    ));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
