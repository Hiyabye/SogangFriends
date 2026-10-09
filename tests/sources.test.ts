import {readFileSync} from 'node:fs';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {SOURCES,parseUniversity,parseComputing,parseMealList,parseMealImage,mealPeriod,sourceBytes,fetchImage,discoverMeal} from '../src/sources';
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8');
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('official source adapters with synthetic fixtures',()=>{
 it('uses official ID, sorts by publication not pinned position',()=>{const n=parseUniversity(JSON.parse(fixture('university.json')));expect(n.map(x=>x.id)).toEqual(['11','10']);expect(n[0].url).toBe('https://www.sogang.ac.kr/ko/detail/11?bbsConfigFk=2');});
 it('rejects invalid dates, duplicate IDs, config mismatch and malformed empty data',()=>{const f=JSON.parse(fixture('university.json'));f.data.list[0].regDate='20260230090000';expect(()=>parseUniversity(f)).toThrow();const d=JSON.parse(fixture('university.json'));d.data.list[1].pkId=10;expect(()=>parseUniversity(d)).toThrow();expect(()=>parseUniversity({statusCode:200,data:{list:[],total:4,pageNum:1}})).toThrow();expect(()=>parseUniversity({statusCode:200,data:{list:[{pkId:1,configId:3,regDate:'20261001000000',isTop:'N',title:'Wrong'}],total:1,pageNum:1}})).toThrow();});
 it('normalizes computing links and separates pins from regular rows',()=>{const p=parseComputing(fixture('computing.html'),SOURCES[1]);expect(p.regularIds).toEqual(['2']);expect(p.notices[0].url).not.toContain('?');expect(()=>parseComputing(fixture('computing.html'),SOURCES[2])).toThrow();});
 it('rejects filtered/foreign/malformed computing pages',()=>{const h=fixture('computing.html');expect(()=>parseComputing(h.replace('>전체<','>컴퓨터공학과<'),SOURCES[1])).toThrow();expect(()=>parseComputing(h.replace('/detail/2?','/detail/1?'),SOURCES[1])).toThrow();expect(()=>parseComputing('<html>login</html>',SOURCES[1])).toThrow();expect(()=>parseComputing(h.replace('2026.10.08','2026.02.30'),SOURCES[1])).toThrow();});
 it('finds CMS article via full-title comment and validates image path and post identity',()=>{const a=parseMealList(fixture('meal-list.html'))[0];expect(a.start).toBe('2026-10-12');expect(parseMealImage(fixture('meal-article.html'),a)).toBe('https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg');expect(()=>parseMealImage(fixture('meal-article.html').replace('value="123"','value="124"'),a)).toThrow();expect(()=>parseMealImage(fixture('meal-article.html').replace('/board/1185/','/board/999/'),a)).toThrow();});
 it('preserves DOM order through repeated traversals',()=>{const h=fixture('meal-list.html');const row=h.match(/<li>.*<\/li>/)![0];const older=row.replaceAll('123','124').replaceAll('12일 ~ 10월 18일','5일 ~ 10월 11일').replace('2026.10.08','2026.10.01');const parsed=parseMealList(h.replace('</ul>',older+'</ul>'));expect(parsed.map(x=>new URL(x.url).searchParams.get('pkid'))).toEqual(['123','124']);});
 it('infers title year only when unambiguous and handles year rollover',()=>{expect(mealPeriod('12월 28일 ~ 1월 3일 식단','2026-12-24')).toEqual({start:'2026-12-28',end:'2027-01-03'});expect(()=>mealPeriod('10월 12일 ~ 10월 19일 식단','2026-10-08')).toThrow();expect(()=>mealPeriod('10월 12일 ~ 10월 18일 식단','2025-04-01')).toThrow();});
 it('rejects disallowed hosts without fetching',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(sourceBytes('https://example.com/x')).rejects.toThrow('Disallowed');expect(fetcher).not.toHaveBeenCalled();});
 it('uses Workers-compatible manual redirects and never follows a source redirect',async()=>{
  const fetcher=vi.fn(async(_url:unknown,options?:RequestInit)=>{
   expect(options?.redirect).toBe('manual');
   return new Response(null,{status:302,headers:{location:'https://example.com/untrusted'}});
  });vi.stubGlobal('fetch',fetcher);
  await expect(sourceBytes(SOURCES[0].url)).rejects.toThrow('Source HTTP 302');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('bounds streaming response even without Content-Length',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array(10),{headers:{'content-type':'text/html'}})));await expect(sourceBytes(SOURCES[0].url,5)).rejects.toThrow('too large');});
 it('rejects image format spoofing',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('not an image',{headers:{'content-type':'image/jpeg'}})));await expect(fetchImage('https://scc.sogang.ac.kr/dataview/board/1185/fake.jpg')).rejects.toThrow('Invalid image');});
 it('stops paging after a validated current week and still rejects historical partial weeks',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-13T00:00:00Z'));
  const fetcher=vi.fn(async(url:unknown)=>{
   const u=new URL(String(url));
   if(u.pathname.endsWith('cmsboardlist.do')){
    if(u.searchParams.get('currentPage')!=='1')throw new Error('Unrelated historical page must not be fetched');
    return new Response(fixture('meal-list.html'),{headers:{'content-type':'text/html'}});
   }
   return new Response(fixture('meal-article.html'),{headers:{'content-type':'text/html'}});
  });vi.stubGlobal('fetch',fetcher);
  expect((await discoverMeal()).start).toBe('2026-10-12');expect(fetcher).toHaveBeenCalledTimes(2);
  expect(()=>mealPeriod('8월 27일 ~ 8월 30일 식단','2026-08-11')).toThrow('Ambiguous meal period');
 });
});
