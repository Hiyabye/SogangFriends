import {afterEach,describe,expect,it,vi} from 'vitest';
import {batchNoticeCards,noticeCardMessage} from '../src/notice-card';
import {batchNotices,message,type DiscordCardComponent} from '../src/discord';
import {SOURCES} from '../src/sources';
import {noticeDetailUrl} from '../src/legacy-notice-sources';
import {consume,executeJob} from '../src/jobs';
import {deliveryIntent} from '../src/storage';
import {testDatabase} from './helpers/db';
import type {Job,Notice} from '../src/types';
const notice=(source='university',id='1',title='학생 대상 공지'):Notice=>({source,id,title,published:'2026-10-13',url:noticeDetailUrl(SOURCES.find(s=>s.id===source)!,id)});
const alert=(notices:Notice[],created='2026-10-13T00:00:00.000Z'):Job=>({id:'notice-alert:fixture',kind:'notice-alert',payload:JSON.stringify({notices}),created_at:created,available_at:created,state:'running',attempts:1,lease_until:null,error:null});
const text=(components:DiscordCardComponent[])=>components.flatMap(c=>c.type===17?c.components.filter(c=>c.type===10).map(c=>c.content):[]).join('\n');
const batch=(id:string)=>({messages:[{body:{id},ack:vi.fn()}],queue:'fixture'} as never);
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('automatic notice Components V2 cards',()=>{
 it('groups source-colored cards and shows escaped titles, publication dates and intact official links',()=>{
  const notices=[notice('university','1','*강조* [link](evil)\n<@123>'),notice('career','2'),notice('university','3')];
  const cards=batchNoticeCards(notices);expect(cards).toHaveLength(1);const body=message(noticeCardMessage(cards[0].noticeCard));
  expect(body).toMatchObject({flags:32768,allowed_mentions:{parse:[]}});expect(body).not.toHaveProperty('content');expect(body).not.toHaveProperty('embeds');
  expect(body.components).toHaveLength(2);expect(body.components![0]).toMatchObject({type:17,accent_color:0xed4245});expect(body.components![1]).toMatchObject({type:17,accent_color:0xfee75c});
  const displayed=text(body.components!);expect(displayed).toContain('### 서강대학교 학사공지');expect(displayed).toContain('게시일 2026-10-13');expect(displayed).toContain('\\*강조\\* \\[link\\](evil) \\<@123\\>');
  for(const n of notices)expect(displayed).toContain(`[공식 원문](<${n.url}>)`);
 });
 it('preserves legacy batch boundaries, all URLs and Discord limits for all boards and hostile long titles',()=>{
  const notices=Array.from({length:100},(_,i)=>notice(SOURCES[i%SOURCES.length].id,String(i+1),i%3===0?'👩‍💻*[]\\'.repeat(100):'공지 '+i));
  const named=notices.map(n=>({...n,source:SOURCES.find(s=>s.id===n.source)!.name}));const cards=batchNoticeCards(notices);
  expect(cards.map(c=>c.content)).toEqual(batchNotices(named));
  const combined=cards.map(card=>{const components=message(noticeCardMessage(card.noticeCard)).components!;expect(components.length*2).toBeLessThanOrEqual(40);const content=text(components);expect(content.length).toBeLessThanOrEqual(4000);expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);return content;}).join('\n');
  for(const n of notices)expect(combined.split(`[공식 원문](<${n.url}>)`)).toHaveLength(2);
  expect(batchNoticeCards([])).toEqual([]);
 });
 it('fails clearly for invalid or over-limit persisted display formats',()=>{
  const card=batchNoticeCards([notice()])[0].noticeCard;
  expect(()=>noticeCardMessage({...card,version:2} as never)).toThrow('Invalid');
  expect(()=>noticeCardMessage({version:1,components:[{type:17,accent_color:0,components:[{type:10,content:'a'.repeat(4001)}]}]})).toThrow('limits');
  expect(()=>noticeCardMessage({version:1,components:Array.from({length:21},()=>({type:17 as const,accent_color:0,components:[{type:10 as const,content:'a'}]}))})).toThrow('limits');
 });
 it('persists new layout atomically with the ordinary intent and sends it once through the real delivery consumer',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture-only';db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','1001','fixture'),('333','3003','fixture')").run();
   const fetch=vi.fn().mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));vi.stubGlobal('fetch',fetch);
   const job=alert([notice(),notice('sweduNotice','2')]);await executeJob(db.env,job);await executeJob(db.env,job);
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(1);const id='notice-alert:fixture:111:0';
   expect(db.sqlite.prepare('SELECT expires_at FROM deliveries WHERE id=?').get(id)!.expires_at).toBe('2026-10-14T00:00:00.000Z');
   const saved=db.sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get('send:'+id)!.payload as string;expect(JSON.parse(saved)).toMatchObject({deliveryId:id,noticeCard:{version:1}});
   await consume(db.env,batch('send:'+id));await consume(db.env,batch('send:'+id));expect(fetch).toHaveBeenCalledTimes(1);
   const payload=JSON.parse(fetch.mock.calls[0][1].body);expect(payload.flags).toBe(32768);expect(payload.allowed_mentions).toEqual({parse:[]});expect(payload).not.toHaveProperty('content');expect(payload).not.toHaveProperty('embeds');expect(text(payload.components)).toContain('SW중심대학사업단 공지사항');
   expect(db.sqlite.prepare('SELECT state,message_id FROM deliveries WHERE id=?').get(id)).toMatchObject({state:'sent',message_id:'9001'});
  }finally{db.close();}
 });
 it('rolls back the delivery when its persisted card job cannot be inserted',async()=>{
  const db=testDatabase();try{
   db.sqlite.exec("CREATE TRIGGER reject_card_job BEFORE INSERT ON jobs WHEN NEW.kind='deliver' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;");
   await expect(deliveryIntent(db.env,'rollback','111','1001','fallback',undefined,undefined,undefined,batchNoticeCards([notice()])[0].noticeCard)).rejects.toThrow('fixture rejection');
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(0);expect(db.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('leaves pre-existing text deliveries/payloads untouched when the same alert intent is encountered',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture-only';db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','1001','fixture')").run();const id='notice-alert:fixture:111:0';await deliveryIntent(db.env,id,'111','1001','legacy text');
   const before=db.sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get('send:'+id)!.payload;
   await executeJob(db.env,alert([notice()]));expect(db.sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get('send:'+id)!.payload).toBe(before);
   const fetch=vi.fn().mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));vi.stubGlobal('fetch',fetch);await consume(db.env,batch('send:'+id));
   expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({content:'legacy text',allowed_mentions:{parse:[]}});
  }finally{db.close();}
 });
 it('freezes uncertain card POSTs and expires stale alerts/intents without a send',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture-only';db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','1001','fixture')").run();const fetch=vi.fn().mockRejectedValue(new Error('network interrupted'));vi.stubGlobal('fetch',fetch);
   await executeJob(db.env,alert([notice()]));const id='notice-alert:fixture:111:0';await consume(db.env,batch('send:'+id));
   expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(id)!.state).toBe('uncertain');await executeJob(db.env,alert([notice()]));await consume(db.env,batch('send:'+id));expect(fetch).toHaveBeenCalledTimes(1);
   vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));await executeJob(db.env,{...alert([notice()]),id:'stale'});expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(1);
   await deliveryIntent(db.env,'expired','111','1001','fallback','2026-10-14T00:00:00Z',undefined,undefined,batchNoticeCards([notice()])[0].noticeCard);await consume(db.env,batch('send:expired'));expect(fetch).toHaveBeenCalledTimes(1);expect(db.sqlite.prepare("SELECT state FROM deliveries WHERE id='expired'").get()!.state).toBe('expired');
  }finally{db.close();}
 });
});
