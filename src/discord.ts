import type { Env, Notice } from './types';

const API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 32n;
const REQUIRED_CHANNEL = 1024n | 2048n;
const MAX_BODY = 65536;

function hex(value: string, bytes: number): Uint8Array<ArrayBuffer> | null {
  if (!new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`).test(value)) return null;
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
}

/** Verify the original wire bytes before JSON parsing; do not consume the caller's body. */
export async function verifyRequest(request: Request, publicKey: string): Promise<boolean> {
  const signature = hex(request.headers.get('x-signature-ed25519') ?? '', 64);
  const keyBytes = hex(publicKey, 32);
  const timestamp = request.headers.get('x-signature-timestamp') ?? '';
  if (!signature || !keyBytes || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp) * 1000) > 300000) return false;
  const size = request.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BODY)) return false;
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  try {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      // A cloned/tee stream cancellation waits for the original branch: never await it here.
      if (length > MAX_BODY) { void reader.cancel().catch(() => {}); return false; }
      parts.push(value);
    }
    const prefix = new TextEncoder().encode(timestamp);
    const signed = new Uint8Array(prefix.length + length);
    signed.set(prefix);
    let offset = prefix.length;
    for (const part of parts) { signed.set(part, offset); offset += part.length; }
    const key = await crypto.subtle.importKey('raw', keyBytes, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature, signed);
  } catch { return false; }
}

export function allowedGuild(guild: unknown, env: Pick<Env, 'ALLOWED_GUILDS'>): boolean {
  return typeof guild === 'string' && /^\d+$/.test(guild)
    && (env.ALLOWED_GUILDS ?? '').split(',').map(s => s.trim()).filter(Boolean).includes(guild);
}

export function authorized(interaction: unknown, env: Pick<Env, 'ALLOWED_GUILDS'>): boolean {
  if (!interaction || typeof interaction !== 'object') return false;
  const value = interaction as { guild_id?: unknown; member?: { permissions?: unknown } };
  if (!allowedGuild(value.guild_id, env)) return false;
  const permissions = value.member?.permissions;
  if (typeof permissions !== 'string' || !/^\d+$/.test(permissions)) return false;
  // Administrator implies Manage Guild; it is accepted but is never required.
  return (BigInt(permissions) & (MANAGE_GUILD | 8n)) !== 0n;
}

function truncate(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
  let output = '';
  for (const { segment } of segmenter.segment(content)) {
    if (output.length + segment.length > limit - 1) break;
    output += segment;
  }
  return output + '…';
}

export function message(content: string): { content: string; allowed_mentions: { parse: never[] } } {
  return { content: truncate(content, 2000), allowed_mentions: { parse: [] } };
}

function display(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\*_`~|<>\[\]]/g, '\\$&');
}

/** Pack complete source links; overlong titles are shortened, not source URLs. */
export function batchNotices(notices: Notice[]): string[] {
  const output: string[] = [];
  let current = '';
  for (const notice of notices) {
    const url = new URL(notice.url);
    if (url.protocol !== 'https:' || notice.url.length > 1000) throw new Error('Invalid notice link');
    const prefix = `[${truncate(display(notice.source), 100)}] `;
    const suffix = `\n${display(notice.published)} · <${notice.url}>`;
    const block = prefix + truncate(display(notice.title), 2000 - prefix.length - suffix.length) + suffix;
    if (current && current.length + 2 + block.length > 2000) { output.push(current); current = ''; }
    current += (current ? '\n\n' : '') + block;
  }
  if (current) output.push(current);
  return output;
}

export interface SendResult { state: 'sent' | 'uncertain' | 'retry' | 'failed'; messageId?: string; retryAfter?: number }

