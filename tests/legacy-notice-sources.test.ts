import {afterEach,describe,expect,it,vi} from 'vitest';
import {ADDITIONAL_NOTICE_SOURCES,noticeDetailUrl,legacyNoticePageUrl,parseLegacyNoticePage} from '../src/legacy-notice-sources';
import {parseNoticePage,parseNoticeRaw} from '../src/notice-archive-sources';
import {validateNoticeSnapshot} from '../src/notice-ingest';
import {saveNotices} from '../src/storage';
import {testDatabase} from './helpers/db';
import type {Source} from '../src/types';

// Original synthetic fixtures model the observed CMS and WebSTYLIST structures.
const inputs=(s:Source,id?:string)=>{const u=new URL(s.url);return (s.kind==='cms'?[['bbsConfigFK',u.searchParams.get('bbsConfigFK')],['siteId',u.searchParams.get('siteId')]]:[['bbsid','5256'],['wslID','bdata']]).concat(id?[['pkid',id]]:[]).map(([key,value])=>`<input name="${key}" value="${value}">`).join('')+'<input name="searchValue" value="">';};
function page(s:Source,p=1,last=1,count=2,pin=true):string{
 const cms=s.kind==='cms';const row=(id:number,ordinal:number,pinned=false)=>{const u=new URL(noticeDetailUrl(s,String(id)));u.searchParams.set('currentPage',String(p));const a=`<a ${cms?'class="title"':''} href="${u.href}">${pinned?'<strong>[공지] </strong>':''}Notice ${id}</a>`;
  return cms?`<li><div style="display: flex;">${pinned?'':`<div>${ordinal}</div>`}<div>${a}<div class="info"><span>Fixture</span><span>2026.10.09</span><span>5</span></div></div></div></li>`:`<tr><td>${ordinal}</td><td><div class="subject">${a}</div></td><td>Fixture</td><td></td><td>2026.10.09</td><td>5</td></tr>`;
 };
 const rows=(cms&&pin?row(999,0,true):'')+Array.from({length:count},(_,i)=>row(1000-p*100-i,p===last?count-i:200-i)).join('');
 const onclick=`onclick="sendPage('pageForm','${last}');return false;"`;
 return inputs(s)+(cms?`<div class="list_box"><ul>${rows}</ul></div><div class="board_paging"><ul><li class="on"><a><span>${p}</span></a></li></ul><div class="total_cnt">/ ${last}</div><li class="btn_last"><a ${onclick}>last</a></li></div>`:`<div class="bbs-list"><table><tbody>${rows}</tbody></table></div><div class="pagination"><div class="pagination"><div class="align"><span class="current">${p}</span><a class="last" ${onclick}>last</a></div></div></div>`);
}
function detail(s:Source,id='900'):string{
 const body='<p data-original="yes">Body &amp; content</p><img src="/images/example.png"><a href="/file.pdf">file</a>';
 const file='<a href="/Download?pathStr=fixture&amp;fileName=fixture.hwp&amp;gubun=board">attachment</a>';
 return inputs(s,id)+(s.kind==='cms'?`<div class="board_read_wrap"><div class="post_info"><div class="title">Notice ${id}</div><div class="info"><span>Fixture</span><span>2026.10.09 10:00:00</span></div></div><div class="post_cont">${body}</div><div class="post_file">${file}</div></div>`:`<div class="bbs-read"><div class="subject">Notice ${id}</div><div class="unit"><span class="label">작성일</span><span class="value">2026.10.09</span></div><div class="substance">${body}</div></div><div class="bbs-attachment">${file}</div>`);
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('additional official notice boards',()=>{
 it.each(ADDITIONAL_NOTICE_SOURCES)('parses $id and preserves official identities, KST dates and canonical links',s=>{
  const result=parseNoticePage(page(s),s,1);expect(result.done).toBe(true);expect(result.notices).toHaveLength(s.kind==='cms'?3:2);
  expect(result.notices[0]).toMatchObject({source:s.id,published:'2026-10-09'});
  if(s.kind==='cms')expect(result.notices[0].title).toBe('Notice 999');
  expect(validateNoticeSnapshot({source:s.id,notices:result.notices}).notices).toEqual(result.notices);
  for(const n of result.notices){expect(n.url).toBe(noticeDetailUrl(s,n.id));for(const url of [n.url.replace('https:','http:'),n.url+'&currentPage=1',n.url.replace('pkid=','other=')])expect(()=>validateNoticeSnapshot({source:s.id,notices:[{...n,url}]})).toThrow();}
 });
 it('recovers full CMS titles from encoded comments instead of archiving a truncated visible title',()=>{
  const s=ADDITIONAL_NOTICE_SOURCES[2];const html=page(s).replace('Notice 900','<!-- AI &#39RADAI&#39 &amp; future <research> full title -->AI ...');const notice=parseNoticePage(html,s,1).notices.find(n=>n.id==='900')!;
  expect(notice.title).toBe("AI 'RADAI' & future <research> full title");expect(parseNoticeRaw(detail(s).replace('Notice 900',"AI 'RADAI' &amp; future &lt;research&gt; full title"),notice).bodyHtml).toContain('Body');
 });
 it.each(ADDITIONAL_NOTICE_SOURCES)('validates $id history pagination, board identity and malformed rows',s=>{
  const html=page(s);expect(()=>parseNoticePage(html,s,2)).toThrow('page number');
  expect(()=>parseNoticePage(html.replace(s.kind==='cms'?'value="'+new URL(s.url).searchParams.get('bbsConfigFK')+'"':'value="5256"','value="9999"'),s,1)).toThrow('board/post');
  expect(()=>parseNoticePage(html.replace('name="searchValue" value=""','name="searchValue" value="filtered"'),s,1)).toThrow('Filtered');
  expect(()=>parseNoticePage(html.replace('2026.10.09','2026.02.30'),s,1)).toThrow('date');
  expect(()=>parseNoticePage(html.replace('pkid=899','pkid=900'),s,1)).toThrow('Duplicate');
  expect(()=>parseNoticePage(html.replace('pkid=900',s.kind==='cms'?'pkid=900&siteId=other':'pkid=900&bbsid=other'),s,1)).toThrow();
  expect(()=>parseNoticePage(page(s,1,2,1,false),s,1)).toThrow('coverage');
  const size=s.id.startsWith('swedu')?15:10;expect(parseLegacyNoticePage(page(s,1,2,size),s).done).toBe(false);
  expect(parseLegacyNoticePage(page(s,2,2,1,false),s,2).done).toBe(true);
 });
 it.each(ADDITIONAL_NOTICE_SOURCES)('archives $id original HTML and attachment/image URLs with detail evidence',s=>{
  const n=parseNoticePage(page(s),s,1).notices.find(n=>n.id==='900')!;const html=detail(s);const raw=parseNoticeRaw(html,n);
  expect(raw.bodyHtml).toBe('<p data-original="yes">Body &amp; content</p><img src="/images/example.png"><a href="/file.pdf">file</a>');
  expect(raw.attachments).toHaveLength(2);expect(raw.attachments.some(a=>a.includes('/Download?'))).toBe(true);expect(raw.imageUrls).toEqual([new URL('/images/example.png',s.url).href]);
  expect(()=>parseNoticeRaw(html.replace('value="900"','value="901"'),n)).toThrow('board/post');
  expect(()=>parseNoticeRaw(html.replace('Notice 900','Changed title'),n)).toThrow('title');
  expect(()=>parseNoticeRaw(html.replace('2026.10.09','2026.10.08'),n)).toThrow('date');
  expect(()=>parseNoticeRaw(html,{...n,url:n.url+'&extra=1'})).toThrow('URL');
 });
 it('keeps each new live baseline silent and independent of existing source health',async()=>{
  const db=testDatabase();try{db.sqlite.prepare("INSERT INTO sources(id,initialized,last_success) VALUES('university',1,'last-good')").run();for(const s of ADDITIONAL_NOTICE_SOURCES){const notices=parseNoticePage(page(s),s,1).notices;await saveNotices(db.env,s.id,notices,'2026-10-09T00:00:00Z');expect(db.sqlite.prepare('SELECT initialized FROM sources WHERE id=?').get(s.id)!.initialized).toBe(1);await saveNotices(db.env,s.id,notices,'2026-10-09T01:00:00Z');}expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(0);expect(db.sqlite.prepare("SELECT last_success FROM sources WHERE id='university'").get()!.last_success).toBe('last-good');}finally{db.close();}
 });
 it('caps recent CMS polling at three pages even when history continues',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));vi.resetModules();const {collectNotices}=await import('../src/sources');const s=ADDITIONAL_NOTICE_SOURCES[0];const fetcher=vi.fn(async(value:unknown)=>{const p=Number(new URL(String(value)).searchParams.get('currentPage'));return new Response(page(s,p,8,15),{headers:{'content-type':'text/html'}});});vi.stubGlobal('fetch',fetcher);const pending=collectNotices(s);await vi.runAllTimersAsync();expect(await pending).toHaveLength(46);expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it('uses the shared bounded, paced transport for recent collection and raw/backfill without uploads',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));vi.resetModules();const sources=await import('../src/sources');const archive=await import('../src/notice-archive-sources');
  const starts:number[]=[];const fetcher=vi.fn(async(value:unknown,options?:RequestInit)=>{expect(options?.redirect).toBe('manual');starts.push(Date.now());const u=new URL(String(value));const s=ADDITIONAL_NOTICE_SOURCES.find(s=>new URL(legacyNoticePageUrl(s,1)).origin===u.origin&&(s.kind==='legacy'||new URL(s.url).searchParams.get('bbsConfigFK')===u.searchParams.get('bbsConfigFK')))!;const p=Number(u.searchParams.get('currentPage')??1);return new Response(u.pathname.endsWith('view.do')?detail(s):page(s,p,2,p===1?(s.id.startsWith('swedu')?15:10):2),{headers:{'content-type':'text/html;charset=utf-8'}});});vi.stubGlobal('fetch',fetcher);
  for(const s of ADDITIONAL_NOTICE_SOURCES){const pending=sources.collectNotices(s);await vi.runAllTimersAsync();const result=await pending;expect(result.filter(n=>n.id==='999')).toHaveLength(s.kind==='cms'?1:0);expect(result.find(n=>n.id==='800')).toBeTruthy();
   const p=archive.collectNoticePage(s,2);await vi.runAllTimersAsync();expect((await p).done).toBe(true);
   const n=result.find(n=>n.id==='900')!;const raw=archive.collectNoticeRaw(n);await vi.runAllTimersAsync();expect((await raw).bodyHtml).toContain('data-original="yes"');
  }
  expect(fetcher).toHaveBeenCalledTimes(20);expect(starts.every((start,i)=>!i||start-starts[i-1]>=1000)).toBe(true);
 });
});
