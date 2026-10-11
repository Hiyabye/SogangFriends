import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleSummary, ScheduleSummaryRetry, updateScheduleSummary } from '../src/schedule-summary';
import { testDatabase } from './helpers/db';
import { recover } from '../src/storage';
import type { Schedule } from '../src/types';

const entry = (changes: Partial<Schedule> = {}): Schedule => ({ id:'midterms',title:'중간시험',startDate:'2026-10-20',endDate:'2026-10-26',type:'period',sourceUrl:'https://www.sogang.ac.kr/ko/academic-support/calendar',lastReviewed:'2026-10-09',note:'',active:true,...changes });
let db: ReturnType<typeof testDatabase>;
const state = () => db.sqlite.prepare("SELECT * FROM schedule_messages WHERE guild_id='111' AND channel_id='333'").get()!;
const run = () => updateScheduleSummary(db.env,'111','333','2026-10-11',[entry()]);
const sent = (id='444') => Response.json({id,channel_id:'333'});
beforeEach(() => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));
 db = testDatabase(); db.env.DISCORD_TOKEN = 'fixture';
 db.sqlite.prepare('INSERT INTO guilds(id,schedule_channel,updated_at) VALUES(?,?,?)').run('111','333','2026-10-11');
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('all-future schedule summary', () => {
 it('includes D-day, ongoing explicit deadlines, and dates beyond 30 days; excludes unapproved/faculty/past', () => {
  const output = scheduleSummary([
   entry({id:'today',startDate:'2026-10-11',endDate:undefined,type:'event'}),
   entry({id:'ongoing',startDate:'2026-10-01',deadlineDate:'2026-10-20'}),
   entry({id:'far',title:'먼 일정',startDate:'2027-02-18',endDate:undefined,type:'event'}),
   entry({id:'inactive',title:'승인 전',active:false}), entry({id:'faculty',title:'교직원',note:'교직원 대상'}),
   entry({id:'past',title:'지난 일정',startDate:'2026-10-01',endDate:'2026-10-10'}),
  ], '2026-10-11');
  expect(output).toContain('D-day'); expect(output).toContain('진행 중 · 마감 D-9'); expect(output).toContain('먼 일정');
  expect(output).not.toContain('승인 전'); expect(output).not.toContain('교직원'); expect(output).not.toContain('지난 일정');
  expect(output).toContain('2026-10-11 KST');
 });
 it('does not invent a deadline from a period end date', () => {
  expect(scheduleSummary([entry({startDate:'2026-10-01'})],'2026-10-11')).toContain('진행 중 |');
  expect(scheduleSummary([entry({startDate:'2026-10-01'})],'2026-10-11')).not.toContain('마감 D-');
 });
 it('has a clear empty state and rejects invalid dates', () => {
  expect(scheduleSummary([], '2026-10-11')).toContain('앞으로의 승인된 학사일정이 없습니다.');
  expect(() => scheduleSummary([], '2026-02-30')).toThrow('Invalid summary date');
 });
 it('attaches the entire output instead of truncating or splitting into multiple posts', () => {
  const entries = Array.from({length:50}, (_,i) => entry({id:`item-${i}`,title:`일정 ${i}`,note:'긴 안내'.repeat(20)}));
  const input = scheduleSummary(entries,'2026-10-11'); expect(typeof input).toBe('object');
  if (typeof input === 'string') throw new Error('Expected file');
  expect(input.content.length).toBeLessThan(2000);
  const full = new TextDecoder().decode(input.file!.bytes);
  for(let i=0;i<50;i++) expect(full).toContain(`일정 ${i}`);
  expect(input.file!.filename).toBe('schedule-2026-10-11.txt');
 });
});

