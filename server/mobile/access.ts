/**
 * Access limit of the phone page (/m) and /api/mobile/*: only the socket's remote address counts
 * (never X-Forwarded-For). Default: Tailscale (100.64.0.0/10), loopback, 192.168.0.0/16.
 * MOBILE_ALLOWED_CIDRS="a.b.c.d/n,..." replaces the default list.
 */
import { normalizeRemoteAddress } from '../network/notifyTarget';

export const DEFAULT_MOBILE_CIDRS = ['100.64.0.0/10', '127.0.0.1/32', '192.168.0.0/16'];

const ipToInt = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

export interface Cidr {
  base: number;
  mask: number;
}

export function parseCidr(text: string): Cidr | null {
  const [ip, bitsText = '32'] = text.trim().split('/');
  const base = ipToInt(ip);
  const bits = Number(bitsText);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

export function parseCidrList(value: string | undefined | null): Cidr[] {
  const items = (value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = (items.length ? items : DEFAULT_MOBILE_CIDRS).map(parseCidr).filter((c): c is Cidr => !!c);
  return parsed.length ? parsed : DEFAULT_MOBILE_CIDRS.map(parseCidr).filter((c): c is Cidr => !!c);
}

/** remoteAddress as seen by the socket ("::ffff:100.1.2.3", "::1", ...). Unknown/IPv6 -> false. */
export function isAllowedRemote(remoteAddress: string | undefined | null, cidrs: Cidr[]): boolean {
  const ip = normalizeRemoteAddress(remoteAddress);
  const n = ip ? ipToInt(ip) : null;
  if (n === null) return false;
  return cidrs.some((c) => ((n & c.mask) >>> 0) === c.base);
}

export function mobileAccessGuard(cidrs: Cidr[] = parseCidrList(process.env.MOBILE_ALLOWED_CIDRS)) {
  return (req: { socket: { remoteAddress?: string } }, res: any, next: () => void) => {
    if (isAllowedRemote(req.socket.remoteAddress, cidrs)) return next();
    res.status(403).type('text/plain').send('forbidden');
  };
}
