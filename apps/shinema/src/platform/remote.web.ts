import { useEffect, useRef } from 'react';
import { pickNeighbour, type Direction } from '../focus/spatial';
import type { RemoteHandler, RemoteKey } from './remote-types';

export type { RemoteHandler, RemoteKey } from './remote-types';

const KEYS: Record<string, RemoteKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  ' ': 'playPause',
  MediaPlayPause: 'playPause',
  Escape: 'back',
  Backspace: 'back',
  BrowserBack: 'back',
};

// The most recently mounted active handler sees keys first, like a screen stack.
const handlers: { current: RemoteHandler }[] = [];

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA')
  );
}

function onKeyDown(event: KeyboardEvent): void {
  const key = KEYS[event.key];
  if (!key || event.altKey || event.ctrlKey || event.metaKey) return;
  const inField = typing(event.target);
  // Inside a text field, only Escape and vertical arrows leave it.
  if (
    inField &&
    !(key === 'back' && event.key === 'Escape') &&
    key !== 'up' &&
    key !== 'down'
  )
    return;
  for (let index = handlers.length - 1; index >= 0; index -= 1)
    if (handlers[index]!.current(key)) {
      event.preventDefault();
      return;
    }
  if (key === 'up' || key === 'down' || key === 'left' || key === 'right')
    if (moveFocus(key)) event.preventDefault();
}

function focusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[tabindex="0"], input, textarea, button',
    ),
  ).filter((element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 && rect.height > 0 && !element.hasAttribute('disabled')
    );
  });
}

/** Moves focus to the nearest focusable element in the pressed direction. */
function moveFocus(direction: Direction): boolean {
  const all = focusables();
  const current = document.activeElement as HTMLElement | null;
  if (!current || current === document.body || !all.includes(current)) {
    all[0]?.focus();
    return all.length > 0;
  }
  const others = all.filter((element) => element !== current);
  const index = pickNeighbour(
    current.getBoundingClientRect(),
    others.map((element) => element.getBoundingClientRect()),
    direction,
  );
  const next = others[index];
  if (!next) return false;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

let listening = 0;

/** Arrow keys move focus between controls, as a TV remote would. */
export function useArrowFocus(): void {
  useEffect(() => {
    if (listening++ === 0) window.addEventListener('keydown', onKeyDown);
    return () => {
      if (--listening === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

export function useRemote(handler: RemoteHandler, active = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry = { current: (key: RemoteKey) => latest.current(key) };
    handlers.push(entry);
    return () => {
      handlers.splice(handlers.indexOf(entry), 1);
    };
  }, [active]);
}
