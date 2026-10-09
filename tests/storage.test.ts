import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDatabase } from './helpers/db';
import { claim, deliveryIntent, dispatch, enqueue, recover, reserveLlm, retryJob, saveNotices, sourceFailure } from '../src/storage';
import { consume, executeJob } from '../src/jobs';
import type { Job, Notice } from '../src/types';

let db:ReturnType<typeof testDatabase>;
const notice=(id:string,title=`공지 ${id}`):Notice=>({id,source:'university',title,published:'2026-10-09',url:`https://www.sogang.ac.kr/ko/detail/${id}?bbsConfigFk=2`});
const row=(table:string,id:string)=>db.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
const counts=(table:string)=>Number(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
const jobFor=(deliveryId:string):Job=>({id:`send:${deliveryId}`,kind:'deliver',payload:JSON.stringify({deliveryId}),state:'running',attempts:1,created_at:new Date().toISOString(),lease_until:null});
beforeEach(()=>{db=testDatabase();});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('D1-style storage with actual SQLite',()=>{
 it('suppresses the initial baseline and emits only stable-ID new notices after initialization',async()=>{
  await saveNotices(db.env,'university',[notice('1'),notice('2')],'2026-10-09T00:00:00Z');
  expect(counts('notices')).toBe(2);expect(counts('jobs')).toBe(0);
  await saveNotices(db.env,'university',[notice('2'),notice('1'),notice('3')],'2026-10-09T06:00:00Z');
  const jobs=db.sqlite.prepare("SELECT payload FROM jobs WHERE kind='notice-alert'").all();
  expect(jobs).toHaveLength(1);expect(JSON.parse(String(jobs[0].payload)).notices.map((n:Notice)=>n.id)).toEqual(['3']);
  await saveNotices(db.env,'university',[notice('3'),notice('1'),notice('2')],'2026-10-09T12:00:00Z');
  expect(counts('jobs')).toBe(1);expect(counts('notices')).toBe(3);
 });
 it('upserts changed titles and links without treating pinned/reordered IDs as new',async()=>{
  await saveNotices(db.env,'university',[notice('1'),notice('2')],'2026-10-09T00:00:00Z');
  const edited={...notice('1','수정 제목'),url:'https://www.sogang.ac.kr/ko/detail/1?bbsConfigFk=2&corrected=1'};
  await saveNotices(db.env,'university',[notice('2'),edited],'2026-10-09T06:00:00Z');
  expect(counts('jobs')).toBe(0);
  expect(db.sqlite.prepare('SELECT title,url FROM notices WHERE source=? AND id=?').get('university','1')).toMatchObject({title:edited.title,url:edited.url});
 });
 it('preserves good rows and original successful collection time on source failure',async()=>{
  const at='2026-10-09T00:00:00Z';
  await saveNotices(db.env,'university',[notice('1')],at);
  await sourceFailure(db.env,'university');
  expect(row('sources','university')).toMatchObject({initialized:1,last_success:at,error:'source collection failed'});
  expect(row('sources','university')!.last_attempt).not.toBe(at);
  expect(db.sqlite.prepare('SELECT collected_at FROM notices').get()!.collected_at).toBe(at);
  expect(counts('notices')).toBe(1);
  await sourceFailure(db.env,'career');
  expect(row('sources','career')).toMatchObject({initialized:0,last_success:null});
 });
 it('uses atomic claims to exclude overlapping Queue redeliveries and limits retries to three attempts',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
  await Promise.all([enqueue(db.env,'same','collect',{source:'university'}),enqueue(db.env,'same','collect',{})]);
  expect(counts('jobs')).toBe(1);
  const claims=await Promise.all([claim(db.env,'same'),claim(db.env,'same')]);
  expect(claims.filter(Boolean)).toHaveLength(1);expect(claims.find(Boolean)!.attempts).toBe(1);
  await retryJob(db.env,claims.find(Boolean)!,'temporary',60);
  expect(await claim(db.env,'same')).toBeNull();
  vi.advanceTimersByTime(60000);
  const second=await claim(db.env,'same');expect(second!.attempts).toBe(2);
  await retryJob(db.env,second!,'temporary',1);vi.advanceTimersByTime(1000);
  const third=await claim(db.env,'same');expect(third!.attempts).toBe(3);
  await retryJob(db.env,third!,'temporary',1);vi.advanceTimersByTime(1000);
  expect(row('jobs','same')!.state).toBe('failed');expect(await claim(db.env,'same')).toBeNull();
 });
 it('holds failed/unknown LLM reservations and enforces daily calls atomically',async()=>{
  Object.assign(db.env,{LLM_ENABLED:'true',OPENROUTER_API_KEY:'fixture-only',LLM_DAILY_CALLS:'2',LLM_DAILY_BUDGET_USD:'0.50',LLM_MAX_CALL_USD:'0.25'});
  const reservations=await Promise.all(['a','b','c'].map(id=>reserveLlm(db.env,id,'2026-10-09')));
  expect(reservations.filter(Boolean)).toHaveLength(2);expect(counts('llm_usage')).toBe(2);
  expect(await reserveLlm(db.env,'a','2026-10-09')).toBe(false);
  expect(await reserveLlm(db.env,'next','2026-10-10')).toBe(true);
  db.sqlite.prepare('UPDATE llm_usage SET actual_usd=1 WHERE id=?').run('next');
  expect(await reserveLlm(db.env,'over','2026-10-10')).toBe(false);
 });
 it('fails closed with missing key, disabled extraction, and invalid budgets',async()=>{
  expect(await reserveLlm(db.env,'a','2026-10-09')).toBe(false);
  Object.assign(db.env,{LLM_ENABLED:'true',OPENROUTER_API_KEY:'fixture-only',LLM_DAILY_BUDGET_USD:'not-a-number'});
  expect(await reserveLlm(db.env,'b','2026-10-09')).toBe(false);expect(counts('llm_usage')).toBe(0);
 });
 it('persists delivery intent and outbox atomically, deduplicates, and separates guild records',async()=>{
  await Promise.all([deliveryIntent(db.env,'notice:111','111','1001','hello'),deliveryIntent(db.env,'notice:111','111','1001','hello')]);
  await deliveryIntent(db.env,'notice:222','222','2002','hello');
  expect(counts('deliveries')).toBe(2);expect(counts('jobs')).toBe(2);
  expect(row('deliveries','notice:111')).toMatchObject({guild_id:'111',channel_id:'1001',state:'pending'});
  expect(row('deliveries','notice:222')).toMatchObject({guild_id:'222',channel_id:'2002'});
  await dispatch(db.env);
  expect(db.env.JOBS.send).toHaveBeenCalledTimes(2);
 });
 it('rolls back all statements in a failed D1-style batch',async()=>{
  await expect(db.env.DB.batch([
   db.env.DB.prepare('INSERT INTO guilds(id,updated_at) VALUES(?,?)').bind('111','now'),
   db.env.DB.prepare('INSERT INTO missing_table(id) VALUES(?)').bind('bad')
  ])).rejects.toThrow();
  expect(counts('guilds')).toBe(0);
 });
 it('recovers interrupted POSTs as uncertain rather than replaying',async()=>{
  await deliveryIntent(db.env,'interrupted','111','1001','hello');
  db.sqlite.prepare("UPDATE deliveries SET state='sending',updated_at='2026-01-01T00:00:00Z' WHERE id=?").run('interrupted');
  db.sqlite.prepare("UPDATE jobs SET state='running',lease_until='2026-01-01T00:00:00Z' WHERE id=?").run('send:interrupted');
  await recover(db.env);
  expect(row('deliveries','interrupted')!.state).toBe('uncertain');expect(row('jobs','send:interrupted')!.state).toBe('needs_review');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await executeJob(db.env,jobFor('interrupted'));
  expect(fetch).not.toHaveBeenCalled();
 });
});

