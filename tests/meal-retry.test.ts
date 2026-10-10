import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {consume,executeJob} from '../src/jobs';
import {claim,dispatch,enqueue,recover,reserveLlm,retryJob} from '../src/storage';
import {extractMeal,MealExtractionError,MEAL_PRIMARY_MODEL,MEAL_FALLBACK_MODEL,mealRetryDelay} from '../src/meals';
import type {Job,MealWeek} from '../src/types';

vi.mock('../src/meals',async importOriginal=>({...await importOriginal<object>(),extractMeal:vi.fn()}));
vi.mock('../src/sources',async importOriginal=>({...await importOriginal<object>(),fetchImage:vi.fn(async()=>({bytes:new Uint8Array([1]),mime:'image/png',hash:'hash'}))}));
let db:ReturnType<typeof testDatabase>;
const payload={imageUrl:'fixture',hash:'hash',start:'2026-10-05',end:'2026-10-11',published:'2026-10-01',url:'https://scc.sogang.ac.kr/front/cmsboardview.do?pkid=941444',version:'meal-v4-retry-free',key:'fixture-key',models:[MEAL_PRIMARY_MODEL,MEAL_FALLBACK_MODEL]};
const offering=()=>({status:'unknown' as const,items:[],time:null,evidence:''});
const week:MealWeek={start:payload.start,end:payload.end,certain:true,days:Array.from({length:7},(_,i)=>({date:`2026-10-${String(i+5).padStart(2,'0')}`,weekday:i+1,breakfastKorean:offering(),breakfastWestern:offering(),breakfastCommon:offering(),cupRice:offering(),dinner:offering(),drinks:offering()}))};
const message=()=>({body:{id:'meal'},ack:vi.fn(),retry:vi.fn()});
const run=async()=>{const msg=message();await consume(db.env,{messages:[msg],queue:'fixture'} as never);return msg;};
const row=()=>db.sqlite.prepare("SELECT * FROM jobs WHERE id='meal'").get()!;
const usage=()=>db.sqlite.prepare("SELECT * FROM llm_usage WHERE id='meal'").get()!;
beforeEach(async()=>{
 db=testDatabase();vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-10T14:30:00Z'));
 Object.assign(db.env,{LLM_ENABLED:'true',OPENROUTER_API_KEY:'fixture',LLM_DAILY_CALLS:'2',LLM_DAILY_BUDGET_USD:'0.50',LLM_MAX_CALL_USD:'0.25'});
 vi.mocked(extractMeal).mockReset();await enqueue(db.env,'meal','meal-extract',payload);
});
afterEach(()=>{db.close();vi.useRealTimers();vi.restoreAllMocks();});