export async function discordSend(env: Pick<Env, 'DISCORD_TOKEN'>, channel: string, content: string): Promise<SendResult> {
  if (!env.DISCORD_TOKEN || !/^\d+$/.test(channel)) return { state: 'failed' };
  let response: Response;
  try {
    response = await fetch(`${API}/channels/${channel}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message(content)), signal: AbortSignal.timeout(15000),
    });
  } catch { return { state: 'uncertain' }; }
  if (response.status === 429) {
    let seconds = 60;
    try {
      const body = await response.json() as { retry_after?: unknown };
      if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) seconds = body.retry_after;
    } catch { /* A received 429 confirms rejection even if its body is malformed. */ }
    return { state: 'retry', retryAfter: Math.min(86400, Math.max(1, Math.ceil(seconds))) };
  }
  if (response.status >= 500 || response.status === 408) return { state: 'uncertain' };
  if (!response.ok) return { state: 'failed' };
  try {
    const body = await response.json() as { id?: unknown; channel_id?: unknown };
    if (typeof body.id === 'string' && /^\d+$/.test(body.id) && body.channel_id === channel) {
      return { state: 'sent', messageId: body.id };
    }
  } catch { /* A successful POST with unreadable tracking data must not be replayed. */ }
  return { state: 'uncertain' };
}

async function discordGet(env: Pick<Env, 'DISCORD_TOKEN'>, path: string): Promise<unknown> {
  if (!env.DISCORD_TOKEN) throw new Error('봇 토큰 설정이 필요합니다.');
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('discord');
    return await response.json();
  } catch { throw new Error('Discord 채널 권한 정보를 확인할 수 없습니다. 봇 초대와 설정을 확인해 주세요.'); }
}

interface Role { id: string; permissions: string }
interface Overwrite { id: string; type: number; allow: string; deny: string }

export async function validateChannel(env: Pick<Env, 'DISCORD_TOKEN'>, guild: string, channel: string): Promise<void> {
  if (!/^\d+$/.test(guild) || !/^\d+$/.test(channel)) throw new Error('올바른 서버와 채널 ID가 필요합니다.');
  const item = await discordGet(env, `/channels/${channel}`) as { guild_id?: string; type?: number; permission_overwrites?: Overwrite[] };
  if (item.guild_id !== guild) throw new Error('이 서버에 속한 채널을 선택해 주세요.');
  if (item.type !== 0 && item.type !== 5) throw new Error('일반 텍스트 채널 또는 공지 채널을 선택해 주세요.');
  const user = await discordGet(env, '/users/@me') as { id?: string };
  if (!user.id || !/^\d+$/.test(user.id)) throw new Error('봇 사용자 정보를 확인할 수 없습니다.');
  const member = await discordGet(env, `/guilds/${guild}/members/${user.id}`) as { roles?: string[] };
  const roles = await discordGet(env, `/guilds/${guild}/roles`) as Role[];
  if (!Array.isArray(roles) || !Array.isArray(member.roles) || !roles.some(role => role.id === guild)) {
    throw new Error('봇 역할 권한 정보를 확인할 수 없습니다.');
  }
  try {
    const ids = new Set([guild, ...member.roles]);
    let permissions = roles.filter(role => ids.has(role.id)).reduce((all, role) => all | BigInt(role.permissions), 0n);
    if ((permissions & 8n) !== 0n) return;
    const overwrites = item.permission_overwrites;
    if (!Array.isArray(overwrites)) throw new Error('missing overwrites');
    const everyone = overwrites.find(entry => entry.type === 0 && entry.id === guild);
    if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
    let allow = 0n; let deny = 0n;
    for (const entry of overwrites) {
      if (entry.type === 0 && entry.id !== guild && ids.has(entry.id)) {
        allow |= BigInt(entry.allow); deny |= BigInt(entry.deny);
      }
    }
    permissions = (permissions & ~deny) | allow;
    const individual = overwrites.find(entry => entry.type === 1 && entry.id === user.id);
    if (individual) permissions = (permissions & ~BigInt(individual.deny)) | BigInt(individual.allow);
    if ((permissions & REQUIRED_CHANNEL) !== REQUIRED_CHANNEL) throw new Error('missing permissions');
  } catch { throw new Error('봇에 해당 채널의 채널 보기와 메시지 보내기 권한을 부여해 주세요.'); }
}

export const COMMANDS = [
  { name: 'meal', description: '벨라르미노 식단 조회', options: [{ name: 'date', description: '한국 시간 날짜 YYYY-MM-DD (기본 오늘)', type: 3 }] },
  { name: 'notices', description: '최근 서강대학교 공지', options: [{ name: 'source', description: '게시판 ID (생략하면 전체)', type: 3 }] },
  { name: 'schedule', description: '앞으로 30일 공식 학사 일정' },
  { name: 'setup', description: '서버별 알림 채널 설정', default_member_permissions: '32', options: [
    { name: 'notices', description: '공지 발송 채널', type: 7, channel_types: [0, 5] },
    { name: 'meals', description: '식단 발송 채널', type: 7, channel_types: [0, 5] },
    { name: 'schedule', description: '학사 일정 발송 채널', type: 7, channel_types: [0, 5] },
  ] },
  { name: 'status', description: '관리자용 수집·작업·발송 상태', default_member_permissions: '32' },
].map(command => ({ ...command, type: 1, contexts: [0], integration_types: [0], dm_permission: false }));
