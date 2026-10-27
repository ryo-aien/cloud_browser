import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example'];
const resolutionCache = new Map();
const blockedIPv4 = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIPv4.addSubnet(ip, prefix, 'ipv4');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [ip, prefix] of [
  ['2001:db8::', 32],
  ['2001:10::', 28],
]) blockedIPv6.addSubnet(ip, prefix, 'ipv6');

export function isPublicIp(address) {
  const type = isIP(address);
  if (type === 4) return !blockedIPv4.check(address, 'ipv4');
  if (type === 6) return globalIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  return false;
}

export function hostAllowed(host, allowedHosts) {
  return allowedHosts.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
    }
    return host === pattern;
  });
}

export function parseDestination(raw, allowedHosts, topLevel = false) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('URLが無効です');
  let url;
  try { url = new URL(raw); } catch { throw new Error('URLが無効です'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('HTTP(S)のみ利用できます');
  if (url.username || url.password) throw new Error('URL内の認証情報は利用できません');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('標準ポートのみ利用できます');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || !host.includes('.') || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) ||
      ['localhost', 'metadata.google.internal'].includes(host) ||
      host.endsWith('.google.internal')) {
    throw new Error('内部ホストへのアクセスは禁止されています');
  }
  if (topLevel && !hostAllowed(host, allowedHosts)) {
    throw new Error('このドメインはALLOWED_HOSTSに含まれていません');
  }
  return { url, host };
}

export async function validateDestination(raw, allowedHosts, topLevel = false, resolver = lookup) {
  const { url, host } = parseDestination(raw, allowedHosts, topLevel);
  if (!isPublicIp(host) && isIP(host) !== 0) {
    throw new Error('非公開IPアドレスにはアクセスできません');
  }
  if (isIP(host) === 0) {
    const cached = resolutionCache.get(host);
    let addresses;
    if (resolver === lookup && cached && cached.until > Date.now()) {
      addresses = cached.addresses;
    } else {
      const answer = await resolver(host, { all: true });
      addresses = answer.map((item) => item.address);
      if (resolver === lookup) {
        if (resolutionCache.size > 1000) resolutionCache.clear();
        resolutionCache.set(host, { addresses, until: Date.now() + 30_000 });
      }
    }
    if (!addresses.length || !addresses.every(isPublicIp)) {
      throw new Error('内部ネットワーク宛のアクセスは禁止されています');
    }
  }
  return url.toString();
}
