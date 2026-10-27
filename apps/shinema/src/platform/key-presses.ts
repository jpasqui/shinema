/**
 * Android TV reports a remote press as a key-up (action 1) alone unless
 * key-down events are enabled, and sends repeated key-downs (action 0) while a
 * key is held. Acting on every key-down, and on a key-up only when no key-down
 * for that key came first, handles each press once either way and keeps
 * held keys repeating.
 */
export class KeyPresses {
  private held = new Set<string>();

  accept(key: string, action: number): boolean {
    if (action === 0) {
      this.held.add(key);
      return true;
    }
    if (action === 1) return !this.held.delete(key);
    return true;
  }
}
