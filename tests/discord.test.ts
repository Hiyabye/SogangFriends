import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedGuild, authorized, batchNotices, COMMANDS, discordSend, message, validateChannel, verifyRequest } from '../src/discord';

const keyHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const env = { ALLOWED_GUILDS: '100, 200', DISCORD_TOKEN: 'synthetic-token' };
afterEach(() => vi.unstubAllGlobals());

describe('interaction security', () => {
  it('validates real Ed25519 signature over timestamp and raw bytes without consuming request', async () => {
    const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const publicKey = keyHex(await crypto.subtle.exportKey('raw', key.publicKey));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{ "type": 1 }';
    const signature = keyHex(await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode(timestamp + body)));
    const request = new Request('https://bot.test/interactions', { method: 'POST', body, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
    expect(await verifyRequest(request, publicKey)).toBe(true);
    expect(await request.text()).toBe(body);
    const changed = new Request('https://bot.test', { method: 'POST', body: '{"type":1}', headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
    expect(await verifyRequest(changed, publicKey)).toBe(false);
    const stale = new Request('https://bot.test', { method: 'POST', body, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': '1' } });
    expect(await verifyRequest(stale, publicKey)).toBe(false);
    expect(await verifyRequest(request, 'not-a-key')).toBe(false);
  });
  it('rejects oversized request before cryptographic work', async () => {
    const request = new Request('https://bot.test', { method: 'POST', body: 'x'.repeat(65537), headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': String(Math.floor(Date.now()/1000)) } });
    expect(await verifyRequest(request, '00'.repeat(32))).toBe(false);
  });
  it('fails closed on missing allowlist, DM, wrong guild, or missing management permission', () => {
    expect(allowedGuild('100', env)).toBe(true);
    expect(allowedGuild('300', env)).toBe(false);
    expect(allowedGuild('100', {})).toBe(false);
    expect(authorized({ guild_id: '100', member: { permissions: '32' } }, env)).toBe(true);
    expect(authorized({ guild_id: '200', member: { permissions: '8' } }, env)).toBe(true);
    expect(authorized({ guild_id: '300', member: { permissions: '32' } }, env)).toBe(false);
    expect(authorized({ guild_id: '100', member: { permissions: '2048' } }, env)).toBe(false);
    expect(authorized({ member: { permissions: '32' } }, env)).toBe(false);
    expect(authorized({ guild_id: '100', member: { permissions: '-1' } }, env)).toBe(false);
  });
});

describe('Discord message safety', () => {
  it('disables all mention parsing and does not split emoji when truncating', () => {
    const data = message('@everyone <@123> ' + '😀'.repeat(2000));
    expect(data.allowed_mentions).toEqual({ parse: [] });
    expect(data.content.length).toBeLessThanOrEqual(2000);
    expect(data.content).not.toMatch(/[\uD800-\uDBFF]…$/u);
  });
  it('packs bounded notices and retains every source link', () => {
    const notices = Array.from({ length: 10 }, (_, i) => ({ id: String(i), source: '학사', title: '@everyone ' + '가'.repeat(1500), published: '2026-10-09', url: `https://www.sogang.ac.kr/notice/${i}` }));
    const batches = batchNotices(notices);
    expect(batches.every(content => content.length <= 2000)).toBe(true);
    for (const notice of notices) expect(batches.join('\n')).toContain(notice.url);
    expect(batchNotices([])).toEqual([]);
  });
  it('restricts management commands at registration too', () => {
    expect(COMMANDS.find(c => c.name === 'setup')?.default_member_permissions).toBe('32');
    expect(COMMANDS.find(c => c.name === 'status')?.default_member_permissions).toBe('32');
    expect(COMMANDS.every(c => c.contexts.join() === '0')).toBe(true);
  });
});

describe('delivery uncertainty', () => {
  it('records sent only with matching channel and valid message ID', async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ id: '999', channel_id: '123' }));
    vi.stubGlobal('fetch', mock);
    expect(await discordSend(env, '123', '@everyone')).toEqual({ state: 'sent', messageId: '999' });
    const options = mock.mock.calls[0][1];
    expect(JSON.parse(options.body).allowed_mentions).toEqual({ parse: [] });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'server', 'malformed', 'wrong-channel'])('never retries ambiguous %s result', async kind => {
    const mock = vi.fn();
    if (kind === 'network') mock.mockRejectedValue(new Error('contains secret'));
    if (kind === 'server') mock.mockResolvedValue(new Response('error', { status: 503 }));
    if (kind === 'malformed') mock.mockResolvedValue(new Response('not-json', { status: 200 }));
    if (kind === 'wrong-channel') mock.mockResolvedValue(Response.json({ id: '999', channel_id: '456' }));
    vi.stubGlobal('fetch', mock);
    expect(await discordSend(env, '123', 'hello')).toEqual({ state: 'uncertain' });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('distinguishes explicit rate limit rejection from permanent errors', async () => {
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ retry_after: 2.5 }, { status: 429 })).mockResolvedValueOnce(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', mock);
    expect(await discordSend(env, '123', 'hello')).toEqual({ state: 'retry', retryAfter: 3 });
    expect(await discordSend(env, '123', 'hello')).toEqual({ state: 'failed' });
    expect(await discordSend({}, '123', 'hello')).toEqual({ state: 'failed' });
  });
});

describe('channel ownership and effective permissions', () => {
  function api(channel: Record<string, unknown>, roles: unknown[], memberRoles: string[] = []) {
    const mock = vi.fn(async (url: string) => {
      if (url.endsWith('/channels/123')) return Response.json(channel);
      if (url.endsWith('/users/@me')) return Response.json({ id: '999' });
      if (url.endsWith('/guilds/100/members/999')) return Response.json({ roles: memberRoles });
      if (url.endsWith('/guilds/100/roles')) return Response.json(roles);
      throw new Error('unexpected endpoint');
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }
  it('rejects another guild without touching guild member data', async () => {
    const mock = api({ guild_id: '200', type: 0 }, []);
    await expect(validateChannel(env, '100', '123')).rejects.toThrow('이 서버');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('allows required minimal permissions without Administrator', async () => {
    api({ guild_id: '100', type: 0, permission_overwrites: [] }, [{ id: '100', permissions: '1024' }, { id: '777', permissions: '2048' }], ['777']);
    await expect(validateChannel(env, '100', '123')).resolves.toBeUndefined();
  });
  it('applies everyone, combined role, then individual overwrite priority', async () => {
    const channel = { guild_id: '100', type: 0, permission_overwrites: [
      { id: '100', type: 0, allow: '0', deny: '2048' },
      { id: '777', type: 0, allow: '2048', deny: '0' },
      { id: '999', type: 1, allow: '0', deny: '2048' },
    ] };
    api(channel, [{ id: '100', permissions: '3072' }, { id: '777', permissions: '0' }], ['777']);
    await expect(validateChannel(env, '100', '123')).rejects.toThrow('메시지 보내기');
    channel.permission_overwrites.pop();
    await expect(validateChannel(env, '100', '123')).resolves.toBeUndefined();
  });
  it('rejects non-message channels and redacts fetch errors', async () => {
    api({ guild_id: '100', type: 2 }, []);
    await expect(validateChannel(env, '100', '123')).rejects.toThrow('텍스트 채널');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-token')));
    await expect(validateChannel(env, '100', '123')).rejects.toThrow('Discord 채널 권한');
  });
});