describe('durable five-plus-five meal policy',()=>{
 it('stops an operator one-off verification after its first confirmed rejection',async()=>{
  db.sqlite.prepare("UPDATE jobs SET payload=? WHERE id='meal'").run(JSON.stringify({...payload,models:['dots-studio/dots-3-note-preview:free'],verificationOnly:true}));
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Model service HTTP 429',null,true));
  await run();expect(row()).toMatchObject({state:'needs_review',attempts:1});
  expect(usage().state).toBe('safe_retry');expect(db.env.JOBS.send).not.toHaveBeenCalled();
  await run();expect(extractMeal).toHaveBeenCalledTimes(1);
 });
 it('selects five primary then five fallback attempts, delays each fresh message, and stops for operator choice',async()=>{
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Model service HTTP 429 (inference)',null,true));
  const delays=[60,120,240,480,60,60,120,240,480];
  for(let attempt=1;attempt<=10;attempt++){
   const msg=await run();expect(msg.ack).toHaveBeenCalledTimes(1);expect(msg.retry).not.toHaveBeenCalled();
   expect(row().attempts).toBe(attempt);
   expect(vi.mocked(extractMeal).mock.calls[attempt-1][0].MEAL_MODEL).toBe(attempt<=5?MEAL_PRIMARY_MODEL:MEAL_FALLBACK_MODEL);
   if(attempt<10){
    expect(row().state).toBe('retry');expect(Date.parse(String(row().available_at))-Date.now()).toBe(delays[attempt-1]*1000);
    expect(db.env.JOBS.send).toHaveBeenLastCalledWith({id:'meal'},{delaySeconds:delays[attempt-1]});
    vi.advanceTimersByTime(delays[attempt-1]*1000);
   }
  }
  expect(row().state).toBe('needs_review');expect(row().error).toContain('5+5 attempts exhausted');
  expect(db.sqlite.prepare("SELECT error FROM health WHERE id='meal'").get()!.error).toContain('operator model choice required');
  expect(usage()).toMatchObject({day:'2026-10-10',state:'safe_retry',reserved_usd:0.25,actual_usd:null});
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM llm_usage').get()!.n).toBe(1);
  expect(db.env.JOBS.send).toHaveBeenCalledTimes(9);
  await run();expect(extractMeal).toHaveBeenCalledTimes(10);
 });
 it('stores a successful fallback response after all five primary rejections and stops immediately',async()=>{
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Rejected',null,true));
  for(const delay of [60,120,240,480,60]){await run();vi.advanceTimersByTime(delay*1000);}
  vi.mocked(extractMeal).mockResolvedValue({week,actualCost:0,model:MEAL_FALLBACK_MODEL});
  await run();expect(row()).toMatchObject({state:'done',attempts:6});
  expect(db.sqlite.prepare('SELECT model FROM meals').get()!.model).toBe(MEAL_FALLBACK_MODEL);
  expect(usage()).toMatchObject({state:'completed',actual_usd:0});
  await run();expect(extractMeal).toHaveBeenCalledTimes(6);
 });
 it('honors a longer Retry-After and progressively delays without shortening that floor',async()=>{
  expect([1,2,3,4,5,6,7,8,9].map(n=>mealRetryDelay(n))).toEqual([60,120,240,480,60,60,120,240,480]);
  expect(mealRetryDelay(2,1200)).toBe(1200);expect(mealRetryDelay(9,70000)).toBe(70000);
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Model service HTTP 429',null,true,1200));
  await run();expect(db.env.JOBS.send).toHaveBeenCalledWith({id:'meal'},{delaySeconds:1200});
  expect(Date.parse(String(row().available_at))-Date.now()).toBe(1200000);
 });
 it('honors Retry-After beyond Queue’s 24-hour delay without spending an early attempt',async()=>{
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Rejected',null,true,100000));
  await run();expect(Date.parse(String(row().available_at))-Date.now()).toBe(100000000);
  expect(db.env.JOBS.send).toHaveBeenLastCalledWith({id:'meal'},{delaySeconds:86400});
  vi.advanceTimersByTime(86400000);await run();expect(row().attempts).toBe(1);expect(extractMeal).toHaveBeenCalledTimes(1);
  expect(db.env.JOBS.send).toHaveBeenLastCalledWith({id:'meal'},{delaySeconds:13600});
  vi.advanceTimersByTime(13600000);await run();expect(row().attempts).toBe(2);expect(extractMeal).toHaveBeenCalledTimes(2);
 });
 it('never retries or falls back after ambiguous inference even when some cost is available',async()=>{
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Uncertain inference',0.04,false));
  await run();expect(row().state).toBe('needs_review');expect(usage()).toMatchObject({actual_usd:0.04,state:'rejected'});
  expect(db.env.JOBS.send).not.toHaveBeenCalled();await run();expect(extractMeal).toHaveBeenCalledTimes(1);
 });
 it('retries completed invalid output and accumulates observed costs through success in the same reservation',async()=>{
  vi.mocked(extractMeal).mockRejectedValueOnce(new MealExtractionError('Completed invalid output',0.012,true))
   .mockRejectedValueOnce(new MealExtractionError('Completed invalid dates',0.018,true))
   .mockResolvedValueOnce({week,actualCost:0.025,model:MEAL_PRIMARY_MODEL});
  await run();expect(usage()).toMatchObject({state:'safe_retry',actual_usd:0.012});vi.advanceTimersByTime(60000);
  await run();expect(Number(usage().actual_usd)).toBeCloseTo(0.03);vi.advanceTimersByTime(120000);
  await run();expect(row().state).toBe('done');expect(usage().state).toBe('completed');expect(Number(usage().actual_usd)).toBeCloseTo(0.055);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM llm_usage').get()!.n).toBe(1);
  expect(db.sqlite.prepare('SELECT model FROM meals').get()!.model).toBe(MEAL_PRIMARY_MODEL);
 });
 it('preserves previously observed costs when a later successful response omits usage',async()=>{
  vi.mocked(extractMeal).mockRejectedValueOnce(new MealExtractionError('Completed invalid output',0.012,true)).mockResolvedValueOnce({week,actualCost:null,model:MEAL_PRIMARY_MODEL});
  await run();vi.advanceTimersByTime(60000);await run();expect(usage()).toMatchObject({state:'completed',actual_usd:0.012,reserved_usd:0.25});
 });
 it('resends an early redelivery after an uncertain delayed send without repeating inference or spending another attempt',async()=>{
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Rejected',null,true));
  vi.mocked(db.env.JOBS.send).mockRejectedValueOnce(new Error('queue transport failure'));
  const first=message();await expect(consume(db.env,{messages:[first],queue:'fixture'} as never)).rejects.toThrow('queue transport failure');
  expect(first.ack).not.toHaveBeenCalled();expect(row().state).toBe('retry');expect(row().attempts).toBe(1);
  await run();expect(extractMeal).toHaveBeenCalledTimes(1);expect(row().attempts).toBe(1);
  expect(db.env.JOBS.send).toHaveBeenLastCalledWith({id:'meal'},{delaySeconds:60});
 });
 it('recovers a lost delayed message via Cron dispatch but treats a crashed running inference as uncertain',async()=>{
  vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('Rejected',null,true));await run();
  vi.mocked(db.env.JOBS.send).mockClear();vi.advanceTimersByTime(60000);await recover(db.env);await dispatch(db.env);
  expect(db.env.JOBS.send).toHaveBeenCalledWith({id:'meal'});
  await claim(db.env,'meal');vi.advanceTimersByTime(21*60000);await recover(db.env);
  expect(row().state).toBe('needs_review');await run();expect(extractMeal).toHaveBeenCalledTimes(1);
 });
 it('keeps the snapshotted model pair across changed environment configuration',async()=>{
  db.env.MEAL_MODEL='other/primary:free';db.env.MEAL_FALLBACK_MODEL='other/fallback:free';
  vi.mocked(extractMeal).mockResolvedValue({week,actualCost:0,model:MEAL_FALLBACK_MODEL});
  const job={...row(),attempts:6} as unknown as Job;await executeJob(db.env,job);
  expect(vi.mocked(extractMeal).mock.calls[0][0].MEAL_MODEL).toBe(MEAL_FALLBACK_MODEL);
 });
});

