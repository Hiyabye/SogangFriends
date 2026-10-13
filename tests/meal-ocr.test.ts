import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {handleRequest} from '../src/worker';
import {OCR_VERSION,validateObservedIdentity} from '../src/meal-ocr';
import {addDays} from '../src/time';
import {cacheMealSources,type MealSource} from '../src/meal-cache';
import {testDatabase} from './helpers/db';

const secret='fixture-ocr-only-secret-'.repeat(3);
const source:MealSource={url:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660',imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/20261008_0923_5910001.jpg',published:'2026-10-08',start:'2026-10-12',end:'2026-10-18'};
const weekdays=['월요일','화요일','수요일','목요일','금요일','토요일','일요일'];
function observed(start=source.start,end=source.end){return {banner:[`${start.replaceAll('-','.')}~${end.replaceAll('-','.')}`],headers:Array.from({length:7},(_,i)=>{const date=addDays(start,i);return [`${Number(date.slice(5,7))}월 ${Number(date.slice(8,10))}일`,weekdays[i]];})};}
function week(start=source.start,end=source.end){
 const offering=()=>({status:'available',items:['쌀밥 오타 허용'],time:null,evidence:'쌀밥 오타 허용'});
 return {start,end,certain:true,days:Array.from({length:7},(_,i)=>({date:addDays(start,i),weekday:i+1,breakfastKorean:offering(),breakfastWestern:offering(),breakfastCommon:offering(),cupRice:{status:'unknown',items:[],time:null,evidence:''},dinner:offering(),drinks:offering()}))};
}
const lookup=()=>({action:'lookup',source:{...source},imageHash:'a'.repeat(64),version:OCR_VERSION});
const store=()=>({...lookup(),action:'store',engine:'paddle',identity:observed(),meal:week()});
async function signed(data:unknown,key=secret,timestamp=String(Date.now())) {
 const body=typeof data==='string'?data:JSON.stringify(data);
 const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(`${timestamp}.${body}`))),byte=>byte.toString(16).padStart(2,'0')).join('');
 return new Request('https://worker.test/internal/meal-ocr',{method:'POST',body,headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':signature}});
}
let db:ReturnType<typeof testDatabase>;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));db=testDatabase();db.env.MEAL_OCR_INGEST_SECRET=secret;});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.useRealTimers();});
const send=async(data:unknown,key=secret)=>handleRequest(await signed(data,key),db.env);
const count=(table:string)=>Number(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);

