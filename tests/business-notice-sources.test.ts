import {afterEach,describe,expect,it,vi} from 'vitest';
import {validateNoticeSnapshot} from '../src/notice-ingest';
import {saveNotices} from '../src/storage';
import {testDatabase} from './helpers/db';
import {BUSINESS_NOTICE_SOURCE as source,businessDetailUrl,businessPageUrl,parseBusinessNoticePage,parseBusinessNoticeRaw} from '../src/business-notice-sources';

// Original, sanitized fixtures model the official K2Web table and post markup.
function filters():string{return ['findWord','findClSeq','findOpnwrd','rgsBgndeStr','rgsEnddeStr'].map(name=>`<input name="${name}" value="">`).join('');}
function form(name:string,body=''):string{return `<form name="${name}" method="post" action="/bbs/sbs/649/artclList.do">${filters()}${body}</form>`;}
function page(p=1,total=23):string{
 const last=Math.ceil(total/10),count=Math.max(0,Math.min(10,total-(p-1)*10));
 const row=(id:number,ordinal:number,pin=false)=>`<tr${pin?' class="notice"':''}><td class="td-num">${pin?'<span class="notice-title">일반공지</span>':ordinal}</td><td class="td-title"><a href="/bbs/sbs/649/${id}/artclView.do" onclick="jf_viewArtcl('sbs', '649', '${id}')">${pin?'':'[학사] '}<strong>Notice ${id} &amp; details</strong></a></td><td class="td-date">2026.10.14</td></tr>`;
 const rows=row(900,0,true)+Array.from({length:count},(_,i)=>row(900-(p-1)*10-i,total-(p-1)*10-i)).join('');
 const link=(n:number,c='')=>`<a class="${c}" href="javascript:page_link('${n}')">${n}</a>`;
 return `<meta property="og:url" content="${businessPageUrl(source,p)}"><div class="board-list">${form('searchForm',`<div class="srch_counts">총 <strong>${total}</strong> 개의 게시물</div>`)}<table class="board-table"><caption>경영대학 학부 공지사항</caption><tbody>${rows}</tbody></table>${form('pageForm',`<input name="page" value="${p}"><div class="_paging"><span class="_curPage">${p}</span><span class="_totPage">${last}</span><strong>${p}</strong>${link(last,'_last')}${p<last?link(p+1,'_listNext'):''}</div>`)}</div>`;
}
const body='\n<p data-original="yes">Body &amp; text</p><img src="/images/a.png"><img src="file:///local.png"><img src="data:image/png;base64,AAAA"><a href="../file.pdf">file</a><a href="https://example.test/info">ordinary</a>\n';
function detail():string{return `<meta property="og:url" content="${businessDetailUrl(source,'900')}"><div class="board-view"><input id="artclViewTitle" value="Notice 900 &amp; details"><div class="view viewCont"><div class="title"><strong>[학사] Notice 900 &amp; details</strong><ul class="detail"><li><span>작성일</span> 2026.10.14</li></ul></div><div class="txt">${body}</div><div class="attachment"><ul><li><a href="/bbs/sbs/649/105030/download.do">file.pdf</a></li></ul></div></div>${form('listForm')}</div>`;}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('business official K2Web board',()=>{
 it('binds source, board, article identity, unprefixed titles and dates',()=>{
  const parsed=parseBusinessNoticePage(page(),source);expect(parsed.regularCount).toBe(10);expect(parsed.notices).toHaveLength(10);expect(parsed.done).toBe(false);
  expect(parsed.notices[0]).toEqual({id:'900',source:'businessNotice',title:'Notice 900 & details',published:'2026-10-14',url:'https://sbs.sogang.ac.kr/bbs/sbs/649/900/artclView.do'});
  expect(parseBusinessNoticePage(page().replace(businessPageUrl(source,1),source.url),source).notices).toEqual(parsed.notices);
  const second=parseBusinessNoticePage(page(2),source,2);expect(second.notices).toHaveLength(11);expect(second.regularIds).not.toContain('900');expect(second.done).toBe(false);
  const last=parseBusinessNoticePage(page(3),source,3);expect(last.regularCount).toBe(3);expect(last.done).toBe(true);
  expect(parseBusinessNoticePage(page(1,5),source).done).toBe(true);
  const final=page(3);expect(()=>parseBusinessNoticePage(final.replace('<div class="_paging">','<div class="_paging"><a class="_listNext" href="javascript:page_link(\'3\')">next</a>'),source,3)).toThrow();
  expect(()=>businessPageUrl({...source,url:source.url+'?findWord=x'},1)).toThrow();expect(()=>businessPageUrl(source,0)).toThrow();expect(()=>businessDetailUrl(source,'01')).toThrow();
 });
 it('rejects foreign or filtered pages, conflicting pins, duplicate rows and unsupported EOF',()=>{
  const html=page();
  for(const changed of [
   html.replace('name="findWord" value=""','name="findWord" value="filter"'),
   html.replace('name="findOpnwrd" value=""','name="findOpnwrd" value="26"'),
   html.replace('name="findClSeq" value=""','name="findClSeq" value="1"'),
   html.replace('name="rgsBgndeStr" value=""','name="rgsBgndeStr" value="20260101"'),
   html.replace('경영대학 학부 공지사항','other board'),
   html.replace('/bbs/sbs/649/900/artclView.do','/bbs/sbs/650/900/artclView.do'),
   html.replace('/bbs/sbs/649/900/artclView.do','https://attacker.test/bbs/sbs/649/900/artclView.do'),
   html.replace('/bbs/sbs/649/900/artclView.do','/bbs/sbs/649/900/artclView.do?x=1'),
   html.replace("jf_viewArtcl('sbs', '649', '900')","jf_viewArtcl('sbs', '650', '900')"),
   html.replace('Notice 900 &amp; details','Changed title'),
   html.replace('2026.10.14','2026.02.30'),
   html.replace('<td class="td-num">22</td>','<td class="td-num">19</td>'),
   html.replace('총 <strong>23</strong>','총 <strong>24</strong>'),
   html.replace("javascript:page_link('2')","javascript:page_link('3')"),
   html.replace("javascript:page_link('3')","javascript:page_link('4')"),
   html.replace('class="_paging"','class="missing"'),
   html.replaceAll('/899/artclView.do','/898/artclView.do').replaceAll("'899')","'898')").replaceAll('Notice 899','Notice 898'),
  ])expect(()=>parseBusinessNoticePage(changed,source)).toThrow();
  expect(()=>parseBusinessNoticePage(html,source,2)).toThrow();expect(()=>parseBusinessNoticePage(page(4),source,4)).toThrow();expect(()=>parseBusinessNoticePage(page(1,0),source)).toThrow();
 });
 it('validates canonical business snapshots and rejects foreign boards and noncanonical article URLs',()=>{
  const notices=parseBusinessNoticePage(page(),source).notices;
  expect(validateNoticeSnapshot({source:source.id,notices}).notices).toEqual(notices);
  const notice=notices[0];
  for(const url of [notice.url.replace('/649/','/650/'),notice.url.replace('sbs.sogang.ac.kr','attacker.test'),notice.url+'?page=1',notice.url.replace('https:','http:')])expect(()=>validateNoticeSnapshot({source:source.id,notices:[{...notice,url}]})).toThrow('URL');
 });
 it('caps recent collection at three paced pages and shares bounded transport with archive reads',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));vi.resetModules();
  const {collectNotices}=await import('../src/sources');const {collectNoticePage,collectNoticeRaw}=await import('../src/notice-archive-sources');
  const starts:number[]=[];
  const fetcher=vi.fn(async(value:unknown,options?:RequestInit)=>{
   expect(options?.redirect).toBe('manual');expect(options?.signal).toBeInstanceOf(AbortSignal);starts.push(Date.now());
   const u=new URL(String(value));expect(u.origin).toBe('https://sbs.sogang.ac.kr');
   return new Response(u.pathname.endsWith('artclView.do')?detail():page(Number(u.searchParams.get('page')),43),{headers:{'content-type':'text/html;charset=utf-8'}});
  });vi.stubGlobal('fetch',fetcher);
  const pending=collectNotices(source);await vi.runAllTimersAsync();const notices=await pending;
  expect(notices).toHaveLength(30);expect(fetcher.mock.calls.map(([url])=>String(url))).toEqual([1,2,3].map(p=>businessPageUrl(source,p)));
  const last=collectNoticePage(source,5);await vi.runAllTimersAsync();expect(await last).toMatchObject({done:true});
  const raw=collectNoticeRaw(notices.find(n=>n.id==='900')!);await vi.runAllTimersAsync();expect(await raw).toMatchObject({bodyHtml:body,imageUrls:['https://sbs.sogang.ac.kr/images/a.png']});
  expect(fetcher).toHaveBeenCalledTimes(5);expect(starts.every((start,i)=>!i||start-starts[i-1]>=1000)).toBe(true);
 });
 it.each(['overlap','conflicting pin'])('rejects %s between recent business pages',async(failure)=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));vi.resetModules();const {collectNotices}=await import('../src/sources');
  const fetcher=vi.fn(async(value:unknown)=>{
   const p=Number(new URL(String(value)).searchParams.get('page'));let html=page(p,43);
   if(p===2)html=failure==='overlap'?html.replaceAll('/890/artclView.do','/899/artclView.do').replaceAll("'890')","'899')").replaceAll('Notice 890','Notice 899'):html.replace('Notice 900 &amp; details','Changed pin');
   return new Response(html,{headers:{'content-type':'text/html'}});
  });vi.stubGlobal('fetch',fetcher);
  const rejected=expect(collectNotices(source)).rejects.toThrow(failure==='overlap'?'Overlapping regular pages':'Conflicting repeated pin');await vi.runAllTimersAsync();await rejected;expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('establishes a silent business baseline without changing existing source health',async()=>{
  const db=testDatabase();try{
   db.sqlite.prepare("INSERT INTO sources(id,initialized,last_success,last_attempt,error) VALUES('university',1,'last-good','last-attempt','existing-error')").run();
   const before=db.sqlite.prepare("SELECT * FROM sources WHERE id='university'").get();const notices=parseBusinessNoticePage(page(),source).notices;
   await saveNotices(db.env,source.id,notices,'2026-10-16T00:00:00Z');
   expect(db.sqlite.prepare('SELECT initialized,last_success FROM sources WHERE id=?').get(source.id)).toMatchObject({initialized:1,last_success:'2026-10-16T00:00:00Z'});
   await saveNotices(db.env,source.id,notices,'2026-10-16T01:00:00Z');
   expect(db.sqlite.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(0);
   expect(db.sqlite.prepare("SELECT * FROM sources WHERE id='university'").get()).toEqual(before);
  }finally{db.close();}
 });
 it('validates double-escaped detail titles and the exact encoded 100-character list preview',()=>{
  const original=parseBusinessNoticePage(page(),source).notices[0];
  for(const encoded of ['A &quot;quoted&quot; title','A &apos;quoted&apos; title','A &lt;literal&gt; title','x'.repeat(97)+'&apos;end&apos;']){
   const full=encoded.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
   const preview=encoded.slice(0,100).replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
   const html=detail().replace('value="Notice 900 &amp; details"',`value="${encoded.replaceAll('&','&amp;')}"`).replace('[학사] Notice 900 &amp; details',`[학사] ${encoded}`);
   for(const title of new Set([full,preview]))expect(parseBusinessNoticeRaw(html,source,{...original,title}).bodyHtml).toBe(body);
   for(const title of [preview.slice(0,-1),preview+'x','Different'])expect(()=>parseBusinessNoticeRaw(html,source,{...original,title})).toThrow('Changed business notice title');
   expect(()=>parseBusinessNoticeRaw(html.replace(`[학사] ${encoded}`,'[학사] Changed heading'),source,{...original,title:preview})).toThrow('Changed business visible title');
  }
 });
 it('keeps exact original HTML and exports only proven attachment and web-image references',()=>{
  const notice=parseBusinessNoticePage(page(),source).notices[0],html=detail(),raw=parseBusinessNoticeRaw(html,source,notice);
  expect(parseBusinessNoticeRaw(html.replace('<strong>[학사] Notice 900','<strong>Notice 900').replace(/<div class="attachment">.*?<\/div>/,''),source,notice).attachments).toEqual([new URL('../file.pdf',notice.url).href]);
  const empty=html.replace(/<div class="attachment">.*?<\/div>/,'<div class="attachment"><span class="no-file">첨부파일이(가) 없습니다.</span></div>');
  expect(parseBusinessNoticeRaw(empty,source,notice).attachments).toEqual([new URL('../file.pdf',notice.url).href]);
  for(const invalid of [empty.replace('첨부파일이(가) 없습니다.','unknown'),empty.replace('class="no-file"','class="other"'),empty.replace('<span class="no-file">','<a href="/bbs/sbs/649/105030/download.do">file</a><span class="no-file">'),html.replace(/<ul><li><a href="\/bbs\/sbs\/649\/105030\/download.do">file.pdf<\/a><\/li><\/ul>/,'')])expect(()=>parseBusinessNoticeRaw(invalid,source,notice)).toThrow('Unresolved business attachments');
  expect(raw.bodyHtml).toBe(body);expect(raw.imageUrls).toEqual(['https://sbs.sogang.ac.kr/images/a.png']);expect(raw.attachments).toEqual(['https://sbs.sogang.ac.kr/bbs/sbs/649/105030/download.do',new URL('../file.pdf',notice.url).href]);
  for(const changed of [html.replace('/900/artclView.do','/901/artclView.do'),html.replace('value="Notice 900','value="Changed'),html.replace('[학사] Notice 900','[학사] Changed'),html.replace('2026.10.14','2026.10.13'),html.replace('/bbs/sbs/649/artclList.do','/bbs/sbs/650/artclList.do'),html.replace('/649/105030/download.do','/650/105030/download.do'),html.replace('/bbs/sbs/649/105030/download.do','https://attacker.test/bbs/sbs/649/105030/download.do'),html.replace('src="/images/a.png"','src="javascript:bad"')])expect(()=>parseBusinessNoticeRaw(changed,source,notice)).toThrow();
  expect(()=>parseBusinessNoticeRaw(html,source,{...notice,url:notice.url+'?page=1'})).toThrow();
 });
});
