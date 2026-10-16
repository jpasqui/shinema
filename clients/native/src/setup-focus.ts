export const setupControls = [
  'appearance',
  'requests',
  'address',
  'http',
  'connect',
] as const;
export type SetupControl = (typeof setupControls)[number];
export type SetupBounds = Partial<
  Record<SetupControl, Readonly<{ y: number; height: number }>>
>;

/** One logical focus order includes setup actions even without a catalogue. */
export function moveSetupFocus(
  current: SetupControl,
  direction: -1 | 1,
): SetupControl {
  const index = setupControls.indexOf(current);
  return setupControls[
    Math.max(0, Math.min(setupControls.length - 1, index + direction))
  ];
}
import { focusScrollOffset } from './preferences.ts';

/** Setup shares the scene scroller; intercepted D-pad keys cannot scroll it. */
export function setupScrollOffset(
  current: number,
  control: SetupControl,
  sectionTop: number,
  bounds: SetupBounds,
  viewport: number,
): number {
  if (control === 'appearance' || control === 'requests') return 0;
  const target = bounds[control];
  if (!target) return current;
  return focusScrollOffset(
    current,
    sectionTop + target.y,
    target.height,
    viewport,
  );
}
