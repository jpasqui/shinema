import { serverOrigin } from '../../../packages/contracts/index.ts';
import type { ServerTransport } from '../../../packages/contracts/index.ts';

export const encryptedTransport: ServerTransport = Object.freeze({
  localHttpOrigin: null,
});

/** Warm Activity surfaces share one native transport within a React runtime. */
export class NativeTransportScope {
  private owner: object | null = null;
  private revision = 0;

  claim(owner: object): number {
    this.owner = owner;
    return ++this.revision;
  }

  current(owner: object, lease: number): boolean {
    return this.owner === owner && lease === this.revision;
  }

  release(owner: object, lease: number): boolean {
    if (!this.current(owner, lease)) return false;
    this.owner = null;
    ++this.revision;
    return true;
  }
}

export const nativeTransportScope = new NativeTransportScope();

/** Consent is copied from the selected server, never inferred from its URL. */
export function selectionTransport(value: {
  origin: string;
  localHttpOrigin?: string | null;
}): ServerTransport {
  const transport = Object.freeze({
    localHttpOrigin: value.localHttpOrigin ?? null,
  });
  const origin = serverOrigin(value.origin, transport);
  return origin.startsWith('http:') ? transport : encryptedTransport;
}

/** Background feed work shares the exact readiness gate used by rendered URLs. */
export function readyTransport(
  policy: NativeTransportPolicy,
  value: { origin: string; localHttpOrigin?: string | null },
): ServerTransport | null {
  try {
    const context = selectionTransport(value);
    return policy.permits(value.origin, context) ? context : null;
  } catch {
    return null;
  }
}

/** A failed native replacement is already revoked; never revoke a newer one. */
export async function restoreSelection(
  policy: NativeTransportPolicy,
  value: { origin: string; localHttpOrigin?: string | null },
): Promise<boolean> {
  let context: ServerTransport;
  try {
    context = selectionTransport(value);
  } catch {
    // Invalid/revoked stored consent has no candidate native call to clear it.
    await policy.revoke().catch(() => {});
    return false;
  }
  try {
    return await policy.restore(value.origin, context);
  } catch {
    // Native beginUpdate cleared the old grant before DNS. A subsequent
    // activation may already own native policy by the time this catch runs.
    return false;
  }
}

/**
 * Invoke native replacements in JS order without waiting behind old DNS work.
 * Native allocates its own generation and revokes BEFORE resolving a new host;
 * only the newest invocation may publish a grant or complete a request/body.
 */
export class NativeTransportPolicy {
  private revision = 0;
  private desired: { origin: string; transport: ServerTransport } | null = null;
  private ready = false;
  private readonly replace: (origin: string | null) => Promise<void>;
  private readonly changed: () => void;
  private readonly scope?: NativeTransportScope;
  private lease: number | null = null;
  private disposed = false;

  constructor(
    replace: (origin: string | null) => Promise<void>,
    changed: () => void = () => {},
    scope?: NativeTransportScope,
  ) {
    this.replace = replace;
    this.changed = changed;
    this.scope = scope;
  }

  /** Claim only in the App effect, so abandoned renders cannot take ownership. */
  claim(): void {
    ++this.revision;
    this.desired = null;
    this.ready = false;
    this.disposed = false;
    this.lease = this.scope?.claim(this) ?? null;
    this.changed();
  }

  private ownsTransport(): boolean {
    return (
      !this.disposed &&
      (!this.scope ||
        (this.lease !== null && this.scope.current(this, this.lease)))
    );
  }

  private live(ticket: number): boolean {
    return ticket === this.revision && this.ownsTransport();
  }

  version(): number {
    return this.revision;
  }

  permits(origin: string, transport: ServerTransport): boolean {
    try {
      return (
        this.ownsTransport() &&
        this.ready &&
        this.desired?.origin === serverOrigin(origin, transport) &&
        this.desired.transport.localHttpOrigin === transport.localHttpOrigin
      );
    } catch {
      return false;
    }
  }

  current(ticket: number, origin: string, transport: ServerTransport): boolean {
    return ticket === this.revision && this.permits(origin, transport);
  }

  async activate(origin: string, context: ServerTransport): Promise<boolean> {
    if (!this.ownsTransport()) return false;
    const transport = selectionTransport({
      origin,
      localHttpOrigin: context.localHttpOrigin,
    });
    const canonical = serverOrigin(origin, transport);
    const ticket = ++this.revision;
    this.desired = { origin: canonical, transport };
    this.ready = false;
    this.changed();
    if (!this.live(ticket)) return false;
    // Do not serialize awaiting promises: revocation must supersede slow DNS.
    try {
      await this.replace(transport.localHttpOrigin);
      if (!this.live(ticket)) return false;
      this.ready = true;
      this.changed();
      return true;
    } catch (error) {
      if (!this.live(ticket)) return false;
      this.desired = null;
      this.changed();
      throw error;
    }
  }

  /** A matching live selection needs no new native generation. */
  restore(origin: string, context: ServerTransport): Promise<boolean> {
    if (this.permits(origin, context)) return Promise.resolve(true);
    return this.activate(origin, context);
  }

  async revoke(): Promise<boolean> {
    if (!this.ownsTransport()) return false;
    const ticket = ++this.revision;
    this.desired = null;
    this.ready = false;
    this.changed();
    if (!this.live(ticket)) return false;
    try {
      await this.replace(null);
      return this.live(ticket);
    } catch (error) {
      if (!this.live(ticket)) return false;
      throw error;
    }
  }

  /** Only the current surface may revoke the process-wide grant on unmount. */
  async dispose(): Promise<boolean> {
    const owns = this.ownsTransport();
    const ticket = ++this.revision;
    this.desired = null;
    this.ready = false;
    this.disposed = true;
    const released =
      owns &&
      (!this.scope ||
        (this.lease !== null && this.scope.release(this, this.lease)));
    this.lease = null;
    // Invoke before notifying, without awaiting an older grant/DNS completion.
    const pending = released ? this.replace(null) : null;
    this.changed();
    if (!pending) return false;
    try {
      await pending;
      return ticket === this.revision && this.disposed;
    } catch (error) {
      if (ticket !== this.revision || !this.disposed) return false;
      throw error;
    }
  }
}