describe('observed OCR date identity',()=>{
 it('accepts all six real cross-week pipeline identities, including both month transitions',()=>{
  const samples=JSON.parse(readFileSync(new URL('../scripts/meal-ocr/cross-week-evaluation.json',import.meta.url),'utf8'));
  const accepted=samples.filter((sample:{accepted:boolean})=>sample.accepted);
  expect(accepted).toHaveLength(6);
  for(const sample of accepted)expect(validateObservedIdentity(sample.identity,sample.source)).toEqual(sample.identity);
 });
 it('accepts split month/day boxes, leading zeros and both banner date formats',()=>{
  const identity=observed();identity.banner=['주간메뉴표','2026.10.12 ~10.18'];identity.headers[1]=['10월','13일','화요일'];
  expect(validateObservedIdentity(identity,source)).toEqual(identity);
  expect(validateObservedIdentity(observed(),source).headers).toHaveLength(7);
 });
 it('validates observed month and year rollover rather than assigning dates by position',()=>{
  for(const [start,end,banner] of [['2026-09-28','2026-10-04','2026.09.28~10.04'],['2026-12-28','2027-01-03','2026.12.28~01.03'],['2026-12-28','2027-01-03','2026.12.28~2027.01.03']]){
   const identity=observed(start,end);identity.banner=[banner];expect(validateObservedIdentity(identity,{start,end}).headers).toHaveLength(7);
  }
 });
 it('accepts real OCR punctuation and day-unit errors without repairing date numbers',()=>{
  const identity=observed('2026-09-28','2026-10-04');identity.banner=['2026.09,28~10.04'];identity.headers[4]=['10월','02','금요일'];
  expect(validateObservedIdentity(identity,{start:'2026-09-28',end:'2026-10-04'})).toEqual(identity);
 });
 it('rejects repeated weekdays, conflicting years and longer numeric tokens',()=>{
  for(const header of [['10월12일','월요일월요일'],['2025년10월12일','월요일'],['2026년2026년10월12일','월요일'],['110월12일','월요일'],['10월123일','월요일']]){
   const identity=observed();identity.headers[0]=header;expect(()=>validateObservedIdentity(identity,source)).toThrow();
  }
 });
 it('rejects a real historical stale-banner pattern even when all column dates are correct',()=>{
  const identity=observed('2026-09-14','2026-09-20');identity.banner=['2026.09.07~2026.09.13'];
  expect(()=>validateObservedIdentity(identity,{start:'2026-09-14',end:'2026-09-20'})).toThrow('Conflicting observed banner');
 });
 it('rejects unreadable, duplicate or conflicting banner text and invalid calendar dates',()=>{
  for(const banner of [[],[''],['10월 12일~18일'],['2026.10.12~10.18 2026.10.19~10.25'],['2026.02.30~03.08'],['2026.10.12~2027.10.18'],Array(13).fill('text'),['x'.repeat(151)]]){
   expect(()=>validateObservedIdentity({...observed(),banner},source)).toThrow();
  }
 });
 it('rejects shifted/swapped columns, wrong weekdays, missing observations and extra date fragments',()=>{
  for(const mutate of [(h:string[][])=>[h[1],h[0],...h.slice(2)],(h:string[][])=>h.slice(1),(h:string[][])=>{h[0]=['10월 12일','화요일'];return h;},(h:string[][])=>{h[0]=['10월 12일','월요일 화요일'];return h;},(h:string[][])=>{h[0]=['10월 12일 10월 13일','월요일'];return h;},(h:string[][])=>{h[0]=['월요일'];return h;}]){
   const identity=observed();identity.headers=mutate(identity.headers);expect(()=>validateObservedIdentity(identity,source)).toThrow();
  }
  expect(()=>validateObservedIdentity({...observed(),guessed:true},source)).toThrow();
 });
});

