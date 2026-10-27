/**
 * Remote-control seeking. Each press moves from where the previous press
 * aimed, not from the player's last reported time, so pressing Right three
 * times quickly skips 30 seconds even before the player catches up.
 */
export class SeekTarget {
  private target: number | null = null;
  private settledAt = 0;

  /** The position the next press should start from. */
  base(reported: number, now: number = Date.now()): number {
    // Once the player has had time to land, trust its reported time again.
    if (this.target !== null && now - this.settledAt > 1500) this.target = null;
    return this.target ?? reported;
  }

  step(
    reported: number,
    duration: number,
    delta: number,
    now: number = Date.now(),
  ): number {
    const next = Math.min(
      Math.max(0, this.base(reported, now) + delta),
      duration > 0 ? Math.max(0, duration - 1) : Number.MAX_SAFE_INTEGER,
    );
    this.target = next;
    this.settledAt = now;
    return next;
  }

  /** The position to save while a seek is still landing. */
  current(reported: number, now: number = Date.now()): number {
    return this.base(reported, now);
  }
}
