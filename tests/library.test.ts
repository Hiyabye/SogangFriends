import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {LIBRARY_CRON,LIBRARY_SEAT_POLICY,libraryDeliveryCurrent,libraryWindow,pollLibrary,saveLibrarySnapshot} from '../src/library';
import * as source from '../src/library-source';
import {consume,executeJob} from '../src/jobs';
import {claim,recover} from '../src/storage';
import worker,{completeInteraction} from '../src/worker';
import {COMMANDS} from '../src/discord';
import type {Job} from '../src/types';

let db:ReturnType<typeof testDatabase>;
const start=Date.parse('2026-10-16T01:00:00.000Z'); // 10:00 KST
const channel='1560616038272475137';
const iso=(time=Date.now())=>new Date(time).toISOString();
function configure(guild='111',destination=channel){
 db.sqlite.prepare('INSERT INTO guilds(id,library_channel,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET library_channel=excluded.library_channel').run(guild,destination,iso());
}
const snapshot=(remaining:number,at=Date.now()):source.LibrarySnapshot=>({remaining,total:96,used:96-remaining,sourceAt:iso(at)});
const watch=(guild='111')=>db.sqlite.prepare('SELECT * FROM library_watches WHERE guild_id=?').get(guild)!;
const count=(table:'jobs'|'deliveries'|'library_watches')=>Number(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
const deliveries=()=>db.sqlite.prepare('SELECT * FROM deliveries ORDER BY created_at,id').all();
const tick=(ms=60_000)=>vi.advanceTimersByTime(ms);
async function observe(remaining:number,advance=0){tick(advance);await saveLibrarySnapshot(db.env,snapshot(remaining));}
async function opening(){await observe(0);await observe(2,60_000);return String(watch().event_id);}
const deliveryJob=(event:string)=>db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(`send:${event}`) as unknown as Job;

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(start);db=testDatabase();});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('library availability transitions with real SQLite',()=>{
 it.each([0,3])('silently establishes an initial baseline with %s remaining seats',async remaining=>{
  configure();await observe(remaining);
  expect(watch()).toMatchObject({channel_id:channel,day:'2026-10-16',remaining,source_at:iso(),observed_at:iso(),event_id:null});
  expect(count('deliveries')).toBe(0);expect(count('jobs')).toBe(0);
 });
 it('commits one full-to-available intent, stays silent while positive and rearms only after full',async()=>{
  configure();const first=await opening();
  expect(count('deliveries')).toBe(1);expect(count('jobs')).toBe(1);
  expect(deliveries()[0]).toMatchObject({id:first,guild_id:'111',channel_id:channel,state:'pending',expires_at:iso(Date.now()+120_000)});
  expect(JSON.parse(deliveryJob(first).payload)).toEqual({deliveryId:first,libraryEvent:first});
  await observe(5,60_000);expect(watch().event_id).toBe(first);expect(count('deliveries')).toBe(1);
  await observe(0,60_000);expect(watch().event_id).toBeNull();
  await observe(1,60_000);expect(watch().event_id).not.toBe(first);expect(count('deliveries')).toBe(2);
 });
 it.each([null,'unknown-policy'])('silently replaces a %s policy observation even at the same source timestamp',async policy=>{
  configure();await observe(0);
  db.sqlite.prepare('UPDATE library_watches SET seat_policy=?').run(policy);
  await observe(3);
  expect(watch()).toMatchObject({remaining:3,seat_policy:LIBRARY_SEAT_POLICY,event_id:null});
  expect(count('deliveries')).toBe(0);expect(count('jobs')).toBe(0);
  await observe(0,60_000);await observe(1,60_000);
  expect(count('deliveries')).toBe(1);
 });
 it('resets the policy without rewriting existing alert history',async()=>{
  configure();const event=await opening();const before=deliveries()[0];
  db.sqlite.prepare('UPDATE library_watches SET seat_policy=NULL').run();
  await observe(2,30_000);
  expect(watch()).toMatchObject({seat_policy:LIBRARY_SEAT_POLICY,event_id:null});
  expect(deliveries()).toEqual([before]);
  expect(await libraryDeliveryCurrent(db.env,'111',channel,event)).toBe(false);
 });
 it('starts silently again on the next KST day',async()=>{
  configure();await observe(0);
  vi.setSystemTime(Date.parse('2026-10-17T01:00:00Z'));await observe(4);
  expect(watch()).toMatchObject({day:'2026-10-17',remaining:4,event_id:null});expect(count('deliveries')).toBe(0);
 });
 it.each([180_000,240_000])('silently resets after an observation gap of %sms',async gap=>{
  configure();await observe(0);await observe(3,gap);
  expect(watch()).toMatchObject({remaining:3,event_id:null});expect(count('deliveries')).toBe(0);
 });
 it('also resets after a three-minute source timestamp gap despite a recent retrieval time',async()=>{
  configure();await observe(0);tick(180_000);
  db.sqlite.prepare('UPDATE library_watches SET observed_at=?').run(iso(Date.now()-30_000));
  await observe(1);expect(count('deliveries')).toBe(0);expect(watch().event_id).toBeNull();
 });
 it('still alerts after a short failure gap below three minutes',async()=>{
  configure();await observe(0);await observe(1,179_000);expect(count('deliveries')).toBe(1);
 });
 it('ignores repeated and out-of-order source timestamps without refreshing observation time',async()=>{
  configure();await observe(0);const before=watch();tick(60_000);
  await saveLibrarySnapshot(db.env,snapshot(2,start));
  await saveLibrarySnapshot(db.env,snapshot(2,start-1000));
  expect(watch()).toEqual(before);expect(count('deliveries')).toBe(0);
 });
 it.each([-120_001,30_001])('rejects stale or future source timestamps (%sms) without changing good state',async offset=>{
  configure();await observe(0);const before=watch();
  await expect(saveLibrarySnapshot(db.env,snapshot(1,Date.now()+offset))).rejects.toThrow('freshness window');
  expect(watch()).toEqual(before);expect(count('deliveries')).toBe(0);
 });
 it('separates guild routes, excludes disallowed servers and never hard-codes the requested channel',async()=>{
  configure();configure('222','2002');configure('333','3003');
  await opening();
  expect(count('library_watches')).toBe(2);expect(count('deliveries')).toBe(2);
  expect(deliveries()).toEqual(expect.arrayContaining([expect.objectContaining({guild_id:'111',channel_id:channel}),expect.objectContaining({guild_id:'222',channel_id:'2002'})]));
  expect(db.sqlite.prepare("SELECT * FROM library_watches WHERE guild_id='333'").get()).toBeUndefined();
 });
 it('newly configured routes get a silent baseline without inheriting another route or guild state',async()=>{
  configure();await observe(0);configure('111','1002');configure('222','2002');
  await observe(3,60_000);expect(count('deliveries')).toBe(0);
  expect(watch()).toMatchObject({channel_id:'1002',remaining:3,event_id:null});
  expect(watch('222')).toMatchObject({channel_id:'2002',remaining:3,event_id:null});
 });
 it('deduplicates concurrent full-to-available observations with the compare-and-swap revision',async()=>{
  configure();await observe(0);tick();const s=snapshot(1);
  await Promise.all([saveLibrarySnapshot(db.env,s),saveLibrarySnapshot(db.env,s)]);
  expect(count('deliveries')).toBe(1);expect(count('jobs')).toBe(1);
  expect(deliveries()[0].id).toBe(watch().event_id);
 });
 it.each([[1,0],[0,1]])('retains the newer concurrent observation (%s → %s) after a CAS conflict',async(older,newer)=>{
  configure();await observe(0);tick();
  await Promise.all([saveLibrarySnapshot(db.env,snapshot(older,Date.now()-1000)),saveLibrarySnapshot(db.env,snapshot(newer))]);
  expect(watch()).toMatchObject({remaining:newer,source_at:iso()});
  if(newer===0){
   expect(watch().event_id).toBeNull();
   for(const delivery of deliveries())expect(await libraryDeliveryCurrent(db.env,'111',channel,String(delivery.id))).toBe(false);
  }else{
   expect(count('deliveries')).toBe(1);
   expect(await libraryDeliveryCurrent(db.env,'111',channel,String(watch().event_id))).toBe(true);
  }
 });
 it('rolls back state and intent together when creating the send job fails',async()=>{
  configure();await observe(0);const before=watch();tick();
  db.sqlite.exec("CREATE TRIGGER fail_library_job BEFORE INSERT ON jobs WHEN NEW.kind='deliver' BEGIN SELECT RAISE(ABORT,'injected send job failure'); END");
  await expect(saveLibrarySnapshot(db.env,snapshot(1))).rejects.toThrow('injected send job failure');
  expect(watch()).toEqual(before);expect(count('deliveries')).toBe(0);expect(count('jobs')).toBe(0);
  db.sqlite.exec('DROP TRIGGER fail_library_job');await observe(1);
  expect(count('deliveries')).toBe(1);expect(watch().remaining).toBe(1);
 });
 it('caps late-evening intent expiry at 22:00 KST',async()=>{
  configure();vi.setSystemTime(Date.parse('2026-10-16T12:58:30Z'));await observe(0);await observe(1,60_000);
  expect(deliveries()[0].expires_at).toBe('2026-10-16T13:00:00.000Z');
 });
});

