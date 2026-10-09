import {describe,it,expect,vi,afterEach} from 'vitest';
import {handleRequest} from '../src/worker';
import {consume,planCron} from '../src/jobs';
import {validateNoticeSnapshot} from '../src/notice-ingest';
import {SOURCES} from '../src/sources';
import {testDatabase} from './helpers/db';
import {signedSnapshot} from '../scripts/notice-collector.mjs';
const secret='fixture-collector-secret-'.repeat(3);
const notice=(source='university',id='1')=>({id,source,title:'공식 공지',published:'2026-10-09',url:source==='university'?`https://www.sogang.ac.kr/ko/detail/${id}?bbsConfigFk=2`:`https://computing.sogang.ac.kr/ko/community/${source}/detail/${id}`});
async function request(data:unknown,timestamp=String(Date.now()),key=secret) {
 const body=typeof data==='string'?data:JSON.stringify(data);
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(`${timestamp}.${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
 return new Request('https://worker.test/internal/notices',{method:'POST',body,headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':signature}});
}
function database(){const db=testDatabase();db.env.NOTICE_COLLECTION_MODE='external';db.env.NOTICE_INGEST_SECRET=secret;return db;}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('authenticated notice ingestion',()=>{
 it('accepts all six canonical sources and rejects foreign or cross-board links and duplicate IDs',()=>{
  expect(SOURCES).toHaveLength(6);
  for(const s of SOURCES)expect(validateNoticeSnapshot({source:s.id,notices:[notice(s.id)]}).source).toBe(s.id);
  for(const n of [{...notice(),url:'https://attacker.test/1'},{...notice('news'),source:'career'},{...notice(),published:'2026-02-30'},{...notice(),id:'0'},{...notice(),title:''}])expect(()=>validateNoticeSnapshot({source:n.source,notices:[n]})).toThrow();
  expect(()=>validateNoticeSnapshot({source:'university',notices:[notice(),notice()]})).toThrow();
  expect(()=>validateNoticeSnapshot({source:'university',notices:[]})).toThrow();
  expect(()=>validateNoticeSnapshot({source:'university',notices:Array.from({length:101},(_,i)=>notice('university',String(i+1)))})).toThrow();
 });
 it('accepts the actual Node producer signature without re-encoding the Korean payload',async()=>{
  const db=database();try{
   const signed=signedSnapshot('graduateNotice',[notice('graduateNotice')],secret);
   const r=new Request('https://worker.test/internal/notices',{method:'POST',body:signed.body,headers:signed.headers});
   expect((await handleRequest(r,db.env)).status).toBe(202);
  }finally{db.close();}
 });
 it('rechecks timestamp freshness after reading the body',async()=>{
  const db=database();try{
   const timestamp=Date.now();const r=await request({source:'news',notices:[notice('news')]},String(timestamp));
   vi.spyOn(Date,'now').mockReturnValueOnce(timestamp).mockReturnValue(timestamp+301_000);
   expect((await handleRequest(r,db.env)).status).toBe(401);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('bounds the read time of an anonymous slow streaming request',async()=>{
  const db=database();try{
   vi.useFakeTimers();
   const r=new Request('https://worker.test/internal/notices',{method:'POST',body:new ReadableStream(),duplex:'half',headers:{'content-type':'application/json','x-collector-timestamp':String(Date.now()),'x-collector-signature':'a'.repeat(64)}} as any);
   const result=handleRequest(r,db.env);await vi.advanceTimersByTimeAsync(10_001);
   expect((await result).status).toBe(408);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('rejects missing/wrong signature, tampering and expired/future timestamps before saving',async()=>{
  const db=database();try{
   const data={source:'university',notices:[notice()]};
   const missing=new Request('https://worker.test/internal/notices',{method:'POST',body:'not json'});
   expect((await handleRequest(missing,db.env)).status).toBe(401);
   for(const r of [await request(data,undefined,'wrong-secret'),await request(data,String(Date.now()-301_000)),await request(data,String(Date.now()+301_000))])expect((await handleRequest(r,db.env)).status).toBe(401);
   const signed=await request(data);const headers=new Headers(signed.headers);
   expect((await handleRequest(new Request(signed.url,{method:'POST',headers,body:JSON.stringify({...data,notices:[notice('university','2')]})}),db.env)).status).toBe(401);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);expect(db.env.JOBS.send).not.toHaveBeenCalled();
  }finally{db.close();}
 });
 it('rejects disabled mode, weak keys, invalid signed JSON and oversized streaming bodies',async()=>{
  const db=database();try {
   db.env.NOTICE_COLLECTION_MODE='worker';expect((await handleRequest(await request({}),db.env)).status).toBe(503);
   db.env.NOTICE_COLLECTION_MODE='external';db.env.NOTICE_INGEST_SECRET='short';expect((await handleRequest(await request({}),db.env)).status).toBe(503);db.env.NOTICE_INGEST_SECRET=secret;
   expect((await handleRequest(await request('not JSON'),db.env)).status).toBe(400);
   expect((await handleRequest(await request({source:'university',notices:[{...notice(),url:'https://foreign.test'}]}),db.env)).status).toBe(400);
   expect((await handleRequest(await request('x'.repeat(256*1024+1)),db.env)).status).toBe(413);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('deduplicates replay, queues durable IDs only, and suppresses initial baseline alerts',async()=>{
  const db=database();try {
   const r=await request({source:'university',notices:[notice()]});const replay=r.clone();
   const first=await handleRequest(r,db.env);expect(first.status).toBe(202);const {id}=await first.json() as {id:string};
   expect((await handleRequest(replay,db.env)).status).toBe(202);
   expect(db.env.JOBS.send).toHaveBeenCalledWith({id});
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(1);
   const msg={body:{id},ack:vi.fn()};await consume(db.env,{messages:[msg]} as any);await consume(db.env,{messages:[msg]} as any);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(1);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(0);
   expect(db.sqlite.prepare("SELECT initialized FROM sources WHERE id='university'").get()!.initialized).toBe(1);
   expect(String(db.sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get(id)!.payload)).not.toContain(secret);
   const fresh=await handleRequest(await request({source:'university',notices:[notice('university','2'),notice()]}),db.env);
   const freshId=(await fresh.json() as {id:string}).id;await consume(db.env,{messages:[{body:{id:freshId},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(1);
  }finally{db.close();}
 });
 it('retries ambiguous dispatch using the same durable job instead of losing the snapshot',async()=>{
  const db=database();try {
   vi.mocked(db.env.JOBS.send).mockRejectedValueOnce(new Error('network'));
   const r=await request({source:'news',notices:[notice('news')]});const replay=r.clone();
   expect((await handleRequest(r,db.env)).status).toBe(503);expect((await handleRequest(replay,db.env)).status).toBe(202);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(1);
  }finally{db.close();}
 });
 it('external mode does not schedule direct school fetches but retains meal planning',async()=>{
  const db=database();try {
   await planCron(db.env,Date.parse('2026-10-09T14:45:00Z'));
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='collect'").get()!.n).toBe(0);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='meal-discover'").get()!.n).toBe(1);
  }finally{db.close();}
 });
 it('retries transient snapshot processing through Queue delay without relying on Cron',async()=>{
  const db=database();try{
   vi.spyOn(console,'error').mockImplementation(()=>{});
   const accepted=await handleRequest(await request({source:'news',notices:[notice('news')]}),db.env);const {id}=await accepted.json() as {id:string};
   vi.spyOn(db.env.DB,'batch').mockRejectedValueOnce(new Error('transient D1 failure'));
   const msg={body:{id},ack:vi.fn(),retry:vi.fn()};
   await consume(db.env,{messages:[msg]} as any);
   expect(msg.ack).not.toHaveBeenCalled();expect(msg.retry).toHaveBeenCalledWith({delaySeconds:120});
   expect(db.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get(id)!.state).toBe('retry');
   db.sqlite.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),id);
   await consume(db.env,{messages:[msg]} as any);
   expect(msg.ack).toHaveBeenCalledTimes(1);expect(db.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get(id)!.state).toBe('done');
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(1);
  }finally{db.close();}
 });
 it('skips direct collection jobs left over from worker mode without fetching',async()=>{
  const db=database();try{
   const {enqueue}=await import('../src/storage');await enqueue(db.env,'old-collect','collect',{source:'university'});
   const fetcher=vi.spyOn(globalThis,'fetch');
   await consume(db.env,{messages:[{body:{id:'old-collect'},ack:vi.fn()}]} as any);
   expect(fetcher).not.toHaveBeenCalled();expect(db.sqlite.prepare("SELECT state FROM jobs WHERE id='old-collect'").get()!.state).toBe('done');
  }finally{db.close();}
 });
 it('does not apply stale queued snapshots',async()=>{
  const db=database();try {
   vi.spyOn(console,'error').mockImplementation(()=>{});
   const accepted=await handleRequest(await request({source:'news',notices:[notice('news')]}),db.env);const {id}=await accepted.json() as {id:string};
   db.sqlite.prepare('UPDATE jobs SET created_at=? WHERE id=?').run(new Date(Date.now()-31*60_000).toISOString(),id);
   await consume(db.env,{messages:[{body:{id},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(0);
  }finally{db.close();}
 });
});
