import {afterEach,describe,expect,it,vi} from 'vitest';
import {NOTICE_GROUPS,NOTICE_CHANNEL_COLUMNS,noticeChannelColumn} from '../src/notice-channels';
import {SOURCES} from '../src/sources';
import {noticeDetailUrl} from '../src/legacy-notice-sources';
import {executeJob} from '../src/jobs';
import {batchNoticeCards} from '../src/notice-card';
import {deliveryIntent} from '../src/storage';
import {testDatabase} from './helpers/db';
import type {Job,Notice} from '../src/types';
const notices:Notice[]=SOURCES.map((source,index)=>({source:source.id,id:String(index+1),title:source.name,published:'2026-10-13',url:noticeDetailUrl(source,String(index+1))}));
const job:Job={id:'notice-alert:routing',kind:'notice-alert',payload:JSON.stringify({notices}),created_at:'2026-10-13T00:00:00.000Z',available_at:'2026-10-13T00:00:00.000Z',state:'running',attempts:1,lease_until:null,error:null};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('institution notice routing',()=>{
 it('assigns every catalog source to exactly one institution',()=>{
  const mapped=NOTICE_GROUPS.flatMap(group=>[...group.sources]);
  expect(new Set(mapped).size).toBe(mapped.length);expect([...mapped].sort()).toEqual(SOURCES.map(source=>source.id).sort());
  for(const group of NOTICE_GROUPS)for(const source of group.sources)expect(noticeChannelColumn(source)).toBe(NOTICE_CHANNEL_COLUMNS[group.id]);
  expect(noticeChannelColumn('unexpected')).toBeUndefined();
 });
 it('groups both Bellarmino boards under one dedicated destination',()=>{
  expect(NOTICE_GROUPS.find(group=>group.id==='dormitory')).toEqual({id:'dormitory',name:'벨라르미노 학사',sources:['dormitoryNotice','dormitoryAdmission']});
  for(const source of ['dormitoryNotice','dormitoryAdmission'])expect(noticeChannelColumn(source)).toBe('dormitory_channel');
 });
 it('routes all catalog sources exclusively to their group, including a guild without fallback',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,university_channel,computing_channel,swedu_channel,convedu_channel,bdata_channel,engineering_channel,psychology_channel,business_channel,dormitory_channel,updated_at) VALUES('111','999','101','102','103','104','105','106','107','108','109','fixture'),('333','999','101','102','103','104','105','106','107','108','109','fixture')").run();
   db.sqlite.prepare("UPDATE guilds SET notices_channel=NULL WHERE id='111'").run();
   await executeJob(db.env,job);await executeJob(db.env,job);
   const deliveries=db.sqlite.prepare('SELECT channel_id,content FROM deliveries ORDER BY channel_id').all();expect(deliveries).toHaveLength(NOTICE_GROUPS.length);
   for(const [index,group] of NOTICE_GROUPS.entries()){
    const delivery=deliveries[index];expect(delivery.channel_id).toBe(String(101+index));
    for(const notice of notices)expect(String(delivery.content).includes(notice.url)).toBe((group.sources as readonly string[]).includes(notice.source));
   }
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()!.n).toBe(NOTICE_GROUPS.length);
  }finally{db.close();}
 });
 it('uses the fallback only for unconfigured groups and merges groups sharing a destination',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,computing_channel,swedu_channel,updated_at) VALUES('111','999','102','102','fixture')").run();
   await executeJob(db.env,job);
   const deliveries=db.sqlite.prepare('SELECT channel_id,content FROM deliveries').all();expect(deliveries).toHaveLength(2);
   for(const notice of notices){const target=['academicNotice','graduateNotice','externalInfo','news','career','sweduNotice','sweduNews','sweduPress'].includes(notice.source)?'102':'999';
    expect(deliveries.filter(row=>String(row.content).includes(notice.url)).map(row=>row.channel_id)).toEqual([target]);
   }
  }finally{db.close();}
 });
 it('preserves ordinary delivery IDs and freezes the whole plan after channel changes, even with uncertain sends',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','999','fixture')").run();
   await executeJob(db.env,job);
   expect(db.sqlite.prepare('SELECT id FROM deliveries ORDER BY id').all()).toEqual(batchNoticeCards(notices).map((_,index)=>({id:`notice-alert:routing:111:${index}`})));
   db.sqlite.prepare("UPDATE deliveries SET state='uncertain'").run();
   const before=db.sqlite.prepare('SELECT * FROM deliveries').all();const jobs=db.sqlite.prepare('SELECT * FROM jobs').all();
   db.sqlite.prepare("UPDATE guilds SET university_channel='101',computing_channel='102',swedu_channel='103',convedu_channel='104',bdata_channel='105',engineering_channel='106',psychology_channel='107',business_channel='108',dormitory_channel='109'").run();
   await executeJob(db.env,job);
   expect(db.sqlite.prepare('SELECT * FROM deliveries').all()).toEqual(before);expect(db.sqlite.prepare('SELECT * FROM jobs').all()).toEqual(jobs);
  }finally{db.close();}
 });
 it('flags a partially committed legacy multi-chunk alert for review without replaying existing sends',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   const many=Array.from({length:20},(_,index)=>({...notices[0],id:String(index+1),title:'공지'.repeat(100),url:noticeDetailUrl(SOURCES[0],String(index+1))}));
   const chunks=batchNoticeCards(many);expect(chunks.length).toBeGreaterThan(1);
   db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,university_channel,updated_at) VALUES('111','999','101','fixture')").run();
   db.sqlite.prepare("INSERT INTO jobs(id,kind,payload,created_at,available_at,state) VALUES(?,'notice-alert',?,?,?,'running')").run(job.id,JSON.stringify({notices:many}),job.created_at,job.available_at);
   await deliveryIntent(db.env,`${job.id}:111:0`,'111','999',chunks[0].content);
   db.sqlite.prepare("UPDATE deliveries SET state='uncertain'").run();const before=db.sqlite.prepare('SELECT * FROM deliveries').all();
   await executeJob(db.env,{...job,payload:JSON.stringify({notices:many})});
   expect(db.sqlite.prepare('SELECT state,error FROM jobs WHERE id=?').get(job.id)).toMatchObject({state:'needs_review',error:'Incomplete existing notice delivery plan; operator review required'});
   expect(db.sqlite.prepare('SELECT * FROM deliveries').all()).toEqual(before);
  }finally{db.close();}
 });
 it('recognizes an atomic group-only plan when unconfigured notices span more chunks',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   const computing=notices.find(notice=>notice.source==='academicNotice')!;
   const many=[notices[0],...Array.from({length:20},(_,index)=>({...computing,id:String(index+100),title:'공지'.repeat(100),url:noticeDetailUrl(SOURCES.find(source=>source.id==='academicNotice')!,String(index+100))}))];
   expect(batchNoticeCards(many).length).toBeGreaterThan(1);
   const mixed={...job,payload:JSON.stringify({notices:many})};
   db.sqlite.prepare("INSERT INTO guilds(id,university_channel,updated_at) VALUES('111','101','fixture')").run();
   db.sqlite.prepare("INSERT INTO jobs(id,kind,payload,created_at,available_at,state) VALUES(?,'notice-alert',?,?,?,'running')").run(job.id,mixed.payload,job.created_at,job.available_at);
   await executeJob(db.env,mixed);
   const before=db.sqlite.prepare('SELECT * FROM deliveries').all();expect(before).toHaveLength(1);
   const payload=db.sqlite.prepare("SELECT payload FROM jobs WHERE kind='deliver'").get()!.payload as string;expect(JSON.parse(payload).noticePlanVersion).toBe(1);
   // Neither unconfigured groups nor a later setup change may reinterpret the committed plan.
   db.sqlite.prepare("UPDATE guilds SET computing_channel='102'").run();
   await executeJob(db.env,mixed);
   expect(db.sqlite.prepare('SELECT * FROM deliveries').all()).toEqual(before);
   expect(db.sqlite.prepare('SELECT state,error FROM jobs WHERE id=?').get(job.id)).toMatchObject({state:'running',error:null});
  }finally{db.close();}
 });
 it('rolls back all destinations on failure and can safely retry the uncommitted plan',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.sqlite.prepare("INSERT INTO guilds(id,notices_channel,computing_channel,updated_at) VALUES('111','999','102','fixture')").run();
   db.sqlite.exec("CREATE TRIGGER reject_destination BEFORE INSERT ON deliveries WHEN NEW.channel_id='102' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
   await expect(executeJob(db.env,job)).rejects.toThrow('fixture failure');
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(0);expect(db.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()!.n).toBe(0);
   db.sqlite.exec('DROP TRIGGER reject_destination');await executeJob(db.env,job);
   const computing=notices.filter(n=>noticeChannelColumn(n.source)==='computing_channel');
   const fallback=notices.filter(n=>noticeChannelColumn(n.source)!=='computing_channel');
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(batchNoticeCards(computing).length+batchNoticeCards(fallback).length);
  }finally{db.close();}
 });
 it('skips unconfigured groups and expired alerts without creating delivery jobs',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));const db=testDatabase();try{
   db.sqlite.prepare("INSERT INTO guilds(id,university_channel,updated_at) VALUES('111','101','fixture')").run();
   await executeJob(db.env,job);expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(1);
   vi.setSystemTime(new Date('2026-10-15T01:00:00Z'));await executeJob(db.env,{...job,id:'expired'});expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(1);
  }finally{db.close();}
 });
});