describe('library delivery eligibility and ordinary durable sends',()=>{
 it('allows the latest opening only while the route and snapshot remain current',async()=>{
  configure();const event=await opening();
  expect(await libraryDeliveryCurrent(db.env,'111',channel,event)).toBe(true);
  expect(await libraryDeliveryCurrent(db.env,'222',channel,event)).toBe(false);
  expect(await libraryDeliveryCurrent(db.env,'111',channel,null)).toBe(false);
  expect(await libraryDeliveryCurrent(db.env,'111',channel,'other')).toBe(false);
 });
 it.each([null,'unknown-policy'])('rejects a queued old-policy alert (%s) before any POST',async policy=>{
  configure();const event=await opening();
  db.sqlite.prepare('UPDATE library_watches SET seat_policy=?').run(policy);
  expect(await libraryDeliveryCurrent(db.env,'111',channel,event)).toBe(false);
  const api=vi.spyOn(globalThis,'fetch');await executeJob(db.env,deliveryJob(event));
  expect(api).not.toHaveBeenCalled();
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('expired');
 });
 it('invalidates old-cycle intents even if a later cycle is available',async()=>{
  configure();const first=await opening();await observe(0,30_000);await observe(1,30_000);const second=String(watch().event_id);
  expect(await libraryDeliveryCurrent(db.env,'111',channel,first)).toBe(false);
  expect(await libraryDeliveryCurrent(db.env,'111',channel,second)).toBe(true);
 });
 it.each(['full','channel','stale','outside','nextDay'] as const)('rejects and expires a queued send after %s',async reason=>{
  configure();const event=await opening();
  if(reason==='full')await observe(0,30_000);
  if(reason==='channel')configure('111','1002');
  if(reason==='stale')tick(120_001);
  if(reason==='outside')vi.setSystemTime(Date.parse('2026-10-16T13:00:00Z'));
  if(reason==='nextDay')vi.setSystemTime(Date.parse('2026-10-17T01:00:00Z'));
  expect(await libraryDeliveryCurrent(db.env,'111',channel,event)).toBe(false);
  const api=vi.spyOn(globalThis,'fetch');await executeJob(db.env,deliveryJob(event));
  expect(api).not.toHaveBeenCalled();
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('expired');
 });
 it('requires a recent observation independently of a recent source timestamp',async()=>{
  configure();const event=await opening();
  db.sqlite.prepare('UPDATE library_watches SET observed_at=?').run(iso(Date.now()-120_001));
  expect(await libraryDeliveryCurrent(db.env,'111',channel,event)).toBe(false);
 });
 it('posts a current alert once through the existing outbox and disables all mentions',async()=>{
  configure();db.env.DISCORD_TOKEN='fixture';const event=await opening();
  const api=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'98765',channel_id:channel}));
  const msg={body:{id:`send:${event}`},ack:vi.fn()};
  await consume(db.env,{messages:[msg]} as unknown as MessageBatch<{id:string}>);
  await consume(db.env,{messages:[msg]} as unknown as MessageBatch<{id:string}>);
  expect(api).toHaveBeenCalledTimes(1);expect(api.mock.calls[0][0]).toBe(`https://discord.com/api/v10/channels/${channel}/messages`);
  const body=JSON.parse(api.mock.calls[0][1]!.body as string);
  expect(body).toMatchObject({allowed_mentions:{parse:[]}});expect(body.content).toContain('알림 대상 96석 중 잔여 2석');
  expect(body.content).toContain('장애인석 1·3·44·85번과 리클라이너석 101·102번은 제외했습니다.');
  expect(body.content).toContain('roomview5.asp?room_no=5');
  expect(db.sqlite.prepare('SELECT state,message_id FROM deliveries WHERE id=?').get(event)).toMatchObject({state:'sent',message_id:'98765'});
  expect(deliveryJob(event).state).toBe('done');
 });
 it('freezes unknown POST outcomes rather than automatically retrying',async()=>{
  configure();db.env.DISCORD_TOKEN='fixture';const event=await opening();
  const api=vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('connection lost'));
  const msg={body:{id:`send:${event}`},ack:vi.fn()};
  await consume(db.env,{messages:[msg]} as unknown as MessageBatch<{id:string}>);
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('uncertain');
  await consume(db.env,{messages:[msg]} as unknown as MessageBatch<{id:string}>);expect(api).toHaveBeenCalledTimes(1);
 });
 it('retains interrupted library sends under ordinary delivery lease recovery',async()=>{
  configure();const event=await opening();await claim(db.env,`send:${event}`);
  db.sqlite.prepare("UPDATE deliveries SET state='sending' WHERE id=?").run(event);tick(21*60_000);await recover(db.env);
  expect(deliveryJob(event).state).toBe('needs_review');
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('uncertain');
 });
 it('does not let a rate-limit retry send after the snapshot expires',async()=>{
  configure();db.env.DISCORD_TOKEN='fixture';const event=await opening();
  const api=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({retry_after:1},{status:429}));
  await expect(executeJob(db.env,deliveryJob(event))).rejects.toThrow('Discord rate limited');
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('retry');
  tick(120_001);await executeJob(db.env,deliveryJob(event));expect(api).toHaveBeenCalledTimes(1);
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('expired');
 });
});

