import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp, hostAllowed, parseDestination, validateDestination } from '../src/security.js';
const allow = ['example.com', '*.example.org'];
test('rejects local, metadata, private and non-HTTP URLs', async () => {
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://192.168.0.1/',
    'http://metadata.google.internal/', 'http://10.0.0.1/', 'file:///etc/passwd',
    'http://example.com:8080/']) {
    await assert.rejects(validateDestination(url, ['*']), undefined, url);
  }
});
test('domain restrictions', () => {
  assert.equal(hostAllowed('example.com', allow), true);
  assert.equal(hostAllowed('www.example.org', allow), true);
  assert.equal(hostAllowed('example.org', allow), false);
  assert.throws(() => parseDestination('https://other.com', allow, true));
  assert.equal(parseDestination('https://example.com/page', allow, true).host, 'example.com');
});
test('public address classification', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  for (const ip of ['127.0.0.1', '10.0.0.4', '169.254.169.254', '192.168.1.5', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});
test('blocks hosts if any resolved address is private', async () => {
  const mockDns = async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }];
  await assert.rejects(validateDestination('https://example.com', ['*'], false, mockDns));
});
test('allows a permitted, publicly resolving URL', async () => {
  const mockDns = async () => [{ address: '8.8.8.8' }];
  assert.equal(await validateDestination('https://example.com/x', allow, true, mockDns), 'https://example.com/x');
});