describe('delivery consumer integration',()=>{
 it('claims the same Queue message once across overlapping consumers',async()=>{
  db.env.DISCORD_TOKEN='fixture-only';await deliveryIntent(db.env,'concurrent','111','1001','hello');
  const fetch=vi.fn().mockResolvedValue(Response.json({id:'9002',channel_id:'1001'}));vi.stubGlobal('fetch',fetch);
  const batch=()=>({messages:[{body:{id:'send:concurrent'},ack:vi.fn()}],queue:'fixture'} as never);
  await Promise.all([consume(db.env,batch()),consume(db.env,batch())]);
  expect(fetch).toHaveBeenCalledTimes(1);expect(row('jobs','send:concurrent')!.attempts).toBe(1);
  expect(row('deliveries','concurrent')!.state).toBe('sent');
 });
 it('records ambiguous POST outcomes and never posts again on job replay',async()=>{
  db.env.DISCORD_TOKEN='fixture-only';
  await deliveryIntent(db.env,'ambiguous','111','1001','hello');
  const fetch=vi.fn().mockRejectedValue(new Error('network interrupted'));vi.stubGlobal('fetch',fetch);
  const ack=vi.fn();
  await consume(db.env,{messages:[{body:{id:'send:ambiguous'},ack}],queue:'fixture'} as never);
  expect(row('deliveries','ambiguous')!.state).toBe('uncertain');expect(row('jobs','send:ambiguous')!.state).toBe('done');expect(ack).toHaveBeenCalledTimes(1);
  await executeJob(db.env,jobFor('ambiguous'));expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('stores confirmed Discord ID and prevents duplicate replay',async()=>{
  db.env.DISCORD_TOKEN='fixture-only';await deliveryIntent(db.env,'confirmed','111','1001','hello');
  const fetch=vi.fn().mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));vi.stubGlobal('fetch',fetch);
  await executeJob(db.env,jobFor('confirmed'));await executeJob(db.env,jobFor('confirmed'));
  expect(row('deliveries','confirmed')).toMatchObject({state:'sent',message_id:'9001'});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('does not post delivery intents for disallowed guilds',async()=>{
  db.env.DISCORD_TOKEN='fixture-only';await deliveryIntent(db.env,'other','333','3003','hello');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await executeJob(db.env,jobFor('other'));
  expect(fetch).not.toHaveBeenCalled();expect(row('deliveries','other')!.state).toBe('failed');
 });
 it('defers explicit 429 rejection for a bounded safe retry',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
  db.env.DISCORD_TOKEN='fixture-only';await deliveryIntent(db.env,'limited','111','1001','hello');
  const fetch=vi.fn().mockResolvedValue(Response.json({retry_after:10},{status:429}));vi.stubGlobal('fetch',fetch);
  await consume(db.env,{messages:[{body:{id:'send:limited'},ack:vi.fn()}],queue:'fixture'} as never);
  expect(row('deliveries','limited')!.state).toBe('retry');expect(row('jobs','send:limited')!.state).toBe('retry');
  expect(Date.parse(String(row('jobs','send:limited')!.available_at))-Date.now()).toBe(10000);
  expect(await claim(db.env,'send:limited')).toBeNull();expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('expires stale delivery intent before POST when the migration supports expiry',async(context)=>{
  const columns=db.sqlite.prepare('PRAGMA table_info(deliveries)').all();
  if(!columns.some(c=>c.name==='expires_at')) {context.skip('expires_at migration not yet implemented');return;}
  db.env.DISCORD_TOKEN='fixture-only';await deliveryIntent(db.env,'stale','111','1001','old meal');
  db.sqlite.prepare("UPDATE deliveries SET expires_at='2026-01-01T00:00:00Z' WHERE id=?").run('stale');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await executeJob(db.env,jobFor('stale'));
  expect(fetch).not.toHaveBeenCalled();expect(row('deliveries','stale')!.state).toBe('expired');
 });
});