describe('library poll scheduling and health',()=>{
 it.each(['2026-10-16T00:59:59Z','2026-10-16T13:00:00Z'])('excludes %s from the daytime window',time=>{
  expect(libraryWindow(Date.parse(time))).toBe(false);
 });
 it.each(['2026-10-16T01:00:00Z','2026-10-16T12:59:59Z'])('includes %s in the daytime window',time=>{
  expect(libraryWindow(Date.parse(time))).toBe(true);
 });
 it.each(['unconfigured','disallowed','outside','staleTick','futureTick','outsideTick'] as const)('does no source work for %s',async reason=>{
  const fetcher=vi.spyOn(source,'fetchLibrarySnapshot');
  if(reason==='disallowed')configure('333');else if(reason!=='unconfigured')configure();
  if(reason==='outside')vi.setSystemTime(Date.parse('2026-10-16T13:00:00Z'));
  const scheduled=reason==='staleTick'?Date.now()-60_001:reason==='futureTick'?Date.now()+60_001:reason==='outsideTick'?Date.parse('2026-10-16T13:00:00Z'):Date.now();
  await pollLibrary(db.env,scheduled);
  expect(fetcher).not.toHaveBeenCalled();expect(count('jobs')).toBe(0);expect(count('library_watches')).toBe(0);
  expect(db.sqlite.prepare("SELECT * FROM health WHERE id='library'").get()).toBeUndefined();
 });
 it('fetches once for all configured guilds, records health and dispatches only opening intents',async()=>{
  configure();configure('222','2002');const fetcher=vi.spyOn(source,'fetchLibrarySnapshot').mockImplementation(async()=>snapshot(0));
  await pollLibrary(db.env,Date.now());expect(fetcher).toHaveBeenCalledTimes(1);expect(count('library_watches')).toBe(2);expect(count('jobs')).toBe(0);
  expect(db.sqlite.prepare("SELECT * FROM health WHERE id='library'").get()).toMatchObject({last_attempt:iso(),last_success:iso(),error:null});
  tick();fetcher.mockResolvedValue(snapshot(3));await pollLibrary(db.env,Date.now());
  expect(fetcher).toHaveBeenCalledTimes(2);expect(count('deliveries')).toBe(2);expect(count('jobs')).toBe(2);expect(db.env.JOBS.send).toHaveBeenCalledTimes(2);
 });
 it('preserves last-good watches and success timestamps on collection failure, without per-poll jobs',async()=>{
  configure();const fetcher=vi.spyOn(source,'fetchLibrarySnapshot').mockResolvedValue(snapshot(0));
  await pollLibrary(db.env,Date.now());const before=watch(),success=iso();tick();fetcher.mockRejectedValue(new Error('private upstream body'));
  await pollLibrary(db.env,Date.now());
  expect(watch()).toEqual(before);expect(count('jobs')).toBe(0);
  expect(db.sqlite.prepare("SELECT * FROM health WHERE id='library'").get()).toMatchObject({last_attempt:iso(),last_success:success,error:'Library collection failed; last-good observation preserved'});
 });
 it('recovers from a prolonged collection failure with a silent baseline',async()=>{
  configure();const fetcher=vi.spyOn(source,'fetchLibrarySnapshot').mockResolvedValue(snapshot(0));
  await pollLibrary(db.env,Date.now());tick();fetcher.mockRejectedValue(new Error('offline'));await pollLibrary(db.env,Date.now());
  tick(120_000);fetcher.mockResolvedValue(snapshot(1));await pollLibrary(db.env,Date.now());
  expect(watch()).toMatchObject({remaining:1,event_id:null});expect(count('deliveries')).toBe(0);
  expect(db.sqlite.prepare("SELECT error FROM health WHERE id='library'").get()!.error).toBeNull();
 });
 it('retains a committed opening intent if Queue dispatch fails, allowing later durable dispatch',async()=>{
  configure();const fetcher=vi.spyOn(source,'fetchLibrarySnapshot').mockResolvedValue(snapshot(0));
  await pollLibrary(db.env,Date.now());tick();fetcher.mockResolvedValue(snapshot(1));
  vi.mocked(db.env.JOBS.send).mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(pollLibrary(db.env,Date.now())).rejects.toThrow('queue unavailable');
  expect(count('deliveries')).toBe(1);expect(count('jobs')).toBe(1);
  expect(deliveries()[0].state).toBe('pending');
  expect(db.sqlite.prepare("SELECT error FROM health WHERE id='library'").get()!.error).toBeNull();
 });
 it('routes the library Cron independently without planning ordinary work',async()=>{
  const fetcher=vi.spyOn(source,'fetchLibrarySnapshot');
  await worker.scheduled({cron:LIBRARY_CRON,scheduledTime:Date.now()} as ScheduledController,db.env);
  expect(fetcher).not.toHaveBeenCalled();expect(count('jobs')).toBe(0);
  expect(db.sqlite.prepare("SELECT * FROM health WHERE id='cron'").get()).toBeUndefined();
 });
 it('ignores retired library Cron ticks during trigger propagation',async()=>{
  configure();const fetcher=vi.spyOn(source,'fetchLibrarySnapshot');
  await worker.scheduled({cron:'* 0-11 * * *',scheduledTime:Date.now()} as ScheduledController,db.env);
  expect(fetcher).not.toHaveBeenCalled();expect(count('jobs')).toBe(0);
  expect(db.sqlite.prepare('SELECT * FROM health').all()).toEqual([]);
 });
 it('preserves ordinary quarter-hour planning and does not fetch library data on that event',async()=>{
  configure();db.env.NOTICE_COLLECTION_MODE='external';const fetcher=vi.spyOn(source,'fetchLibrarySnapshot');
  vi.spyOn(console,'info').mockImplementation(()=>{});
  await worker.scheduled({cron:'*/15 * * * *',scheduledTime:Date.now()} as ScheduledController,db.env);
  expect(fetcher).not.toHaveBeenCalled();
  expect(db.sqlite.prepare("SELECT kind FROM jobs ORDER BY kind").all().map(row=>row.kind)).toEqual(['meal-discover']);
  expect(db.sqlite.prepare("SELECT * FROM health WHERE id='cron'").get()).toMatchObject({last_attempt:iso(),last_success:iso(),error:null});
 });
});

