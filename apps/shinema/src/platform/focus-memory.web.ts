/**
 * Remembers which control had focus when a screen is covered, and restores
 * it when the screen is uncovered, so Back returns to the same poster.
 */
export type FocusToken = Element | null;

export function captureFocus(): FocusToken {
  return document.activeElement;
}

export function restoreFocus(token: FocusToken): void {
  // Wait a frame for the uncovered screen to become visible again.
  requestAnimationFrame(() => {
    if (token instanceof HTMLElement && token.isConnected) {
      token.focus({ preventScroll: true });
      token.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
}

/** Gives focus to a preferred control unless something visible already has it. */
export function focusIfIdle(element: unknown): void {
  requestAnimationFrame(() => {
    const active = document.activeElement as HTMLElement | null;
    const idle =
      !active ||
      active === document.body ||
      active.getBoundingClientRect().width === 0;
    if (idle && element instanceof HTMLElement)
      element.focus({ preventScroll: true });
  });
}
