/**
 * Server addresses as people type them: "192.168.1.20:8787", "nas.local",
 * "https://media.example.com". Plain HTTP is normal on a home network (the
 * server's default), so it is accepted but flagged when the host is not
 * obviously private, letting the UI warn before connecting.
 */
export type ServerAddress = {
  /** Scheme, host and port only, for example "http://192.168.1.20:8787". */
  origin: string;
  secure: boolean;
  /** The host is loopback, a private IP range or a .local/.lan/.home name. */
  privateNetwork: boolean;
};

const DEFAULT_PORT = '8787';

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(local|lan|home|internal)$/.test(host))
    return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT range used by Tailscale
    );
  }
  return (
    host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)
  );
}

export function parseServerAddress(input: string): ServerAddress {
  const text = input.trim();
  if (!text) throw new Error('Enter your Shinema server address.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a server address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Use an http:// or https:// address.');
  if (url.username || url.password)
    throw new Error('Leave the user name and password out of the address.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error('Enter only the server address, without a path.');
  // A bare host without a port means the server's default port over HTTP.
  if (!url.port && url.protocol === 'http:' && !/:\d+$/.test(text))
    url.port = DEFAULT_PORT;
  return {
    origin: url.origin,
    secure: url.protocol === 'https:',
    privateNetwork: privateHost(url.hostname),
  };
}
