/**
 * Android TV keeps focus inside visible views itself and `hasTVPreferredFocus`
 * picks the starting control, so these are no-ops on native platforms.
 */
export type FocusToken = null;

export function captureFocus(): FocusToken {
  return null;
}

export function restoreFocus(_token: FocusToken): void {}

export function focusIfIdle(_element: unknown): void {}
