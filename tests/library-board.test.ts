import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {closeLibraryBoards,sendLibraryOpening,updateLibraryBoard} from '../src/library-board';
import {pollLibrary,saveLibrarySnapshot} from '../src/library';
import * as source from '../src/library-source';
import * as discord from '../src/discord';
import {executeJob} from '../src/jobs';
import type {Job} from '../src/types';

let db:ReturnType<typeof testDatabase>;
const guild='111',channel='9001';
const iso=()=>new Date().toISOString();
const state=()=>db.sqlite.prepare('SELECT * FROM library_board_state WHERE guild_id=? AND channel_id=?').get(guild,channel)!;
const track=()=>db.sqlite.prepare('SELECT * FROM library_messages WHERE guild_id=? AND channel_id=?').get(guild,channel);
const snapshot=(remaining:number):source.LibrarySnapshot=>({remaining,total:96,used:96-remaining,sourceAt:iso()});
async function observe(remaining:number,advance=0){vi.advanceTimersByTime(advance);await saveLibrarySnapshot(db.env,snapshot(remaining));}
function tracked(id='100'){db.sqlite.prepare('INSERT OR REPLACE INTO library_messages(guild_id,channel_id,message_id,updated_at) VALUES(?,?,?,?)').run(guild,channel,id,iso());}
const api=()=>vi.mocked(fetch);
const body=(index=0)=>JSON.parse(String(api().mock.calls[index][1]!.body));
const cardText=(index=0)=>body(index).components[0].components[0].content as string;
const sent=(id='200')=>Response.json({id,channel_id:channel});
const methods=()=>api().mock.calls.map(call=>call[1]!.method);
const count=(table:string)=>Number(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
async function opening(){await observe(0);await observe(1,60_000);return String(db.sqlite.prepare('SELECT event_id FROM library_watches WHERE guild_id=?').get(guild)!.event_id);}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T01:00:00Z'));db=testDatabase();db.env.DISCORD_TOKEN='fixture';
 db.sqlite.prepare('INSERT INTO guilds(id,library_channel,updated_at) VALUES(?,?,?)').run(guild,channel,iso());
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Unexpected external request')));
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('library live status projections',()=>{
 it('creates one silent bootstrap and no minute job rows',async()=>{
  const send=vi.spyOn(discord,'discordSend');await observe(3);api().mockResolvedValue(sent());
  await updateLibraryBoard(db.env,guild,channel);await updateLibraryBoard(db.env,guild,channel);
  expect(send).toHaveBeenCalledExactlyOnceWith(db.env,channel,expect.objectContaining({suppressNotifications:true}));
  expect(body()).toMatchObject({flags:32768|4096,allowed_mentions:{parse:[]}});expect(cardText()).toContain('잔여 3석');expect(body()).not.toHaveProperty('content');
  expect(track()!.message_id).toBe('200');expect(count('jobs')).toBe(0);expect(count('deliveries')).toBe(1);
  expect(state()).toMatchObject({lease_owner:null,post_state:null,error:null});
 });
 it('edits all nonopening observations including same-count timestamps without POSTs or history rows',async()=>{
  tracked();api().mockResolvedValue(new Response('{}'));await observe(3);
  for(const value of [3,3,2,0,0]){await observe(value,30_000);await updateLibraryBoard(db.env,guild,channel);}
  expect(methods()).toEqual(['PATCH','PATCH','PATCH','PATCH','PATCH']);expect(cardText(4)).toContain('잔여 0석');
  expect(cardText(0)).not.toBe(cardText(1));expect(body(4)).toMatchObject({flags:32768,content:null,allowed_mentions:{parse:[]},embeds:[],attachments:[]});
  expect(count('jobs')).toBe(0);expect(count('deliveries')).toBe(0);
 });
 it('uses the latest persisted watch rather than a caller-captured snapshot',async()=>{
  tracked();await observe(3);await observe(5,30_000);api().mockResolvedValue(new Response('{}'));
  await updateLibraryBoard(db.env,guild,channel);expect(cardText()).toContain('잔여 5석');
 });
 it('does not bootstrap over a pending opening and renders the latest count in its normal POST',async()=>{
  const event=await opening();await observe(4,30_000);
  await updateLibraryBoard(db.env,guild,channel);expect(fetch).not.toHaveBeenCalled();
  const send=vi.spyOn(discord,'discordSend');api().mockResolvedValue(sent());await sendLibraryOpening(db.env,event,event);
  expect(methods()).toEqual(['POST']);expect(cardText()).toContain('잔여 4석');expect(body().flags).toBe(32768);
  expect(send).toHaveBeenCalledWith(db.env,channel,expect.objectContaining({suppressNotifications:false}));
  expect(count('deliveries')).toBe(1);expect(track()!.message_id).toBe('200');
 });
 it('replaces on an opening while cleanup remains a separate durable job',async()=>{
  tracked();const event=await opening();api().mockResolvedValue(sent());await sendLibraryOpening(db.env,event,event);
  const job=db.sqlite.prepare("SELECT * FROM jobs WHERE kind='library-cleanup'").get()!;
  expect(JSON.parse(String(job.payload))).toEqual({guild,channel,messageId:'100',replacementId:'200'});
  expect(methods()).toEqual(['POST']);expect(track()!.message_id).toBe('200');
  await sendLibraryOpening(db.env,event,event);expect(fetch).toHaveBeenCalledOnce();
 });
 it.each([
  ['writer acquisition',"UPDATE library_board_state SET lease_owner="],
  ['final ownership preflight','SELECT guild_id FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=? AND lease_until>?']
 ])('expires the original opening intent when %s crosses its TTL despite a fresh positive watch',async(_phase,sql)=>{
  const event=await opening();
  const expires=String(db.sqlite.prepare('SELECT expires_at FROM deliveries WHERE id=?').get(event)!.expires_at);
  await observe(4,60_000);vi.setSystemTime(Date.parse(expires)-1);
  const prototype=Object.getPrototypeOf(db.env.DB.prepare('SELECT 1'));
  const first=prototype.first;
  vi.spyOn(prototype,'first').mockImplementation(async function(this:{sql:string},...args:unknown[]){
   const result=await first.apply(this,args);
   if(this.sql.startsWith(sql))vi.setSystemTime(Date.parse(expires)+1);
   return result;
  });
  await sendLibraryOpening(db.env,event,event);
  expect(fetch).not.toHaveBeenCalled();
  expect(db.sqlite.prepare('SELECT state,expires_at FROM deliveries WHERE id=?').get(event)).toMatchObject({state:'expired',expires_at:expires});
  expect(state()).toMatchObject({lease_owner:null,lease_until:null,operation:null,post_state:null});
 });
 it.each([
  ['2026-10-16T01:00:00Z',119_000,'2026-10-16T01:02:00.000Z'],
  ['2026-10-16T12:59:00Z',30_000,'2026-10-16T13:00:00.000Z']
 ])('bounds bootstrap expiry by source freshness and closing time from %s',async(time,wait,expires)=>{
  vi.setSystemTime(new Date(time));await observe(3);vi.advanceTimersByTime(wait);api().mockResolvedValue(sent());
  await updateLibraryBoard(db.env,guild,channel);
  expect(db.sqlite.prepare('SELECT expires_at,state FROM deliveries').get()).toMatchObject({expires_at:expires,state:'sent'});
 });
 it('does not start a bootstrap POST if its source-bound expiry passes during final preflight',async()=>{
  await observe(3);vi.advanceTimersByTime(119_999);
  const prototype=Object.getPrototypeOf(db.env.DB.prepare('SELECT 1'));
  const first=prototype.first;let ownershipReads=0;
  vi.spyOn(prototype,'first').mockImplementation(async function(this:{sql:string},...args:unknown[]){
   const result=await first.apply(this,args);
   if(this.sql.startsWith('SELECT guild_id FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=? AND lease_until>?')&&++ownershipReads===2)vi.advanceTimersByTime(2);
   return result;
  });
  await updateLibraryBoard(db.env,guild,channel);
  expect(fetch).not.toHaveBeenCalled();expect(db.sqlite.prepare('SELECT state FROM deliveries').get()!.state).toBe('expired');
  expect(state()).toMatchObject({lease_owner:null,post_state:null});
 });
 it('ignores stale/day/route/disabled observations rather than displaying stale data as current',async()=>{
  tracked();await observe(3);vi.advanceTimersByTime(120_001);await updateLibraryBoard(db.env,guild,channel);expect(fetch).not.toHaveBeenCalled();
  await observe(4);db.env.ALLOWED_GUILDS='222';await updateLibraryBoard(db.env,guild,channel);expect(fetch).not.toHaveBeenCalled();
 });
});

describe('library board arbitration and failures',()=>{
 it('serializes concurrent bootstrap writers',async()=>{
  await observe(3);api().mockResolvedValue(sent());await Promise.all([updateLibraryBoard(db.env,guild,channel),updateLibraryBoard(db.env,guild,channel)]);
  expect(methods()).toEqual(['POST']);expect(count('deliveries')).toBe(1);
 });
 it('does not issue an opening POST while a PATCH owns the route',async()=>{
  tracked();const event=await opening();let finish!:(r:Response)=>void;
  api().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  const edit=updateLibraryBoard(db.env,guild,channel);
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
  await expect(sendLibraryOpening(db.env,event,event)).rejects.toMatchObject({retryAfter:60});
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('pending');
  finish(new Response('{}'));await edit;
  api().mockResolvedValueOnce(sent());await sendLibraryOpening(db.env,event,event);expect(methods()).toEqual(['PATCH','POST']);
 });
 it.each([503,408])('quarantines unknown bootstrap POST HTTP%s across later observations',async status=>{
  await observe(3);api().mockResolvedValue(new Response(null,{status}));await updateLibraryBoard(db.env,guild,channel);
  await observe(4,60_000);await updateLibraryBoard(db.env,guild,channel);expect(fetch).toHaveBeenCalledOnce();
  expect(state().post_state).toBe('uncertain');expect(track()).toBeUndefined();
 });
 it('quarantines a malformed successful POST',async()=>{
  await observe(3);api().mockResolvedValue(Response.json({id:'bad'}));await updateLibraryBoard(db.env,guild,channel);
  expect(state().post_state).toBe('uncertain');await observe(4,60_000);await updateLibraryBoard(db.env,guild,channel);expect(fetch).toHaveBeenCalledOnce();
 });
 it('quarantines network-interrupted bootstrap POSTs and cannot recreate on later polls',async()=>{
  await observe(3);await updateLibraryBoard(db.env,guild,channel);
  expect(state().post_state).toBe('uncertain');await observe(4,60_000);await updateLibraryBoard(db.env,guild,channel);
  expect(methods()).toEqual(['POST']);expect(count('deliveries')).toBe(1);
 });
 it('preserves old tracking on POST completion storage failure and allows known-message PATCH but no future POST',async()=>{
  tracked();const event=await opening();db.sqlite.exec("CREATE TRIGGER fail_tracking BEFORE UPDATE ON library_messages BEGIN SELECT RAISE(ABORT,'storage failed'); END");
  api().mockResolvedValueOnce(sent());await expect(sendLibraryOpening(db.env,event,event)).rejects.toThrow('storage failed');
  expect(track()!.message_id).toBe('100');expect(state().post_state).toBe('uncertain');
  db.sqlite.exec('DROP TRIGGER fail_tracking');vi.advanceTimersByTime(60_000);await observe(0);
  api().mockResolvedValueOnce(new Response('{}'));await updateLibraryBoard(db.env,guild,channel);expect(methods()).toEqual(['POST','PATCH']);
  await observe(1,60_000);const next=String(db.sqlite.prepare('SELECT event_id FROM library_watches').get()!.event_id);
  await sendLibraryOpening(db.env,next,next);expect(methods()).toEqual(['POST','PATCH']);
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(next)!.state).toBe('uncertain');
 });
 it('freezes an expired POST lease but recovers a known prior message for PATCH',async()=>{
  tracked();await observe(3);
  db.sqlite.prepare("INSERT INTO library_board_state(guild_id,channel_id,lease_owner,lease_until,operation,post_state,updated_at) VALUES(?,?,'dead',?,'post','creating',?)").run(guild,channel,new Date(Date.now()-1).toISOString(),iso());
  api().mockResolvedValue(new Response('{}'));await updateLibraryBoard(db.env,guild,channel);
  expect(methods()).toEqual(['PATCH']);expect(state()).toMatchObject({post_state:'uncertain',lease_owner:null});
 });
 it('recreates silently only after exact Unknown Message10008',async()=>{
  tracked();await observe(3);api().mockResolvedValueOnce(Response.json({code:10008},{status:404})).mockResolvedValueOnce(sent());
  const send=vi.spyOn(discord,'discordSend');await updateLibraryBoard(db.env,guild,channel);
  expect(methods()).toEqual(['PATCH','POST']);expect(track()!.message_id).toBe('200');expect(count('jobs')).toBe(0);
  expect(send).toHaveBeenCalledWith(db.env,channel,expect.objectContaining({suppressNotifications:true}));
 });
 it.each([10003,'10008',null])('keeps tracking on generic404/code%s without creating a new message',async code=>{
  tracked();await observe(3);api().mockResolvedValue(Response.json({code},{status:404}));
  await expect(updateLibraryBoard(db.env,guild,channel)).rejects.toMatchObject({retryAfter:900});
  expect(methods()).toEqual(['PATCH']);expect(track()!.message_id).toBe('100');
 });
 it('shares PATCH429 cooldown with opening POST and retries the current projection',async()=>{
  tracked();await observe(0);api().mockResolvedValueOnce(Response.json({retry_after:120},{status:429}));
  await expect(updateLibraryBoard(db.env,guild,channel)).rejects.toMatchObject({retryAfter:120});
  await observe(1,60_000);const event=String(db.sqlite.prepare('SELECT event_id FROM library_watches').get()!.event_id);
  await expect(sendLibraryOpening(db.env,event,event)).rejects.toMatchObject({retryAfter:60});expect(fetch).toHaveBeenCalledOnce();
  await observe(4,60_000);api().mockResolvedValueOnce(sent());await sendLibraryOpening(db.env,event,event);
  expect(methods()).toEqual(['PATCH','POST']);expect(cardText(1)).toContain('잔여 4석');
 });
 it('retries known-message network failures without creating a message',async()=>{
  tracked();await observe(3);await expect(updateLibraryBoard(db.env,guild,channel)).rejects.toMatchObject({retryAfter:60});
  await observe(4,60_000);api().mockResolvedValueOnce(new Response('{}'));await updateLibraryBoard(db.env,guild,channel);
  expect(methods()).toEqual(['PATCH','PATCH']);expect(cardText(1)).toContain('잔여 4석');expect(count('deliveries')).toBe(0);
 });
});

