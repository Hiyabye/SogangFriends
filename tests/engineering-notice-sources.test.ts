import {afterEach,describe,expect,it,vi} from 'vitest';
import {ENGINEERING_NOTICE_SOURCES,engineeringDetailUrl,engineeringPageUrl,parseEngineeringNoticePage} from '../src/engineering-notice-sources';
import {noticeDetailUrl} from '../src/legacy-notice-sources';
import {parseNoticePage,parseNoticeRaw} from '../src/notice-archive-sources';
import {validateNoticeSnapshot} from '../src/notice-ingest';
import type {Source} from '../src/types';

// Original synthetic fixtures model the official Engineering list/post HTML.
function identity(source:Source,url=source.url):string{return `<link rel="canonical" href="${url}"><h1 class="subvis-title">${source.name.slice(5)}</h1><nav class="subnav"><a href="${new URL(source.url).pathname}" aria-current="page">board</a></nav>`;}
function page(source:Source,p=1,regularTotal=23,pins=2):string{
 const last=Math.ceil(regularTotal/10),count=Math.max(0,Math.min(10,regularTotal-(p-1)*10));
 const row=(id:number,ordinal:number,pinned=false)=>`<li class="brow${pinned?' is-notice':''}"><span class="c-no">${pinned?'<em class="badge">공지</em>':ordinal}</span><a class="c-title" href="${new URL(engineeringDetailUrl(source,String(id))).pathname}"><span>Notice ${id} &amp; detail</span><small class="c-due">10.23까지</small><svg aria-label="첨부파일"></svg></a><span class="c-date">2026.10.09</span></li>`;
 const rows=(p===1?Array.from({length:pins},(_,i)=>row(990+i,0,true)).join(''):'')+Array.from({length:count},(_,i)=>row(1000-p*100-i,regularTotal-(p-1)*10-i)).join('');
 const link=(n:number,label='')=>`<a href="${new URL(source.url).pathname}?page=${n}"${label?` aria-label="${label}"`:''}>${n}</a>`;
 const pager=last>1?`<nav class="pager"><strong aria-current="page">${p}</strong>${p<last?link(p+1,'다음글')+link(last,'last'):link(1,'first')+link(p-1,'이전글')}</nav>`:'';
 return `${identity(source,p===1?source.url:engineeringPageUrl(source,p))}<div class="board board--list"><div class="board-top"><p class="board-total">전체 <b>${regularTotal+pins}</b>건</p><form class="board-search" method="get" action="${new URL(source.url).pathname}"><select name="field"><option value="all" selected>제목+내용</option><option value="title">제목</option></select><input type="search" name="q" value=""></form></div><ul class="blist"><li class="brow brow-head"><span>header</span></li>${rows}</ul>${pager}</div>`;
}
const body='\n <p data-original="yes">Body &amp; content</p><img src="/images/a.png"><img src="file:///author/local.png"><img src="data:image/png;base64,AAAA"><a href="../file.pdf">file</a><a href="https://example.test/info">ordinary link</a>\n';
function detail(source:Source,id='900'):string{return `${identity(source,engineeringDetailUrl(source,id))}<article class="post"><header class="post-head"><h2 class="post-title">Notice ${id} &amp; detail</h2><ul class="post-meta"><li><span class="sr-only">작성일</span><time datetime="2026-10-08T23:30:00.000Z">2026.10.09 08:30</time></li></ul></header><div class="post-files"><p class="post-files-t">첨부파일 <b>1</b></p><ul><li><a href="/download/845" download>file.hwp</a><a class="post-file-view" href="/download/845?view=1">preview</a></li></ul></div><div class="content post-body">${body}</div></article>`;}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('Engineering official boards',()=>{
 it.each(ENGINEERING_NOTICE_SOURCES)('parses $id source-bound identity, titles, dates and first-page pins',source=>{
  const parsed=parseEngineeringNoticePage(page(source),source);expect(parsed.notices).toHaveLength(12);expect(parsed.regularCount).toBe(10);expect(parsed.done).toBe(false);
  expect(parsed.notices[0]).toEqual({id:'990',source:source.id,title:'Notice 990 & detail',published:'2026-10-09',url:engineeringDetailUrl(source,'990')});
  expect(noticeDetailUrl(source,'990')).toBe(engineeringDetailUrl(source,'990'));
  expect(validateNoticeSnapshot({source:source.id,notices:parsed.notices}).notices).toEqual(parsed.notices);
  for(const other of ENGINEERING_NOTICE_SOURCES.filter(s=>s!==source))expect(()=>parseNoticePage(page(source),other,1)).toThrow();
  expect(parseEngineeringNoticePage(page(source).replace(`rel="canonical" href="${source.url}"`,`rel="canonical" href="${engineeringPageUrl(source,1)}"`),source).notices).toEqual(parsed.notices);
  const second=parseEngineeringNoticePage(page(source,2),source,2);expect(second.notices).toHaveLength(10);expect(second.regularIds).not.toContain('990');expect(second.done).toBe(false);
  const final=parseNoticePage(page(source,3),source,3);expect(final.done).toBe(true);expect(final.notices).toHaveLength(3);
  expect(parseNoticePage(page(source,1,5,0),source,1)).toMatchObject({done:true,notices:expect.any(Array)});
 });
 it('rejects filters, malformed/foreign links and conflicting coverage rather than treating them as EOF',()=>{
  const source=ENGINEERING_NOTICE_SOURCES[0],html=page(source);
  for(const changed of [
   html.replace('name="q" value=""','name="q" value="filter"'),
   html.replace('value="all" selected','value="title" selected'),
   html.replace('2026.10.09','2026.02.30'),
   html.replace('/board/notice/900','/board/recruit/900'),
   html.replace('/board/notice/900','https://attacker.test/board/notice/900'),
   html.replace('/board/notice/900','/board/notice/900?extra=1'),
   html.replace('/board/notice/900','/board/notice/899'),
   html.replace('<span class="c-no">22</span>','<span class="c-no">19</span>'),
   html.replace('전체 <b>25</b>','전체 <b>26</b>'),
   html.replace('?page=2" aria-label="다음글"','?page=3" aria-label="다음글"'),
   html.replace('?page=3" aria-label="last"','?page=4" aria-label="last"'),
   html.replace('class="pager"','class="missing"'),
  ])expect(()=>parseNoticePage(changed,source,1)).toThrow();
  expect(()=>parseNoticePage(html,source,2)).toThrow();
  expect(()=>parseNoticePage(page(source,4),source,4)).toThrow('empty');
  expect(()=>parseNoticePage(page(source,1,0,0),source,1)).toThrow('empty');
  expect(()=>parseNoticePage(page(source,1,5,0),source,2)).toThrow();
  expect(()=>engineeringPageUrl({...source,url:source.url+'?q=x'},1)).toThrow();
  expect(()=>engineeringPageUrl(source,0)).toThrow();
  expect(()=>engineeringDetailUrl(source,'01')).toThrow();
  const final=page(source,3).replace('<span class="c-no">1</span>','<span class="c-no">2</span>');expect(()=>parseNoticePage(final,source,3)).toThrow();
 });
 it.each(ENGINEERING_NOTICE_SOURCES)('archives $id exact original HTML, KST evidence and proven attachment references',source=>{
  const notice=parseNoticePage(page(source),source,1).notices.find(n=>n.id==='900')!;
  const html=detail(source),raw=parseNoticeRaw(html,notice);
  expect(raw.bodyHtml).toBe(body);expect(raw.imageUrls).toEqual(['https://eng.sogang.ac.kr/images/a.png']);
  expect(raw.attachments).toEqual(['https://eng.sogang.ac.kr/download/845',new URL('../file.pdf',notice.url).href]);
  for(const changed of [html.replace(`/board/${source.url.split('/').at(-1)}/900`,`/board/${source.url.split('/').at(-1)}/901`),html.replace('Notice 900','Changed'),html.replace('2026.10.09 08:30','2026.10.08 08:30'),html.replace('2026-10-08T23:30','2026-10-09T23:30'),html.replace('href="/download/845"','href="https://attacker.test/download/845"'),html.replace('첨부파일 <b>1</b>','첨부파일 <b>2</b>'),html.replace('src="/images/a.png"','src="javascript:bad"')])expect(()=>parseNoticeRaw(changed,notice)).toThrow();
  expect(()=>parseNoticeRaw(html,{...notice,url:notice.url+'?page=1'})).toThrow();
 });
 it('uses three paced HTML pages for recent collection and source-bound archive page/detail transport',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));vi.resetModules();
  const {collectNotices}=await import('../src/sources');const {collectNoticePage,collectNoticeRaw}=await import('../src/notice-archive-sources');
  const starts:number[]=[],urls:string[]=[];const source=ENGINEERING_NOTICE_SOURCES[0];
  const fetcher=vi.fn(async(value:unknown,options?:RequestInit)=>{const u=new URL(String(value));urls.push(u.href);starts.push(Date.now());expect(options?.redirect).toBe('manual');expect(options?.method??'GET').toBe('GET');return new Response(u.pathname.endsWith('/900')?detail(source):page(source,Number(u.searchParams.get('page')),45),{headers:{'content-type':'text/html;charset=utf-8'}});});vi.stubGlobal('fetch',fetcher);
  const pending=collectNotices(source);await vi.runAllTimersAsync();const notices=await pending;expect(notices).toHaveLength(32);expect(fetcher).toHaveBeenCalledTimes(3);expect(urls).toEqual([1,2,3].map(p=>engineeringPageUrl(source,p)));
  const archive=collectNoticePage(source,5);await vi.runAllTimersAsync();expect((await archive).done).toBe(true);
  const raw=collectNoticeRaw(notices.find(n=>n.id==='900')!);await vi.runAllTimersAsync();expect((await raw).bodyHtml).toBe(body);
  expect(starts.every((start,i)=>!i||start-starts[i-1]>=1000)).toBe(true);
 });
 it('stops recent collection on proven single-page history and propagates malformed pages or transport failures',async()=>{
  vi.useFakeTimers();vi.resetModules();const {collectNotices}=await import('../src/sources');const source=ENGINEERING_NOTICE_SOURCES[2];
  const fetcher=vi.fn(async()=>new Response(page(source,1,5,0),{headers:{'content-type':'text/html'}}));vi.stubGlobal('fetch',fetcher);
  const pending=collectNotices(source);await vi.runAllTimersAsync();expect(await pending).toHaveLength(5);expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async()=>new Response('malformed',{headers:{'content-type':'text/html'}}));const malformed=expect(collectNotices(source)).rejects.toThrow();await vi.runAllTimersAsync();await malformed;
  fetcher.mockImplementation(async()=>new Response('unavailable',{status:503}));const failed=expect(collectNotices(source)).rejects.toThrow('HTTP 503');await vi.runAllTimersAsync();await failed;
 });
});
