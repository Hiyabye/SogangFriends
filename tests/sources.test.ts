import {readFileSync} from 'node:fs';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {SOURCES,parseUniversity,parseComputing,parseMealList,parseMealImage,mealPeriod,sourceBytes,fetchImage} from '../src/sources';
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8');
// Discovery's module-local pacer and its calendar clock must start together.
async function mealDiscovery(){
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
 vi.resetModules();return import('../src/sources');
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('official source adapters with synthetic fixtures',()=>{
 it('uses official ID, sorts by publication not pinned position',()=>{const n=parseUniversity(JSON.parse(fixture('university.json')));expect(n.map(x=>x.id)).toEqual(['11','10']);expect(n[0].url).toBe('https://www.sogang.ac.kr/ko/detail/11?bbsConfigFk=2');});
 it.each([['universityStudent',34],['universityScholarship',141],['universityGeneral',1],['universityEvent',142],['universityOnestop',3]])('binds %s list rows and canonical URLs to board %s',(id,config)=>{
  const source=SOURCES.find(s=>s.id===id)!;const value=JSON.parse(fixture('university.json'));
  for(const row of value.data.list)row.configId=config;
  const notices=parseUniversity(value,source);expect(notices).toHaveLength(2);
  expect(notices[0]).toMatchObject({source:id,url:`https://www.sogang.ac.kr/ko/detail/11?bbsConfigFk=${config}`});
  expect(()=>parseUniversity(value,SOURCES[0])).toThrow('university row');
  expect(()=>parseUniversity(value,{...source,url:source.url.replace(`bbsConfigFk=${config}`, 'bbsConfigFk=2')})).toThrow('Unknown university');
 });
 it('rejects invalid dates, duplicate IDs, config mismatch and malformed empty data',()=>{const f=JSON.parse(fixture('university.json'));f.data.list[0].regDate='20260230090000';expect(()=>parseUniversity(f)).toThrow();const d=JSON.parse(fixture('university.json'));d.data.list[1].pkId=10;expect(()=>parseUniversity(d)).toThrow();expect(()=>parseUniversity({statusCode:200,data:{list:[],total:4,pageNum:1}})).toThrow();expect(()=>parseUniversity({statusCode:200,data:{list:[{pkId:1,configId:3,regDate:'20261001000000',isTop:'N',title:'Wrong'}],total:1,pageNum:1}})).toThrow();});
 it.each([NaN,Infinity,-Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid university total %s',total=>{
  const value=JSON.parse(fixture('university.json'));value.data.total=total;
  expect(()=>parseUniversity(value)).toThrow('Unexpected university response');
 });
 it('accepts a validated empty university board with zero total',()=>{
  expect(parseUniversity({statusCode:200,data:{list:[],total:0,pageNum:1}})).toEqual([]);
 });
 it('supports the graduate and news boards with independent IDs and strict board identity',()=>{
  for(const [id,heading] of [['graduateNotice','대학원 공지'],['news','소식']]){
   const source=SOURCES.find(s=>s.id===id)!;
   const html=fixture('computing.html').replaceAll('academicNotice',id).replaceAll('학사 공지',heading);
   const parsed=parseComputing(html,source);expect(parsed.notices[0].source).toBe(id);
   expect(parsed.notices[0].url).toBe(`https://computing.sogang.ac.kr/ko/community/${id}/detail/1`);
   expect(parsed.regularIds).toEqual(['2']);expect(()=>parseComputing(html,SOURCES[1])).toThrow();
  }
 });
 it('normalizes computing links and separates pins from regular rows',()=>{const p=parseComputing(fixture('computing.html'),SOURCES[1]);expect(p.regularIds).toEqual(['2']);expect(p.notices[0].url).not.toContain('?');expect(()=>parseComputing(fixture('computing.html'),SOURCES[2])).toThrow();});
 it('rejects filtered/foreign/malformed computing pages',()=>{const h=fixture('computing.html');expect(()=>parseComputing(h.replace('>전체<','>컴퓨터공학과<'),SOURCES[1])).toThrow();expect(()=>parseComputing(h.replace('/detail/2?','/detail/1?'),SOURCES[1])).toThrow();expect(()=>parseComputing('<html>login</html>',SOURCES[1])).toThrow();expect(()=>parseComputing(h.replace('2026.10.08','2026.02.30'),SOURCES[1])).toThrow();});
 it('rejects any active computing filter even when the all-category button is first',()=>{
  const html=fixture('computing.html').replace('</header>','<button aria-pressed="true">컴퓨터공학과</button></header>');
  expect(()=>parseComputing(html,SOURCES[1])).toThrow('Filtered board');
 });
 it('finds CMS article via full-title comment and validates image path and post identity',()=>{const a=parseMealList(fixture('meal-list.html'))[0];expect(a.start).toBe('2026-10-12');expect(parseMealImage(fixture('meal-article.html'),a)).toBe('https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg');expect(()=>parseMealImage(fixture('meal-article.html').replace('value="123"','value="124"'),a)).toThrow();expect(()=>parseMealImage(fixture('meal-article.html').replace('/board/1185/','/board/999/'),a)).toThrow();});
 it('preserves DOM order through repeated traversals',()=>{const h=fixture('meal-list.html');const row=h.match(/<li>.*<\/li>/)![0];const older=row.replaceAll('123','124').replaceAll('12일 ~ 10월 18일','5일 ~ 10월 11일').replace('2026.10.08','2026.10.01');const parsed=parseMealList(h.replace('</ul>',older+'</ul>'));expect(parsed.map(x=>new URL(x.url).searchParams.get('pkid'))).toEqual(['123','124']);});
 it('infers title year only when unambiguous and handles year rollover',()=>{expect(mealPeriod('12월 28일 ~ 1월 3일 식단','2026-12-24')).toEqual({start:'2026-12-28',end:'2027-01-03'});expect(()=>mealPeriod('10월 12일 ~ 10월 19일 식단','2026-10-08')).toThrow();expect(()=>mealPeriod('10월 12일 ~ 10월 18일 식단','2025-04-01')).toThrow();expect(()=>mealPeriod('8월 27일 ~ 8월 30일 식단','2026-08-11')).toThrow('Ambiguous meal period');});
 it('rejects disallowed hosts without fetching',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(sourceBytes('https://example.com/x')).rejects.toThrow('Disallowed');expect(fetcher).not.toHaveBeenCalled();});
 it('uses Workers-compatible manual redirects and never follows a source redirect',async()=>{
  const fetcher=vi.fn(async(_url:unknown,options?:RequestInit)=>{
   expect(options?.redirect).toBe('manual');
   return new Response(null,{status:302,headers:{location:'https://example.com/untrusted'}});
  });vi.stubGlobal('fetch',fetcher);
  await expect(sourceBytes(SOURCES[0].url)).rejects.toThrow('Source HTTP 302');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each([false,true])('cancels failed HTTP bodies and preserves their typed error (cancel rejects: %s)',async(rejectCancel)=>{
  const cancel=vi.fn(()=>{if(rejectCancel)throw new Error('Cancellation failed');});
  const body=new ReadableStream<Uint8Array>({cancel});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:429,headers:{'retry-after':'120'}})));
  await expect(sourceBytes(SOURCES[0].url)).rejects.toMatchObject({name:'SourceHttpError',status:429,message:'Source HTTP 429',retryAfter:120});
  expect(cancel).toHaveBeenCalledTimes(1);
 });
 it('bounds streaming response even without Content-Length',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array(10),{headers:{'content-type':'text/html'}})));await expect(sourceBytes(SOURCES[0].url,5)).rejects.toThrow('too large');});
 it('rejects image format spoofing',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('not an image',{headers:{'content-type':'image/jpeg'}})));await expect(fetchImage('https://scc.sogang.ac.kr/dataview/board/1185/fake.jpg')).rejects.toThrow('Invalid image');});
 it('discovers current and upcoming sources once each, choosing the latest per period',async()=>{
  const {discoverMealSources}=await mealDiscovery();const starts:number[]=[];
  const list=fixture('meal-list.html'),row=list.match(/<li>.*<\/li>/)![0];
  const newest=row.replaceAll('123','125').replace('2026.10.08','2026.10.09');
  const next=row.replaceAll('123','124').replaceAll('12일 ~ 10월 18일','19일 ~ 10월 25일').replace('2026.10.08','2026.10.10');
  const fetcher=vi.fn(async(url:unknown)=>{
   starts.push(Date.now());const u=new URL(String(url));
   if(u.pathname.endsWith('cmsboardlist.do')){if(u.searchParams.get('currentPage')!=='1')throw new Error('Older history must not be fetched');return new Response(list.replace('</ul>',newest+next+'</ul>'),{headers:{'content-type':'text/html'}});}
   const id=u.searchParams.get('pkid')!;let article=fixture('meal-article.html').replaceAll('123',id).replace('synthetic.jpg',`${id}.jpg`);
   if(id==='124')article=article.replaceAll('12일 ~ 10월 18일','19일 ~ 10월 25일');
   return new Response(article,{headers:{'content-type':'text/html'}});
  });vi.stubGlobal('fetch',fetcher);
  const pending=discoverMealSources();await vi.runAllTimersAsync();const result=await pending;
  expect(result.map(r=>r.start).sort()).toEqual(['2026-10-12','2026-10-19']);expect(result.find(r=>r.start==='2026-10-12')!.url).toContain('125');expect(fetcher).toHaveBeenCalledTimes(3);
  expect(starts).toEqual([Date.parse('2026-10-13T00:00:00Z'),Date.parse('2026-10-13T00:00:01Z'),Date.parse('2026-10-13T00:00:02Z')]);
 });
 it('returns the current source without inventing an unpublished next week',async()=>{
  const {discoverMealSources}=await mealDiscovery();
  const fetcher=vi.fn(async(url:unknown)=>{
   const u=new URL(String(url));
   if(u.pathname.endsWith('cmsboardlist.do')&&u.searchParams.get('currentPage')!=='1')throw new Error('Unrelated historical page must not be fetched');
   return new Response(fixture(u.pathname.endsWith('cmsboardlist.do')?'meal-list.html':'meal-article.html'),{headers:{'content-type':'text/html'}});
  });vi.stubGlobal('fetch',fetcher);
  const pending=discoverMealSources();await vi.runAllTimersAsync();
  expect((await pending).map(r=>r.start)).toEqual(['2026-10-12']);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('does not resolve images for stale-only source lists',async()=>{
  const {discoverMealSources}=await mealDiscovery();
  const stale=fixture('meal-list.html').replaceAll('12일 ~ 10월 18일','5일 ~ 10월 11일').replace('2026.10.08','2026.10.01');
  const fetcher=vi.fn(async(url:unknown)=>{expect(String(url)).toContain('cmsboardlist.do');return new Response(stale,{headers:{'content-type':'text/html'}});});vi.stubGlobal('fetch',fetcher);
  const pending=discoverMealSources();await vi.runAllTimersAsync();
  expect(await pending).toEqual([]);expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