describe('library closing and source/display health boundaries',()=>{
 it('upgrades an unchanged legacy closed display in place without a replacement POST',async()=>{
  tracked();await observe(3);const at=iso();
  db.sqlite.prepare('INSERT INTO library_board_state(guild_id,channel_id,display_key,updated_at) VALUES(?,?,?,?)').run(guild,channel,`closed:2026-10-16:${at}`,at);
  vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));api().mockResolvedValue(new Response('{}'));
  await closeLibraryBoards(db.env,Date.now());await closeLibraryBoards(db.env,Date.now());
  expect(methods()).toEqual(['PATCH']);expect(track()!.message_id).toBe('100');expect(count('deliveries')).toBe(0);
  expect(body()).toMatchObject({flags:32768,content:null,embeds:[],attachments:[],allowed_mentions:{parse:[]}});
  expect(body().components[0]).toMatchObject({type:17,accent_color:0x5865f2});
  expect(cardText()).toContain('### 133 로욜라 인벤툼 II 좌석 현황');expect(cardText()).toContain('[공식 좌석 현황](<');
  expect(state().display_key).toBe(`card-v1:closed:2026-10-16:${at}`);
 });
 it('closes at22 without source requests or POSTs and stays idempotent across midnight',async()=>{
  tracked();await observe(3);const fetcher=vi.spyOn(source,'fetchLibrarySnapshot');api().mockResolvedValue(new Response('{}'));
  vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));await closeLibraryBoards(db.env,Date.now());
  expect(cardText()).toContain('좌석 확인 종료');expect(cardText()).toContain('22:00–다음 날 10:00');expect(cardText()).toContain('2026-10-16 10:00:00 KST');
  vi.setSystemTime(new Date('2026-10-16T15:00:00Z'));await closeLibraryBoards(db.env,Date.now());
  expect(methods()).toEqual(['PATCH']);expect(fetcher).not.toHaveBeenCalled();expect(count('jobs')).toBe(0);
 });
 it.each([
  ['2026-10-16T12:59:59.999Z','2026-10-16T13:00:00.000Z'],
  ['2026-10-17T00:59:59.999Z','2026-10-17T01:00:00.000Z']
 ])('does not PATCH the old operating phase when preflight crosses from %s',async(before,after)=>{
  tracked();vi.setSystemTime(new Date('2026-10-16T12:59:00Z'));await observe(3);vi.setSystemTime(new Date(before));
  const prototype=Object.getPrototypeOf(db.env.DB.prepare('SELECT 1')),first=prototype.first;
  vi.spyOn(prototype,'first').mockImplementation(async function(this:{sql:string},...args:unknown[]){
   const result=await first.apply(this,args);
   if(this.sql.startsWith('SELECT guild_id FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=? AND lease_until>?'))vi.setSystemTime(new Date(after));
   return result;
  });
  await updateLibraryBoard(db.env,guild,channel);expect(fetch).not.toHaveBeenCalled();expect(state().lease_owner).toBeNull();
 });
 it('expires a pending opening after22 rather than sending a late alert',async()=>{
  vi.setSystemTime(new Date('2026-10-16T12:58:00Z'));const event=await opening();
  vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));await sendLibraryOpening(db.env,event,event);
  expect(fetch).not.toHaveBeenCalled();expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(event)!.state).toBe('expired');
 });
 it('does not create a closing message when no confirmed tracking exists',async()=>{
  vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));await closeLibraryBoards(db.env,Date.now());expect(fetch).not.toHaveBeenCalled();expect(count('deliveries')).toBe(0);
 });
 it('retries a failed close on the next quarter-hour and resumes next-day10 with no opening alert',async()=>{
  tracked();await observe(0);vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));
  await closeLibraryBoards(db.env,Date.now());expect(state().error).toBeTruthy();
  vi.advanceTimersByTime(15*60_000);api().mockResolvedValue(new Response('{}'));await closeLibraryBoards(db.env,Date.now());
  vi.setSystemTime(new Date('2026-10-17T01:00:00Z'));await observe(4);await updateLibraryBoard(db.env,guild,channel);
  expect(methods()).toEqual(['PATCH','PATCH','PATCH']);expect(cardText(2)).not.toContain('좌석 확인 종료');expect(count('deliveries')).toBe(0);
 });
 it('keeps source success when display fails and still edits before rejected Queue dispatch',async()=>{
  tracked();const fetcher=vi.spyOn(source,'fetchLibrarySnapshot').mockImplementation(async()=>snapshot(0));
  await pollLibrary(db.env,Date.now());expect(db.sqlite.prepare("SELECT error FROM health WHERE id='library'").get()!.error).toBeNull();
  expect(db.sqlite.prepare("SELECT error FROM health WHERE id='library-board'").get()!.error).toBeTruthy();
  vi.advanceTimersByTime(60_000);fetcher.mockImplementation(async()=>snapshot(1));api().mockResolvedValue(new Response('{}'));
  vi.mocked(db.env.JOBS.send).mockRejectedValueOnce(new Error('quota exhausted'));
  await expect(pollLibrary(db.env,Date.now())).rejects.toThrow('quota exhausted');expect(methods()).toEqual(['PATCH','PATCH']);
  expect(db.sqlite.prepare("SELECT error FROM health WHERE id='library'").get()!.error).toBeNull();
 });
 it('does not advance display timestamp after a failed source fetch',async()=>{
  tracked();const fetcher=vi.spyOn(source,'fetchLibrarySnapshot').mockImplementation(async()=>snapshot(3));api().mockResolvedValue(new Response('{}'));
  await pollLibrary(db.env,Date.now());const before=state().display_key;
  vi.advanceTimersByTime(60_000);fetcher.mockRejectedValueOnce(new Error('offline'));await pollLibrary(db.env,Date.now());
  expect(fetch).toHaveBeenCalledOnce();expect(state().display_key).toBe(before);
 });
 it('integrates new opening writer with existing job execution',async()=>{
  const event=await opening();api().mockResolvedValue(sent());const job=db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(`send:${event}`) as unknown as Job;
  await executeJob(db.env,job);expect(track()!.message_id).toBe('200');expect(state().lease_owner).toBeNull();
 });
});
