import {describe,it,expect,vi,afterEach} from 'vitest';
import {SOURCES,parseUniversity} from '../src/sources';
import {collectNoticePage,collectNoticeRaw,parseNoticePage,parseNoticeRaw} from '../src/notice-archive-sources';
import type {Notice,Source} from '../src/types';
const college=SOURCES.find(s=>s.id==='academicNotice')!;
const notice=(source='academicNotice'):Notice=>({source,id:'123',title:'Synthetic notice',published:'2026-10-10',url:source==='university'?'https://www.sogang.ac.kr/ko/detail/123?bbsConfigFk=2':`https://computing.sogang.ac.kr/ko/community/${source}/detail/123`});
const heading:Record<string,string>={academicNotice:'학사 공지',graduateNotice:'대학원 공지',externalInfo:'대외정보',news:'소식',career:'취업·인턴십'};
function layout(source:Source,inside:string){return `<aside class="board-lnb"><a href="/ko/community/${source.id}/list" aria-current="page">board</a></aside><section class="board-content"><header class="board-content-header"><h2>${heading[source.id]}</h2><button aria-pressed="true">전체</button></header>${inside}</section>`;}
function page(source=college,num=1,ordinals=[1],done=true){const rows=ordinals.map((ordinal,i)=>`<tr><td class="board-list-number">${ordinal}</td><td class="board-list-title"><a href="/ko/community/${source.id}/detail/${123+i}">Synthetic notice</a></td><td class="board-list-date">2026-10-10</td></tr>`).join('');return layout(source,`<div class="board-list"><table><tbody>${rows||'<tr><td colspan="5">등록된 게시물이 없습니다.</td></tr>'}</tbody></table></div><nav class="board-pagination"><button aria-current="page">${num}</button><button aria-label="마지막 페이지" ${done?'disabled':''}>last</button></nav>`);}
function detail(source=college,body=' <p data-original="1">Keep &amp; whitespace</p> ',file=true){return layout(source,`<article class="board-detail"><header><div class="board-detail-title-row"><h3>Synthetic notice</h3></div><dl class="board-detail-meta"><div><dt>작성일</dt><dd>2026-10-10</dd></div></dl></header>${file?'<section class="board-detail-files"><a class="board-detail-file-download" href="javascript:;" title="example.pdf">example.pdf</a></section>':''}<div class="board-detail-reading-area">${body}</div><nav>Never archive this navigation</nav></article>`)+`<script>window.__NUXT__=(function(a,b){return {data:[{DETAIL:{SN:a},FILE_LIST:[${file?'{PARENT_SEQ:a,FILE_PATH:b,FILE_NAME:"example.pdf",SAVE_FILE_NAME:"stored.pdf"}':''}]}]}}(123,"community/${source.id}/123/"));</script>`;}
const university=(pageNum=1,total=1)=>({statusCode:200,data:{pageNum,total,list:[{pkId:123,configId:2,title:'Synthetic notice',regDate:'20261010000000',isTop:'N'}]}});
const universityDetail=()=>({statusCode:200,data:{pkId:123,configPkId:2,title:'Synthetic notice',regDate:'20261010000000',content:'<p>Original <a href="/files/example.pdf">attachment</a><img src="/images/example.png"></p>',fileValue1:null}});
afterEach(()=>vi.restoreAllMocks());
describe('source-only notice archive',()=>{
 it('generalizes university page validation without changing the default page-one contract',()=>{
  expect(parseUniversity(university(),SOURCES[0])).toHaveLength(1);
  expect(()=>parseUniversity(university(2,51),SOURCES[0])).toThrow('Unexpected university');
  expect(parseUniversity(university(2,51),SOURCES[0],2)).toHaveLength(1);
  expect(()=>parseUniversity(university(),SOURCES[0],0)).toThrow('page');
 });
 it('requires explicit terminal evidence, correct page, board identity and unfiltered lists',()=>{
  expect(parseNoticePage(page(),college,1)).toMatchObject({done:true,notices:[{id:'123'}]});
  expect(parseNoticePage(page(college,2,[11,10,9,8,7,6,5,4,3,2],false),college,2).done).toBe(false);
  expect(()=>parseNoticePage(page(college,2,[3,2],false),college,2)).toThrow('end-of-history');
  expect(()=>parseNoticePage(page(college,2,[2],true),college,2)).toThrow('end-of-history');
  expect(()=>parseNoticePage(page(),college,2)).toThrow('page number');
  expect(()=>parseNoticePage(page().replace('학사 공지','소식'),college,1)).toThrow('board');
  expect(()=>parseNoticePage(page().replace('>전체<','>학사<'),college,1)).toThrow('Filtered');
 });
 it('accepts only an explicit empty first board page, not missing rows or errors as EOF',()=>{
  expect(parseNoticePage(page(college,1,[],true),college,1)).toEqual({notices:[],done:true});
  expect(()=>parseNoticePage(page(college,2,[],true),college,2)).toThrow('Unverified empty');
  expect(()=>parseNoticePage(page(college,1,[],false),college,1)).toThrow('Unverified empty');
  expect(()=>parseNoticePage(page(college,1,[],true).replace('등록된 게시물이 없습니다.','Server error'),college,1)).toThrow();
  expect(()=>parseNoticePage(page(college,1,[],true).replace('<tr><td colspan="5">등록된 게시물이 없습니다.</td></tr>',''),college,1)).toThrow();
 });
 it('preserves exact original body fragments and resolves serialized attachment links for every college board',()=>{
  for(const source of SOURCES.filter(s=>s.kind==='computing')){
   const body='\n <P class="original">Body &amp; original entities</P>\n<img src="/images/example.png">';
   const raw=parseNoticeRaw(detail(source,body),notice(source.id));
   expect(raw.bodyHtml).toBe(body);expect(raw.bodyHtml).not.toContain('navigation');
   expect(raw.attachments).toEqual([`https://computing.sogang.ac.kr/web/file/community/${source.id}/123/stored.pdf`]);
   expect(raw.imageUrls).toEqual(['https://computing.sogang.ac.kr/images/example.png']);
  }
 });
 it('allows image-only bodies without executing embedded scripts or returning javascript attachment URLs',()=>{
  const body='<img src="/poster.png"><script>globalThis.archiveExecuted = true</script>';
  expect(parseNoticeRaw(detail(college,body,false),notice())).toMatchObject({bodyHtml:body,imageUrls:['https://computing.sogang.ac.kr/poster.png'],attachments:[]});
  expect((globalThis as any).archiveExecuted).toBeUndefined();
 });
 it('fails explicitly when detail, source, date or attachment metadata cannot be proven',()=>{
  const input=detail();
  expect(()=>parseNoticeRaw(input.replace('}}(123,','}}(124,'),notice())).toThrow('detail identity');
  expect(()=>parseNoticeRaw(input.replace('FILE_LIST:[{','OTHER_FILES:[{'),notice())).toThrow('Unresolved computing');
  expect(()=>parseNoticeRaw(input.replace('community/academicNotice/123/','community/news/123/'),notice())).toThrow('attachment identity');
  expect(()=>parseNoticeRaw(input.replace('2026-10-10','2026-10-11'),notice())).toThrow('date');
  expect(()=>parseNoticeRaw(input.replace('window.__NUXT__=','window.OTHER='),notice())).toThrow('hydration identity');
  expect(()=>parseNoticeRaw(input,{...notice(),url:'https://attacker.test/123'})).toThrow('detail URL');
 });
 it('keeps normal hyperlinks and inline image data in raw HTML without calling them downloadable attachments',()=>{
  const body='<a href="https://example.test/news">ordinary link</a><img src="data:image/png;base64,aA==">';
  expect(parseNoticeRaw(detail(college,body,false),notice())).toMatchObject({bodyHtml:body,attachments:[],imageUrls:[]});
 });
 it('validates university detail ID, board and observation, retains original HTML and attachment/image references',()=>{
  const input=universityDetail();expect(parseNoticeRaw(input,notice('university'))).toMatchObject({bodyHtml:input.data.content,attachments:['https://www.sogang.ac.kr/files/example.pdf'],imageUrls:['https://www.sogang.ac.kr/images/example.png']});
  expect(()=>parseNoticeRaw({...input,data:{...input.data,configPkId:3}},notice('university'))).toThrow('detail');
  expect(()=>parseNoticeRaw({...input,data:{...input.data,pkId:124}},notice('university'))).toThrow('detail');
  expect(()=>parseNoticeRaw({...input,data:{...input.data,fileValue1:{fileId:1}}},notice('university'))).toThrow('Unresolved university');
 });
 it('preserves populated university fileValue URL fields including Korean filename queries and deduplicates references',()=>{
  const input=universityDetail();
  const absolute='https://www.sogang.ac.kr/file-fe-prd/board/2/123_1.pdf?sg=검증 양식 1.pdf';
  const relative='/file-fe-prd/board/2/123_2.hwp?sg=검증 양식(2).hwp';
  const raw=parseNoticeRaw({...input,data:{...input.data,fileValue1:absolute,fileValue2:relative,fileValue3:absolute,fileValue4:'',fileValue5:null}},notice('university'));
  expect(raw.bodyHtml).toBe(input.data.content);
  expect(raw.attachments).toEqual(['https://www.sogang.ac.kr/files/example.pdf',new URL(absolute).href,new URL(relative,'https://www.sogang.ac.kr').href]);
 });
 it('fetches historical university pages with explicit page identity and total-based completion',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(university(2,51)),{headers:{'content-type':'application/json'}}));
  expect(await collectNoticePage(SOURCES[0],2)).toMatchObject({done:true,notices:[{id:'123'}]});
  expect(String(fetcher.mock.calls[0][0])).toContain('pageNum=2');expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
 });
 it('uses existing bounded fetch for details, never requests referenced image or attachment binaries',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(universityDetail()),{headers:{'content-type':'application/json'}}));
  expect((await collectNoticeRaw(notice('university'))).attachments).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://www.sogang.ac.kr/api/api/v1/mainKo/BbsData?pkId=123');
 });
 it('does not turn transport failure, redirect or wrong content type into end-of-history',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('redirect',{status:302}));
  await expect(collectNoticePage(college,2)).rejects.toThrow('Source HTTP 302');
 });
});