describe('library channel setup integration',()=>{
 it('defines a channel option restricted to text and announcement channels',()=>{
  const setup=COMMANDS.find(command=>command.name==='setup')!;
  expect(setup.options).toContainEqual(expect.objectContaining({name:'library',type:7,channel_types:[0,5]}));
 });
 it.each([false,true])('validates ownership before configuring the library channel (foreign: %s)',async foreign=>{
  db.env.DISCORD_TOKEN='fixture';
  db.sqlite.exec("INSERT INTO guilds(id,notices_channel,meals_channel,schedule_channel,engineering_channel,updated_at) VALUES('111','100','200','300','400','before')");
  const api=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   const url=String(input);
   if(init?.method==='PATCH')return Response.json({});
   if(url.includes('/channels/'))return Response.json({guild_id:foreign?'222':'111',type:0,permission_overwrites:[]});
   if(url.endsWith('/users/@me'))return Response.json({id:'999'});
   if(url.endsWith('/guilds/111/members/999'))return Response.json({roles:[]});
   if(url.endsWith('/guilds/111/roles'))return Response.json([{id:'111',permissions:'3072'}]);
   throw new Error('Unexpected fixture endpoint');
  });
  await completeInteraction(db.env,{payload:JSON.stringify({expires:Date.now()+60_000,interaction:{id:'123',application_id:'777',token:'fixture-interaction',guild_id:'111',member:{permissions:'32'},data:{name:'setup',options:[{name:'library',value:channel}]}}})} as Job);
  expect(db.sqlite.prepare("SELECT * FROM guilds WHERE id='111'").get()).toMatchObject({library_channel:foreign?null:channel,notices_channel:'100',meals_channel:'200',schedule_channel:'300',engineering_channel:'400'});
  expect(count('deliveries')).toBe(0);expect(count('library_watches')).toBe(0);
  const patch=api.mock.calls.find(([,init])=>init?.method==='PATCH')!;
  expect(JSON.parse(patch[1]!.body as string)).toMatchObject({allowed_mentions:{parse:[]}});
  if(foreign)expect(JSON.parse(patch[1]!.body as string).content).toContain('이 서버에 속한 채널');
 });
});
