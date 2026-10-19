import { useEffect, type RefObject } from 'react';

/**
 * Marks a scroll container with data-fade-top / data-fade-bottom while there is
 * hidden content above or below, so the .scroll-fade CSS mask can fade the text
 * out softly instead of cutting it at the edge of the rounded panel.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.dataset.fadeTop = String(el.scrollTop > 1);
      el.dataset.fadeBottom = String(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Content that grows (new or streamed messages) or a resized window changes the edges.
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const mutate = new MutationObserver(update);
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', update);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [ref]);
}
