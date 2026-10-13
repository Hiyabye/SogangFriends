import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {consume,executeJob} from '../src/jobs';
import {claim,enqueue,recover,retryJob} from '../src/storage';
import type {Job,MealWeek} from '../src/types';

let db:ReturnType<typeof testDatabase>;
const historicalModel='google/gemma-4-31b-it:free';
const payload={imageUrl:'fixture',hash:'hash',start:'2026-10-05',end:'2026-10-11',published:'2026-10-01',url:'https://scc.sogang.ac.kr/front/cmsboardview.do?pkid=941444',version:'meal-v4-retry-free',key:'fixture-key',models:[historicalModel]};
const offering=()=>({status:'unknown' as const,items:[],time:null,evidence:''});
const week:MealWeek={start:payload.start,end:payload.end,certain:true,days:Array.from({length:7},(_,i)=>({date:`2026-10-${String(i+5).padStart(2,'0')}`,weekday:i+1,breakfastKorean:offering(),breakfastWestern:offering(),breakfastCommon:offering(),cupRice:offering(),dinner:offering(),drinks:offering()}))};
const row=()=>db.sqlite.prepare("SELECT * FROM jobs WHERE id='meal'").get()!;
async function run(){const msg={body:{id:'meal'},ack:vi.fn(),retry:vi.fn()};await consume(db.env,{messages:[msg],queue:'fixture'} as never);return msg;}
beforeEach(async()=>{db=testDatabase();vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-10T14:30:00Z'));await enqueue(db.env,'meal','meal-extract',payload);});
afterEach(()=>{db.close();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

async function quarantineFixture(){
 const owner=`extract:${payload.key}`;await enqueue(db.env,owner,'meal-extract',payload);
 db.sqlite.prepare("UPDATE jobs SET state='done',attempts=2 WHERE id=?").run(owner);
 const insert=db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(const key of [payload.key,'unrelated-cache'])insert.run(key,payload.url,payload.hash,payload.version,payload.start,payload.end,JSON.stringify(week),'2026-10-10T14:29:00Z','2026-10-10T14:29:00Z',historicalModel);
 db.sqlite.prepare("INSERT INTO llm_usage(id,day,reserved_usd,actual_usd,state,created_at) VALUES(?,'2026-10-10',0.25,0,'completed','now')").run(owner);
 db.sqlite.exec("INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES('old-unknown','2026-10-10',0.25,'reserved','now'); INSERT INTO health(id,last_success) VALUES('meal','2026-10-09T13:00:00Z')");
 return {owner,job:{id:'quarantine',kind:'meal-quarantine',payload:JSON.stringify({cacheKey:payload.key})} as Job};
}
describe('private historical meal quarantine',()=>{
 it('atomically retains the exact result, removes only its serving cache, and permits lossless replay',async()=>{
  const {owner,job}=await quarantineFixture();const reservations=db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all();
  await executeJob(db.env,job);const extraction=db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(owner)!;
  expect(extraction).toMatchObject({state:'needs_review',attempts:2,lease_until:null});
  const stored=JSON.parse(String(extraction.payload));expect(stored.key).toBe(payload.key);
  expect(stored.rejectedExtraction).toMatchObject({cacheKey:payload.key,data:week,model:historicalModel,sourceUrl:payload.url,imageHash:payload.hash,version:payload.version,startDate:payload.start,endDate:payload.end,extractedAt:'2026-10-10T14:29:00Z',verifiedAt:'2026-10-10T14:29:00Z',reason:'Meal failed source-image comparison; result quarantined'});
  expect(stored.rejectedExtraction.reviewedAt).toBe(new Date().toISOString());
  expect(db.sqlite.prepare('SELECT cache_key FROM meals ORDER BY cache_key').all()).toEqual([{cache_key:'unrelated-cache'}]);
  const health=db.sqlite.prepare("SELECT * FROM health WHERE id='meal'").get()!;expect(health.last_success).toBe('2026-10-09T13:00:00Z');expect(health.error).toContain('quarantined');
  vi.advanceTimersByTime(1000);await executeJob(db.env,job);
  expect(db.sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get(owner)!.payload).toBe(extraction.payload);
  expect(db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all()).toEqual(reservations);
 });
 it('rolls the audit and health changes back when deleting the cache fails',async()=>{
  const {owner,job}=await quarantineFixture();const extraction=db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(owner)!;
  const health=db.sqlite.prepare("SELECT * FROM health WHERE id='meal'").get()!;const reservations=db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all();
  db.sqlite.exec("CREATE TRIGGER fail_quarantine BEFORE DELETE ON meals WHEN OLD.cache_key='fixture-key' BEGIN SELECT RAISE(ABORT,'simulated delete failure'); END");
  await expect(executeJob(db.env,job)).rejects.toThrow('simulated delete failure');
  expect(db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(owner)).toEqual(extraction);
  expect(db.sqlite.prepare("SELECT * FROM health WHERE id='meal'").get()).toEqual(health);
  expect(db.sqlite.prepare('SELECT COUNT(*) n FROM meals').get()!.n).toBe(2);
  expect(db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all()).toEqual(reservations);
  db.sqlite.exec('DROP TRIGGER fail_quarantine');await executeJob(db.env,job);expect(db.sqlite.prepare('SELECT COUNT(*) n FROM meals').get()!.n).toBe(1);
 });
 it.each(['missing','mismatched'])('refuses deletion without a matching extraction owner (%s)',async(mode)=>{
  const {owner,job}=await quarantineFixture();
  if(mode==='missing')db.sqlite.prepare('DELETE FROM jobs WHERE id=?').run(owner);
  else db.sqlite.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({...payload,key:'wrong-key'}),owner);
  await expect(executeJob(db.env,job)).rejects.toThrow('Meal quarantine not committed');
  expect(db.sqlite.prepare('SELECT COUNT(*) n FROM meals').get()!.n).toBe(2);
  expect(db.sqlite.prepare("SELECT error FROM health WHERE id='meal'").get()!.error).toBeNull();
 });
});
describe('retired meal inference',()=>{
 it.each(['pending','retry'])('retires %s jobs without spending attempts or touching audit data, including delayed/exhausted jobs',async(state)=>{
  const data={...payload,rejectedExtraction:{data:week,reason:'historical review'}};
  db.sqlite.prepare("UPDATE jobs SET state=?,attempts=10,available_at='2099-01-01',payload=?,error='original rejection' WHERE id='meal'").run(state,JSON.stringify(data));
  for(const status of ['reserved','safe_retry','completed','rejected','confirmed_rejected'])db.sqlite.prepare('INSERT INTO llm_usage(id,day,reserved_usd,actual_usd,state,created_at) VALUES(?,?,?,?,?,?)').run(status,'2026-10-10',.25,status==='completed'?0:null,status,'now');
  const reservations=db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all();const original=row();
  const network=vi.fn();vi.stubGlobal('fetch',network);const msg=await run();
  expect(row()).toEqual({...original,state:'needs_review',lease_until:null});expect(msg.ack).toHaveBeenCalledOnce();expect(msg.retry).not.toHaveBeenCalled();
  expect(db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all()).toEqual(reservations);
  expect(db.env.JOBS.send).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
  await run();expect(row()).toEqual({...original,state:'needs_review',lease_until:null});
 });
 it('records retirement when no prior diagnostic exists and preserves a claimed job payload',async()=>{
  const job=await claim(db.env,'meal');const original=row();await executeJob(db.env,job!);
  expect(row()).toEqual({...original,state:'needs_review',lease_until:null,error:'Meal inference retired; use OCR'});
  expect(db.sqlite.prepare('SELECT COUNT(*) n FROM llm_usage').get()!.n).toBe(0);
 });
 it.each(['running','done','failed','needs_review'])('does not reset an existing %s outcome or lease',async(state)=>{
  db.sqlite.prepare("UPDATE jobs SET state=?,attempts=4,lease_until='2099-01-01',error='historical reason' WHERE id='meal'").run(state);
  const original=row();await run();expect(row()).toEqual(original);expect(db.env.JOBS.send).not.toHaveBeenCalled();
 });
 it('recovers expired running inference as uncertain without altering its reservation',async()=>{
  db.sqlite.exec("INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES('meal','2026-10-10',.25,'reserved','now')");
  const reservation=db.sqlite.prepare('SELECT * FROM llm_usage').get();await claim(db.env,'meal');vi.advanceTimersByTime(21*60000);
  await recover(db.env);await run();expect(row()).toMatchObject({state:'needs_review',attempts:1,error:'lease expired'});
  expect(db.sqlite.prepare('SELECT * FROM llm_usage').get()).toEqual(reservation);
 });
});
describe('historical SQL claim boundaries',()=>{
 it('retains ten-claim interpretation for legacy records while ordinary jobs still stop at three',async()=>{
  for(const kind of ['meal-extract','collect']){
   const id=`claims:${kind}`;await enqueue(db.env,id,kind,{});const max=kind==='meal-extract'?10:3;
   for(let i=1;i<=max;i++){const job=await claim(db.env,id);expect(job!.attempts).toBe(i);expect(await claim(db.env,id)).toBeNull();await retryJob(db.env,job!,'rejected',1);vi.advanceTimersByTime(1000);}
   expect(await claim(db.env,id)).toBeNull();expect(db.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get(id)!.state).toBe(kind==='meal-extract'?'needs_review':'failed');
  }
 });
});
