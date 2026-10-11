import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {mealWindow,pruneMealContent,cacheMealSources,mealImageSource,type MealSource} from '../src/meal-cache';
const source=(start='2026-10-12',end='2026-10-18',id='123',published='2026-10-08'):MealSource=>({url:`https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=${id}`,imageUrl:`https://scc.sogang.ac.kr/dataview/board/1185/${id}.jpg`,start,end,published});
let db:ReturnType<typeof testDatabase>;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T15:00:00Z'));db=testDatabase();});
afterEach(()=>{db.close();vi.useRealTimers();});
describe('bounded current/upcoming meal content',()=>{
 it('uses KST Monday boundaries across months and years',()=>{
  expect(mealWindow()).toEqual({start:'2026-10-12',end:'2026-10-25'});
  expect(mealWindow('2026-10-11')).toEqual({start:'2026-10-05',end:'2026-10-18'});
  expect(mealWindow('2026-12-31')).toEqual({start:'2026-12-28',end:'2027-01-10'});
  expect(mealWindow('2027-01-04')).toEqual({start:'2027-01-04',end:'2027-01-17'});
  expect(()=>mealWindow('2026-02-30')).toThrow();
 });
 it('caches only retained periods and returns only a matching current/upcoming image',async()=>{
  await cacheMealSources(db.env,[source(),source('2026-10-19','2026-10-25','124','2026-10-15'),source('2026-10-05','2026-10-11','125','2026-10-01'),source('2026-10-26','2026-11-01','126','2026-10-22')]);
  expect(db.sqlite.prepare('SELECT COUNT(*) n FROM meal_sources').get()!.n).toBe(2);
  expect((await mealImageSource(db.env,'2026-10-12'))?.imageUrl).toContain('123.jpg');
  expect((await mealImageSource(db.env,'2026-10-25'))?.imageUrl).toContain('124.jpg');
  for(const date of ['2026-10-11','2026-10-26','invalid'])expect(await mealImageSource(db.env,date)).toBeNull();
 });
 it('preserves last-good capture on invalid input and ignores older repeated captures',async()=>{
  await cacheMealSources(db.env,[source()]);const original=db.sqlite.prepare('SELECT * FROM meal_sources').get();
  await expect(cacheMealSources(db.env,[source('2026-10-19','2026-10-25','124','2026-10-15'),{...source(),imageUrl:'https://example.com/x.jpg'}])).rejects.toThrow();
  expect(db.sqlite.prepare('SELECT * FROM meal_sources').all()).toEqual([original]);
  await cacheMealSources(db.env,[source('2026-10-12','2026-10-18','122','2026-10-07')]);expect(db.sqlite.prepare('SELECT * FROM meal_sources').get()).toEqual(original);
  await cacheMealSources(db.env,[source('2026-10-12','2026-10-18','127','2026-10-09')]);expect(db.sqlite.prepare('SELECT source_url FROM meal_sources').get()!.source_url).toContain('127');
 });
 it('prunes only meal content, preserving audit identity, jobs, attempts and usage/notices',async()=>{
  const periods=[['old','2026-10-05','2026-10-11'],['current','2026-10-12','2026-10-18'],['next','2026-10-19','2026-10-25'],['future','2026-10-26','2026-11-01']];
  for(const [id,start,end] of periods){
   db.sqlite.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'source','hash','v1',start,end,JSON.stringify({start,end,days:['derived']}),'at','at','model:free');
   db.sqlite.prepare('INSERT INTO meal_sources VALUES(?,?,?,?,?,?)').run(id,'image','2026-10-01',start,end,'at');
   db.sqlite.prepare('INSERT INTO jobs(id,kind,payload,state,attempts,created_at,available_at,error) VALUES(?,?,?,?,?,?,?,?)').run(id,'meal-extract',JSON.stringify({key:id,rejectedExtraction:{cacheKey:id,startDate:start,endDate:end,data:{start,end,days:['rejected']},model:'model:free',reason:'rejected'}}),'needs_review',9,'at','at','original error');
  }
  db.sqlite.prepare('INSERT INTO notices VALUES(?,?,?,?,?,?)').run('university','1','notice','2026-01-01','url','at');
  db.sqlite.prepare('INSERT INTO llm_usage VALUES(?,?,?,?,?,?)').run('old','2026-10-10',.25,null,'reserved','at');
  const ledger=db.sqlite.prepare('SELECT * FROM llm_usage').all(),notice=db.sqlite.prepare('SELECT * FROM notices').all(),jobs=db.sqlite.prepare('SELECT id,state,attempts,error FROM jobs ORDER BY id').all();
  await pruneMealContent(db.env);await pruneMealContent(db.env);
  expect(db.sqlite.prepare('SELECT cache_key FROM meals ORDER BY cache_key').all().map(r=>r.cache_key)).toEqual(['current','next']);
  expect(db.sqlite.prepare('SELECT source_url FROM meal_sources ORDER BY source_url').all().map(r=>r.source_url)).toEqual(['current','next']);
  for(const [id] of periods){const payload=JSON.parse(String(db.sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get(id)!.payload));expect(payload.key).toBe(id);expect(payload.rejectedExtraction.cacheKey).toBe(id);expect(payload.rejectedExtraction.reason).toBe('rejected');expect('data' in payload.rejectedExtraction).toBe(['current','next'].includes(id));}
  expect(db.sqlite.prepare('SELECT id,state,attempts,error FROM jobs ORDER BY id').all()).toEqual(jobs);expect(db.sqlite.prepare('SELECT * FROM llm_usage').all()).toEqual(ledger);expect(db.sqlite.prepare('SELECT * FROM notices').all()).toEqual(notice);
 });
 it('does not serve an expired source even before maintenance has pruned it',async()=>{
  db.sqlite.prepare('INSERT INTO meal_sources VALUES(?,?,?,?,?,?)').run('old','image','2026-10-01','2026-10-05','2026-10-11','at');
  expect(await mealImageSource(db.env,'2026-10-11')).toBeNull();expect(await mealImageSource(db.env,'2026-10-12')).toBeNull();
 });
});
