import type { Env, Schedule } from './types';
import { allowedGuild, message, type DiscordMessageInput } from './discord';
import { dayDifference, todayKst, validDate } from './time';

const API = 'https://discord.com/api/v10';
const LEASE_MS = 20 * 60_000;
const clean = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\*_`~|<>\[\]]/g, '\\$&');
const countdown = (today: string, date: string) => dayDifference(today, date) === 0 ? 'D-day' : `D-${dayDifference(today, date)}`;

/** Approved, student-facing future and ongoing schedules, without a 30-day cutoff. */
export function scheduleSummary(items: Schedule[], today: string): DiscordMessageInput {
 if (!validDate(today)) throw new Error('Invalid summary date');
 const deadline = (item: Schedule) => item.deadlineDate ?? (item.deadlineAt ? todayKst(new Date(item.deadlineAt)) : undefined);
 const entries = items.filter(item => item.active === true && !item.note.includes('교직원 대상') && (item.endDate ?? deadline(item) ?? item.startDate) >= today)
  .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
 const lines = entries.map(item => {
  const end = deadline(item);
  const phase = item.type === 'deadline' ? `마감 ${countdown(today, end!)}`
   : item.startDate < today ? `진행 중${end && end >= today ? ` · 마감 ${countdown(today, end)}` : ''}` : countdown(today, item.startDate);
  const dates = item.type === 'deadline' ? end! : `${item.startDate}${item.endDate ? ` ~ ${item.endDate}` : ''}`;
  return `• ${phase} | ${dates} | ${clean(item.title)}${item.type === 'period' && end ? `\n  마감: ${end}${end >= today ? ` (${countdown(today, end)})` : ' (지남)'}` : ''}${item.note ? `\n  ${clean(item.note)}` : ''}${item.deadlineAt ? `\n  명시된 마감: ${item.deadlineAt}` : ''}`;
 });
 const sources = [...new Set(entries.map(item => item.sourceUrl))].map(url => `<${url}>`);
 const heading = `학사일정 · ${today} KST 기준`;
 const content = `${heading}\n${lines.length ? lines.join('\n') : '앞으로의 승인된 학사일정이 없습니다.'}${sources.length ? `\n\n공식 원문\n${sources.join('\n')}` : ''}\n날짜 기준 D-day입니다. 세부 운영 시각과 변경 사항은 공식 원문을 확인하세요.`;
 if (content.length <= 2000) return content;
 return { content: `${heading}\n승인된 앞으로의 일정 ${entries.length}개를 전체 일정 파일로 첨부합니다.\n날짜 기준 D-day이며 세부 운영 시각은 파일의 공식 원문을 확인하세요.`,
  file: { filename: `schedule-${today}.txt`, bytes: new TextEncoder().encode(content), mime: 'text/plain; charset=utf-8' } };
}

export class ScheduleSummaryRetry extends Error {
 readonly retryAfter: number;
 constructor(seconds = 60) { super('Schedule summary update temporarily unavailable'); this.retryAfter = seconds; }
}

type Outcome = { state: 'sent'; messageId: string } | { state: 'retry'; seconds: number } | { state: 'missing' | 'failed' | 'uncertain' };
async function sendSummary(env: Env, channel: string, input: DiscordMessageInput, messageId: string | null): Promise<Outcome> {
 if (!env.DISCORD_TOKEN) return { state: 'failed' };
 // Explicit replacement removes prior summary files when the new summary fits inline.
 const payload = { ...message(input), embeds: [], attachments: typeof input === 'string' || !input.file ? [] : [{ id: 0, filename: input.file.filename }] };
 let body: BodyInit = JSON.stringify(payload);
 const headers: Record<string,string> = { Authorization: `Bot ${env.DISCORD_TOKEN}` };
 if (typeof input !== 'string' && input.file) {
  const form = new FormData(); form.append('payload_json', body);
  form.append('files[0]', new Blob([Uint8Array.from(input.file.bytes).buffer], { type: input.file.mime }), input.file.filename);
  body = form;
 } else headers['Content-Type'] = 'application/json';
 let response: Response;
 try {
  response = await fetch(`${API}/channels/${channel}/messages${messageId ? `/${messageId}` : ''}`, {
   method: messageId ? 'PATCH' : 'POST', headers, body, signal: AbortSignal.timeout(15000),
  });
 } catch { return messageId ? { state: 'retry', seconds: 60 } : { state: 'uncertain' }; }
 if (response.status === 429) {
  let seconds = 60;
  try { const data = await response.json() as { retry_after?: unknown }; if (typeof data.retry_after === 'number' && Number.isFinite(data.retry_after)) seconds = Math.min(86400, Math.max(1, Math.ceil(data.retry_after))); } catch { /* Confirmed rejection is safe even without rate-limit metadata. */ }
  return { state: 'retry', seconds };
 }
 if (messageId && response.status === 404) {
  try { if ((await response.json() as {code?:unknown}).code === 10008) return { state: 'missing' }; } catch { /* A generic 404 is not proof that the tracked message was deleted. */ }
  return { state: 'failed' };
 }
 if (response.status >= 500 || response.status === 408) return messageId ? { state: 'retry', seconds: 60 } : { state: 'uncertain' };
 if (!response.ok) return { state: 'failed' };
 // PATCH targets a known ID, so an unreadable response does not make a new POST safe.
 if (messageId) return { state: 'sent', messageId };
 try {
  const data = await response.json() as { id?: unknown; channel_id?: unknown };
  if (typeof data.id === 'string' && /^\d+$/.test(data.id) && data.channel_id === channel) return { state: 'sent', messageId: data.id };
 } catch { /* Never replay a possibly successful create without a confirmed identity. */ }
 return { state: 'uncertain' };
}

/** Called by one per-guild daily Queue job. Claims are independent of generic job recovery. */
export async function updateScheduleSummary(env: Env, guild: string, channel: string, date: string, items: Schedule[]): Promise<void> {
 if (!validDate(date)) throw new Error('Invalid summary date');
 if (date !== todayKst() || !allowedGuild(guild, env) || !/^\d+$/.test(channel)) return;
 const configured = await env.DB.prepare('SELECT schedule_channel FROM guilds WHERE id=?').bind(guild).first<{schedule_channel:string|null}>();
 if (configured?.schedule_channel !== channel) return;
 const input = scheduleSummary(items, date), now = new Date().toISOString();
 await env.DB.prepare('INSERT OR IGNORE INTO schedule_messages(guild_id,channel_id,updated_at) VALUES(?,?,?)').bind(guild, channel, now).run();
 // A lost creating lease may have published a message. No later job may create another.
 await env.DB.prepare("UPDATE schedule_messages SET state='uncertain',lease_owner=NULL,lease_until=NULL,error='Summary creation interrupted; manual reconciliation required',updated_at=? WHERE guild_id=? AND channel_id=? AND state='creating' AND lease_until<?").bind(now, guild, channel, now).run();
 const owner = crypto.randomUUID();
 const row = await env.DB.prepare("UPDATE schedule_messages SET state=CASE WHEN message_id IS NULL THEN 'creating' ELSE 'editing' END,lease_owner=?,lease_until=?,updated_at=?,error=NULL WHERE guild_id=? AND channel_id=? AND state!='uncertain' AND (lease_owner IS NULL OR (state='editing' AND lease_until<?)) AND (updated_date IS NULL OR updated_date<?) AND (retry_at IS NULL OR retry_at<=?) RETURNING message_id")
  .bind(owner, new Date(Date.now()+LEASE_MS).toISOString(), now, guild, channel, now, date, now).first<{message_id:string|null}>();
 if (!row) {
  const current = await env.DB.prepare('SELECT state,updated_date,retry_at FROM schedule_messages WHERE guild_id=? AND channel_id=?').bind(guild,channel).first<{state:string;updated_date:string|null;retry_at:string|null}>();
  if (current?.state !== 'uncertain' && current?.retry_at && current.retry_at > now) throw new ScheduleSummaryRetry(Math.max(1,Math.ceil((Date.parse(current.retry_at)-Date.now())/1000)));
  if (current?.state === 'creating' || current?.state === 'editing') throw new ScheduleSummaryRetry();
  return;
 }
 const release = async (state: string, error: string | null, id: string | null, updatedDate: string | null = null, retryAt: string | null = null) => {
  await env.DB.prepare('UPDATE schedule_messages SET state=?,error=?,message_id=?,updated_date=COALESCE(?,updated_date),retry_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?')
   .bind(state,error,id,updatedDate,retryAt,new Date().toISOString(),guild,channel,owner).run();
 };
 // Recheck boundaries after DB waits, including channel changes during planning.
 const latest = await env.DB.prepare('SELECT schedule_channel FROM guilds WHERE id=?').bind(guild).first<{schedule_channel:string|null}>();
 if (date !== todayKst() || latest?.schedule_channel !== channel || !allowedGuild(guild,env)) { await release('idle',null,row.message_id); return; }
 let outcome = await sendSummary(env,channel,input,row.message_id);
 if (outcome.state === 'missing') {
  // The exact Unknown Message response confirms no message exists at this ID.
  const creating = await env.DB.prepare("UPDATE schedule_messages SET message_id=NULL,state='creating' WHERE guild_id=? AND channel_id=? AND lease_owner=? RETURNING guild_id").bind(guild,channel,owner).first();
  if (!creating) return;
  row.message_id = null;
  const current = await env.DB.prepare('SELECT schedule_channel FROM guilds WHERE id=?').bind(guild).first<{schedule_channel:string|null}>();
  if (date !== todayKst() || current?.schedule_channel !== channel || !allowedGuild(guild,env)) { await release('idle',null,null); return; }
  outcome = await sendSummary(env,channel,input,null);
 }
 if (outcome.state === 'sent') { await release('ready',null,outcome.messageId,date); return; }
 // The cooldown belongs to this message, not only today's job: tomorrow's job must respect it too.
 if (outcome.state === 'retry') { await release('retry','Summary request safely retryable',row.message_id,null,new Date(Date.now()+outcome.seconds*1000).toISOString()); throw new ScheduleSummaryRetry(outcome.seconds); }
 await release(outcome.state, outcome.state === 'uncertain' ? 'Summary POST outcome uncertain; manual reconciliation required' : 'Summary request rejected; check channel permissions', row.message_id);
}
