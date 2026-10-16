import { serverOrigin } from '../../../packages/contracts/index.ts';
import type { ServerTransport } from '../../../packages/contracts/index.ts';

export const encryptedTransport: ServerTransport = Object.freeze({
  localHttpOrigin: null,
});

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

  constructor(
    replace: (origin: string | null) => Promise<void>,
    changed: () => void = () => {},
  ) {
    this.replace = replace;
    this.changed = changed;
  }

  version(): number {
    return this.revision;
  }

  permits(origin: string, transport: ServerTransport): boolean {
    try {
      return (
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
    const transport = selectionTransport({
      origin,
      localHttpOrigin: context.localHttpOrigin,
    });
    const canonical = serverOrigin(origin, transport);
    const ticket = ++this.revision;
    this.desired = { origin: canonical, transport };
    this.ready = false;
    this.changed();
    // Do not serialize awaiting promises: revocation must supersede slow DNS.
    try {
      await this.replace(transport.localHttpOrigin);
      if (ticket !== this.revision) return false;
      this.ready = true;
      this.changed();
      return true;
    } catch (error) {
      if (ticket !== this.revision) return false;
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
    const ticket = ++this.revision;
    this.desired = null;
    this.ready = false;
    this.changed();
    try {
      await this.replace(null);
      return ticket === this.revision;
    } catch (error) {
      if (ticket !== this.revision) return false;
      throw error;
    }
  }
}