describe('dedicated authenticated OCR ingestion',()=>{
 it('requires its own strong secret independent of notice collection mode',async()=>{
  db.env.NOTICE_COLLECTION_MODE='worker';db.env.NOTICE_INGEST_SECRET='other-secret-'.repeat(4);
  expect((await send(lookup(),db.env.NOTICE_INGEST_SECRET)).status).toBe(401);
  expect((await send(lookup())).status).toBe(200);
  db.env.MEAL_OCR_INGEST_SECRET='short';expect((await send(lookup())).status).toBe(503);
  delete db.env.MEAL_OCR_INGEST_SECRET;expect((await send(lookup())).status).toBe(503);
 });
 it('supports official inline-image article identities without storing image bytes',async()=>{
  const inline={...source,imageUrl:source.url};
  expect((await send({...lookup(),source:inline})).status).toBe(200);
  expect((await send({...store(),source:inline})).status).toBe(200);
  expect(db.sqlite.prepare('SELECT image_url FROM meal_sources').get()!.image_url).toBe(source.url);
  expect(String(db.sqlite.prepare('SELECT data FROM meals').get()!.data)).not.toContain('base64');
  expect(count('jobs')).toBe(0);expect(db.env.JOBS.send).not.toHaveBeenCalled();
 });
 it('rechecks signature freshness after streaming the body',async()=>{
  const at=Date.now(),request=await signed(lookup());
  vi.spyOn(Date,'now').mockReturnValueOnce(at).mockReturnValue(at+301000);
  expect((await handleRequest(request,db.env)).status).toBe(401);
  expect(count('meal_sources')).toBe(0);
 });
 it('rejects missing signature, tampering, and expired/future timestamps',async()=>{
  expect((await handleRequest(new Request('https://worker.test/internal/meal-ocr',{method:'POST',body:'{}'}),db.env)).status).toBe(401);
  expect((await send(lookup(),'wrong-key')).status).toBe(401);
  for(const offset of [-301000,301000])expect((await handleRequest(await signed(lookup(),secret,String(Date.now()+offset)),db.env)).status).toBe(401);
  const request=await signed(lookup());expect((await handleRequest(new Request(request.url,{method:'POST',headers:request.headers,body:'{}'}),db.env)).status).toBe(401);
  expect(count('meal_sources')).toBe(0);
 });
 it('bounds malformed JSON, payload size and streaming read time before any mutation',async()=>{
  expect((await send('invalid-json')).status).toBe(400);
  expect((await send('x'.repeat(256*1024+1))).status).toBe(413);
  const request=new Request('https://worker.test/internal/meal-ocr',{method:'POST',body:new ReadableStream(),duplex:'half',headers:{'content-type':'application/json','x-collector-timestamp':String(Date.now()),'x-collector-signature':'a'.repeat(64)}} as any);
  const pending=handleRequest(request,db.env);await vi.advanceTimersByTimeAsync(10001);expect((await pending).status).toBe(408);
  expect(count('meal_sources')).toBe(0);
 });
 it('captures source metadata independently of OCR success without inference or delivery',async()=>{
  expect(await (await send(lookup())).json()).toEqual({cached:false});
  expect(count('meal_sources')).toBe(1);expect(count('meals')).toBe(0);expect(count('jobs')).toBe(0);expect(count('llm_usage')).toBe(0);expect(db.env.JOBS.send).not.toHaveBeenCalled();
  const bad=store();bad.identity.banner=['2026.10.05~10.11'];expect((await send(bad)).status).toBe(400);
  expect(count('meal_sources')).toBe(1);expect(count('meals')).toBe(0);
 });
 it('stores validated meal data idempotently and refreshes only its exact OCR cache identity',async()=>{
  await send(lookup());const payload=store();payload.meal.days.reverse();
  const response=await send(payload);expect(response.status).toBe(200);expect(await response.json()).toEqual({accepted:true,cached:false});
  const original=db.sqlite.prepare('SELECT * FROM meals').get()!;expect(original.model).toBe('paddleocr');expect(original.version).toBe(OCR_VERSION);expect(JSON.parse(String(original.data)).days[0].date).toBe('2026-10-12');
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));expect(await (await send(store())).json()).toEqual({accepted:true,cached:true});
  expect(db.sqlite.prepare('SELECT * FROM meals').get()).toEqual(original);
  expect(await (await send(lookup())).json()).toEqual({cached:true});
  expect(db.sqlite.prepare('SELECT verified_at FROM meals').get()!.verified_at).toBe('2026-10-13T01:00:00.000Z');
  expect(await (await send({...lookup(),imageHash:'b'.repeat(64)})).json()).toEqual({cached:false});
  expect(count('meals')).toBe(1);expect(count('jobs')).toBe(0);expect(count('llm_usage')).toBe(0);expect(db.env.JOBS.send).not.toHaveBeenCalled();
 });
 it('accepts EasyOCR results but rejects unknown engines or mismatched meal identity',async()=>{
  await send(lookup());expect((await send({...store(),engine:'easy'})).status).toBe(200);expect(db.sqlite.prepare('SELECT model FROM meals').get()!.model).toBe('easyocr');
  expect((await send({...store(),engine:'llm'})).status).toBe(400);
  const bad=store();bad.meal.days[0].weekday=2;expect((await send(bad)).status).toBe(400);
  bad.meal.days[0].weekday=1;bad.meal.certain=false;expect((await send(bad)).status).toBe(400);
 });
 it('rejects invalid source/hash/version/action fields before cache mutation',async()=>{
  const variants=[{...lookup(),imageHash:'a'.repeat(63)},{...lookup(),version:'llm-v1'},{...lookup(),action:'delete'},{...lookup(),extra:true},{...lookup(),source:{...source,published:'2026-02-30'}},{...lookup(),source:{...source,start:'2026-10-13'}},{...lookup(),source:{...source,url:source.url+'&other=1'}},{...lookup(),source:{...source,url:'https://attacker.test'}},{...lookup(),source:{...source,imageUrl:'data:image/png;base64,aaa'}},{...lookup(),source:{...source,imageUrl:'https://attacker.test/x.jpg'}}];
  for(const value of variants)expect((await send(value)).status).toBe(400);
  expect(count('meal_sources')).toBe(0);expect(count('meals')).toBe(0);
 });
 it('retains only current and next KST Monday–Sunday weeks',async()=>{
  const next={...source,start:'2026-10-19',end:'2026-10-25',published:'2026-10-15',url:source.url.replace('941660','942000')};
  expect((await send({...lookup(),source:next})).status).toBe(200);
  for(const [start,end] of [['2026-10-05','2026-10-11'],['2026-10-26','2026-11-01']])expect((await send({...lookup(),source:{...source,start,end}})).status).toBe(400);
  expect(count('meal_sources')).toBe(1);
 });
 it('requires captured identity before store and rejects older or superseded captures',async()=>{
  expect((await send(store())).status).toBe(409);await send(lookup());
  const newer={...source,url:source.url.replace('941660','941661'),published:'2026-10-09'};await cacheMealSources(db.env,[newer]);
  expect((await send(lookup())).status).toBe(409);expect((await send(store())).status).toBe(409);
  expect(db.sqlite.prepare('SELECT source_url FROM meal_sources').get()!.source_url).toBe(newer.url);expect(count('meals')).toBe(0);
 });
 it('rejects metadata changed between preflight and the atomic write without false health success',async()=>{
  await send(lookup());const batch=db.env.DB.batch.bind(db.env.DB);
  vi.spyOn(db.env.DB,'batch').mockImplementationOnce(async statements=>{
   db.sqlite.prepare('UPDATE meal_sources SET published=?').run('2026-10-09');return batch(statements);
  });
  expect((await send(store())).status).toBe(409);expect(count('meals')).toBe(0);expect(count('health')).toBe(0);
 });
 it('rejects source window expiry during preflight without inserting derived results',async()=>{
  await send(lookup());const prepare=db.env.DB.prepare.bind(db.env.DB);
  vi.spyOn(db.env.DB,'prepare').mockImplementation(sql=>{
   const statement=prepare(sql);
   if(sql.startsWith('SELECT 1 FROM meal_sources'))vi.setSystemTime(new Date('2026-10-18T15:00:00Z'));
   return statement;
  });
  expect((await send(store())).status).toBe(503);expect(count('meals')).toBe(0);
 });
 it('does not touch historic jobs, notices, reservations, or rejected extraction provenance',async()=>{
  db.sqlite.prepare('INSERT INTO jobs(id,kind,payload,state,created_at,available_at) VALUES(?,?,?,?,?,?)').run('old','meal-extract',JSON.stringify({rejectedExtraction:{data:{start:'2026-10-12'},model:'model:free'}}),'needs_review','at','at');
  db.sqlite.prepare('INSERT INTO llm_usage VALUES(?,?,?,?,?,?)').run('old','2026-10-10',.25,null,'reserved','at');
  db.sqlite.prepare('INSERT INTO notices VALUES(?,?,?,?,?,?)').run('university','1','notice','2026-10-10','url','at');
  const oldJobs=db.sqlite.prepare('SELECT * FROM jobs').all(),oldUsage=db.sqlite.prepare('SELECT * FROM llm_usage').all(),oldNotices=db.sqlite.prepare('SELECT * FROM notices').all();
  await send(lookup());await send(store());
  expect(db.sqlite.prepare('SELECT * FROM jobs').all()).toEqual(oldJobs);expect(db.sqlite.prepare('SELECT * FROM llm_usage').all()).toEqual(oldUsage);expect(db.sqlite.prepare('SELECT * FROM notices').all()).toEqual(oldNotices);expect(db.env.JOBS.send).not.toHaveBeenCalled();
 });
 it('fails cache operations safely without exposing upstream errors',async()=>{
  vi.spyOn(db.env.DB,'batch').mockRejectedValueOnce(new Error('secret body/tokens'));
  const response=await send(lookup());expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret');
 });
});