describe('SQL retry and reservation boundaries',()=>{
 it('allows ten atomic meal claims but still stops other kinds at three',async()=>{
  for(const kind of ['meal-extract','collect']){
   const id=`claims:${kind}`;await enqueue(db.env,id,kind,{});const max=kind==='meal-extract'?10:3;
   for(let i=1;i<=max;i++){
    const job=await claim(db.env,id);expect(job!.attempts).toBe(i);expect(await claim(db.env,id)).toBeNull();
    await retryJob(db.env,job!,'rejected',1);vi.advanceTimersByTime(1000);
   }
   expect(await claim(db.env,id)).toBeNull();
   expect(db.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get(id)!.state).toBe(kind==='meal-extract'?'needs_review':'failed');
  }
 });
 it('excludes only explicitly confirmed-rejected reservations while preserving records and unknown reservations',async()=>{
  await reserveLlm(db.env,'released','2026-10-10');await reserveLlm(db.env,'unknown','2026-10-10');
  db.sqlite.prepare("UPDATE llm_usage SET state='confirmed_rejected',reserved_usd=0 WHERE id='released'").run();
  db.sqlite.prepare("UPDATE llm_usage SET state='rejected' WHERE id='unknown'").run();
  expect(await reserveLlm(db.env,'fresh','2026-10-10')).toBe(true);
  expect(await reserveLlm(db.env,'blocked','2026-10-10')).toBe(false);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM llm_usage').get()!.n).toBe(3);
  expect(db.sqlite.prepare("SELECT state,reserved_usd,actual_usd FROM llm_usage WHERE id='unknown'").get()).toMatchObject({state:'rejected',reserved_usd:0.25,actual_usd:null});
  expect(await reserveLlm(db.env,'released','2026-10-10')).toBe(false);
 });
});