describe('tracked editable summary', () => {
 it('creates once, deduplicates same-day jobs, then PATCHes the same message the next day', async () => {
  const fetch = vi.fn().mockResolvedValue(sent()); vi.stubGlobal('fetch',fetch);
  await run(); await run(); expect(fetch).toHaveBeenCalledTimes(1); expect(state().message_id).toBe('444');
  vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  await updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]);
  expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][0]).toContain('/messages/444');
  expect(fetch.mock.calls[1][1].method).toBe('PATCH'); expect(state().updated_date).toBe('2026-10-12');
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({attachments:[],allowed_mentions:{parse:[]}});
 });
 it('overlapping initial jobs never perform two POSTs', async () => {
  let finish!: (response:Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => {finish=resolve;})); vi.stubGlobal('fetch',fetch);
  const first = run(); for(let i=0;i<20&&!finish;i++) await Promise.resolve();
  await expect(run()).rejects.toBeInstanceOf(ScheduleSummaryRetry);
  expect(fetch).toHaveBeenCalledTimes(1); finish(sent()); await first;
 });
 it.each(['network','server','invalid-success'])('preserves uncertain POST outcomes (%s) across later jobs', async kind => {
  const fetch = vi.fn();
  if(kind==='network') fetch.mockRejectedValue(new Error('network')); else fetch.mockResolvedValue(kind==='server'?new Response('',{status:503}):Response.json({id:'bad'}));
  vi.stubGlobal('fetch',fetch); await run(); expect(state().state).toBe('uncertain'); await run();
  vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  await updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]); expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('a crashed initial POST remains uncertain even after generic job recovery', async () => {
  db.sqlite.prepare("INSERT INTO schedule_messages(guild_id,channel_id,state,updated_at,lease_owner,lease_until) VALUES('111','333','creating','2026-10-10','old','2026-10-10')").run();
  const fetch = vi.fn(); vi.stubGlobal('fetch',fetch); await recover(db.env); await run();
  expect(state().state).toBe('uncertain'); expect(fetch).not.toHaveBeenCalled();
 });
 it('an interrupted PATCH can recover safely without a new create', async () => {
  db.sqlite.prepare("INSERT INTO schedule_messages(guild_id,channel_id,message_id,state,updated_at,lease_owner,lease_until) VALUES('111','333','444','editing','2026-10-10','old','2026-10-10')").run();
  const fetch = vi.fn().mockResolvedValue(sent()); vi.stubGlobal('fetch',fetch); await run();
  expect(fetch.mock.calls[0][1].method).toBe('PATCH'); expect(state().state).toBe('ready');
 });
 it('honors confirmed create 429 and safe PATCH network retries', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({retry_after:120},{status:429})).mockResolvedValueOnce(sent()); vi.stubGlobal('fetch',fetch);
  await expect(run()).rejects.toMatchObject({retryAfter:120}); expect(state().state).toBe('retry');
  await expect(run()).rejects.toMatchObject({retryAfter:120});expect(fetch).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(120000);await run();
  vi.setSystemTime(new Date('2026-10-12T00:00:00Z')); fetch.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(sent());
  const next = () => updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]);
  await expect(next()).rejects.toBeInstanceOf(ScheduleSummaryRetry); vi.advanceTimersByTime(60000);await next();
  expect(fetch.mock.calls.slice(2).every(call=>call[1].method==='PATCH')).toBe(true);
 });
 it('preserves Retry-After across KST date changes and distinct daily jobs',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({retry_after:86400},{status:429})).mockResolvedValueOnce(sent());vi.stubGlobal('fetch',fetch);
  await run();vi.setSystemTime(new Date('2026-10-12T14:00:00Z')); // 23:00 KST
  await expect(updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()])).rejects.toMatchObject({retryAfter:86400});
  vi.setSystemTime(new Date('2026-10-12T22:30:00Z')); // next day's 07:30 KST
  await expect(updateScheduleSummary(db.env,'111','333','2026-10-13',[entry()])).rejects.toMatchObject({retryAfter:55800});
  expect(fetch).toHaveBeenCalledTimes(2);expect(state().retry_at).toBe('2026-10-13T14:00:00.000Z');
  vi.setSystemTime(new Date('2026-10-13T14:00:00Z'));
  await updateScheduleSummary(db.env,'111','333','2026-10-13',[entry()]);
  expect(fetch).toHaveBeenCalledTimes(3);expect(state().retry_at).toBeNull();expect(state().updated_date).toBe('2026-10-13');
 });
 it('recreates only after the exact Unknown Message 404', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({code:10008},{status:404})).mockResolvedValueOnce(sent('555')); vi.stubGlobal('fetch',fetch);
  await run(); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  await updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]);
  expect(fetch.mock.calls.map(call=>call[1].method)).toEqual(['POST','PATCH','POST']); expect(state().message_id).toBe('555');
 });
 it.each([403,404,500])('does not create after a generic PATCH HTTP %s', async status => {
  const fetch = vi.fn().mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({code:10003},{status})); vi.stubGlobal('fetch',fetch);
  await run(); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  const next = updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]);
  if(status===500) await expect(next).rejects.toBeInstanceOf(ScheduleSummaryRetry); else await next;
  expect(fetch).toHaveBeenCalledTimes(2); expect(state().message_id).toBe('444');
 });
 it('does not recreate after a channel change during a missing-message PATCH', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(sent()).mockImplementationOnce(async () => {
   db.sqlite.prepare("UPDATE guilds SET schedule_channel='999' WHERE id='111'").run();
   return Response.json({code:10008},{status:404});
  }); vi.stubGlobal('fetch',fetch);
  await run(); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  await updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]);
  expect(fetch).toHaveBeenCalledTimes(2); expect(state().state).toBe('idle'); expect(state().message_id).toBeNull();
 });
 it('a malformed replacement POST is uncertain rather than another recreation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({code:10008},{status:404})).mockResolvedValueOnce(Response.json({})); vi.stubGlobal('fetch',fetch);
  await run(); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  const next = () => updateScheduleSummary(db.env,'111','333','2026-10-12',[entry()]);
  await next(); await next(); expect(fetch).toHaveBeenCalledTimes(3); expect(state().state).toBe('uncertain');
 });
 it('does not attempt an HTTP request without a token or classify this as uncertain', async () => {
  db.env.DISCORD_TOKEN=undefined; const fetch=vi.fn(); vi.stubGlobal('fetch',fetch); await run();
  expect(fetch).not.toHaveBeenCalled(); expect(state().state).toBe('failed');
 });
 it('suppresses stale jobs and unconfigured/disallowed channels', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
  await updateScheduleSummary(db.env,'111','333','2026-10-10',[entry()]);
  await updateScheduleSummary(db.env,'111','999','2026-10-11',[entry()]);
  await updateScheduleSummary(db.env,'999','333','2026-10-11',[entry()]); expect(fetch).not.toHaveBeenCalled();
 });
 it('a channel change creates only in the new channel and retains old tracking without DELETE', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({id:'555',channel_id:'999'})); vi.stubGlobal('fetch',fetch);
  await run(); db.sqlite.prepare("UPDATE guilds SET schedule_channel='999' WHERE id='111'").run(); await run();
  await updateScheduleSummary(db.env,'111','999','2026-10-11',[entry()]);
  expect(fetch.mock.calls.map(call=>call[1].method)).toEqual(['POST','POST']); expect(state().message_id).toBe('444');
 });
 it('uploads a complete file and explicitly replaces attachments on PATCH retries', async () => {
  const items = Array.from({length:40},(_,i)=>entry({id:`entry-${i}`,title:`entry ${i}`,note:'설명'.repeat(40)}));
  const fetch = vi.fn().mockResolvedValueOnce(sent()).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(sent()); vi.stubGlobal('fetch',fetch);
  await updateScheduleSummary(db.env,'111','333','2026-10-11',items); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  const next = () => updateScheduleSummary(db.env,'111','333','2026-10-12',items);
  await expect(next()).rejects.toBeInstanceOf(ScheduleSummaryRetry);vi.advanceTimersByTime(60000);await next();
  for(const call of fetch.mock.calls) {
   const form = call[1].body as FormData; expect(form).toBeInstanceOf(FormData);
   const payload = JSON.parse(String(form.get('payload_json'))); expect(payload.attachments).toHaveLength(1); expect(payload.allowed_mentions.parse).toEqual([]);
   expect(await (form.get('files[0]') as Blob).text()).toContain('entry');
  }
 });
});
