// Helpers for the two-machine setup (TD on a laptop, Node server on the desktop).
// Pure functions so they can be unit tested without starting the server.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// RFC-1123-ish hostname (letters, digits, '-', '.'), at most 253 chars.
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

export function isValidNotifyHost(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (!host) return false;
  const m = IPV4.exec(host);
  if (m) return m.slice(1).every((part) => Number(part) <= 255);
  return HOSTNAME.test(host);
}

/** "::ffff:192.168.0.5" -> "192.168.0.5"; "::1" -> "127.0.0.1"; undefined -> null. */
export function normalizeRemoteAddress(address: string | undefined | null): string | null {
  if (!address) return null;
  let a = address.trim();
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  if (a === '::1') return '127.0.0.1';
  return isValidNotifyHost(a) && IPV4.test(a) ? a : null; // IPv6 is not supported by the udp4 socket
}

export interface NotifyTargetInput {
  body: { notifyHost?: unknown; notifyToSender?: unknown } | null | undefined;
  remoteAddress: string | undefined | null;
  defaultHost: string;
}

/**
 * Which host receives this capture's UDP messages.
 * Priority: body.notifyHost (explicit) > body.notifyToSender === true (the request's
 * remote address) > defaultHost. An invalid notifyHost is ignored (default is used).
 */
export function resolveNotifyHost({ body, remoteAddress, defaultHost }: NotifyTargetInput): string {
  const explicit = body?.notifyHost;
  if (isValidNotifyHost(explicit)) return explicit.trim();
  if (body?.notifyToSender === true) {
    const sender = normalizeRemoteAddress(remoteAddress);
    if (sender) return sender;
  }
  return defaultHost;
}

/** Joins a public base ("http://host:3000" or with trailing slash) and a path ("/captures/x.png"). */
export function buildPublicUrl(base: string, relativeUrl: string): string {
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  const trimmedBase = base.trim().replace(/\/+$/, '');
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${trimmedBase}${path}`;
}

export function resolvePublicBaseUrl(env: string | undefined, port: number | string): string {
  const value = (env || '').trim();
  return value ? value.replace(/\/+$/, '') : `http://127.0.0.1:${port}`;
}
