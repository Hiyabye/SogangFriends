import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { Notice, Source } from './types';

type Node = DefaultTreeAdapterMap['node'];
const children = (n: Node): Node[] => 'childNodes' in n ? n.childNodes : [];
function all(n: Node, predicate: (n: Node) => boolean): Node[] {
 const result: Node[] = []; const stack = [n];
 while (stack.length) { const current = stack.pop()!; if (predicate(current)) result.push(current); stack.push(...children(current).slice().reverse()); }
 return result;
}
function attr(n: Node, name: string): string { return 'attrs' in n ? n.attrs.find(a => a.name === name)?.value ?? '' : ''; }
const tag = (n: Node, name: string) => 'tagName' in n && n.tagName === name;
const cls = (n: Node, name: string) => attr(n, 'class').split(/\s+/).includes(name);
function text(n: Node): string { return all(n, x => x.nodeName === '#text').map(x => 'value' in x ? x.value : '').join('').replace(/\s+/g, ' ').trim(); }
function one(n: Node, predicate: (n: Node) => boolean): Node { const found = all(n,predicate); if (found.length !== 1) throw new Error('Unexpected source structure'); return found[0]; }
function date(value: string): string { const d = value.replaceAll('.', '-'); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d+'T00:00:00Z').toISOString().slice(0,10) !== d) throw new Error('Invalid source date'); return d; }
function title(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('Invalid source title'); return value.trim(); }
const positive = (v: unknown): boolean => /^(?:[1-9]\d*)$/.test(String(v));
export const SOURCES: Source[] = [
 {id:'university',name:'학교 학사 공지',kind:'university',url:'https://www.sogang.ac.kr/api/api/v1/mainKo/BbsData/boardList?pageNum=1&pageSize=50&bbsConfigFk=2&category=&introPkId=&title=&content=&username='},
 ...[['academicNotice','컴퓨팅대학 학사 공지'],['externalInfo','컴퓨팅대학 대외정보'],['career','컴퓨팅대학 취업·인턴십']].map(([id,name]):Source => ({id,name,kind:'computing',url:`https://computing.sogang.ac.kr/ko/community/${id}/list?num=1`}))
];
const hosts = new Set(['www.sogang.ac.kr','computing.sogang.ac.kr','scc.sogang.ac.kr']);
let pacing: Promise<void> = Promise.resolve(); let lastStart = 0;
async function pace(): Promise<void> {
 const next = pacing.then(async () => { const wait = Math.max(0,1000-(Date.now()-lastStart)); if (wait) await new Promise(r=>setTimeout(r,wait)); lastStart=Date.now(); });
 pacing=next.catch(()=>{}); await next;
}
/** Bounds bytes while streaming, rather than trusting Content-Length. TLS uses platform defaults. */
export async function sourceBytes(url: string, limit=2*1024*1024): Promise<{bytes:Uint8Array;type:string}> {
 const u = new URL(url); if (u.protocol !== 'https:' || !hosts.has(u.hostname) || u.username || u.password || u.port || u.hash) throw new Error('Disallowed source URL');
 await pace(); const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),20_000);
 try {
  const response=await fetch(url,{redirect:'error',signal:controller.signal,headers:{'User-Agent':'SogangFriendsBot/0.1 (bounded official-source collector)'}});
  if (!response.ok || !response.body) {
   const error=new Error(`Source HTTP ${response.status}`) as Error & {retryAfter?:number};
   if(response.status===429){const seconds=Number(response.headers.get('retry-after'));error.retryAfter=Number.isFinite(seconds)&&seconds>0?Math.min(86400,seconds):60;}
   throw error;
  }
  if (Number(response.headers.get('content-length'))>limit) { await response.body.cancel(); throw new Error('Source too large'); }
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  for (;;) { const {done,value}=await reader.read(); if (done) break; size+=value.length; if(size>limit) {await reader.cancel(); throw new Error('Source too large');} chunks.push(value); }
  const bytes=new Uint8Array(size); let at=0; for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return {bytes,type:response.headers.get('content-type')??''};
 } finally {clearTimeout(timer);}
}
async function html(url:string):Promise<string> { const r=await sourceBytes(url); if(!r.type.includes('text/html'))throw new Error('Expected source HTML'); return new TextDecoder().decode(r.bytes); }
export function parseUniversity(value: unknown, source: Source=SOURCES[0]): Notice[] {
 const v=value as {statusCode?:unknown;data?:{list?:unknown;total?:unknown;pageNum?:unknown}};
 if(v?.statusCode!==200 || !v.data || !Array.isArray(v.data.list) || v.data.pageNum!==1 || typeof v.data.total!=='number' || v.data.total<0 || v.data.list.length>50 || (!v.data.list.length && v.data.total!==0)) throw new Error('Unexpected university response');
 const ids=new Set<string>(); const notices:Notice[]=[]; let regular=0;
 for(const raw of v.data.list){const r=raw as Record<string,unknown>; if(!positive(r.pkId)||r.configId!==2||typeof r.regDate!=='string'||!/^\d{14}$/.test(r.regDate)||!['Y','N'].includes(String(r.isTop)))throw new Error('Invalid university row');
  const id=String(r.pkId);if(ids.has(id))throw new Error('Duplicate university identity');ids.add(id);if(r.isTop==='N')regular++;
  const published=date(`${r.regDate.slice(0,4)}-${r.regDate.slice(4,6)}-${r.regDate.slice(6,8)}`);
  notices.push({id,source:source.id,title:title(r.title),published,url:`https://www.sogang.ac.kr/ko/detail/${id}?bbsConfigFk=2`});
 }
 if(v.data.total>v.data.list.length && !regular)throw new Error('Pinned notices saturate collection window');
 return notices.sort((a,b)=>b.published.localeCompare(a.published)||Number(b.id)-Number(a.id));
}
export function parseComputing(input:string,source:Source): {notices:Notice[];regularIds:string[];regularCount:number} {
 const doc=parse(input); const content=one(doc,n=>cls(n,'board-content')); const header=one(content,n=>cls(n,'board-content-header')); const heading=text(one(header,n=>tag(n,'h2')));
 const expected:Record<string,string>={academicNotice:'학사 공지',externalInfo:'대외정보',career:'취업·인턴십'};
 if(heading!==expected[source.id])throw new Error('Wrong computing board');
 const active=one(one(doc,n=>cls(n,'board-lnb')),n=>tag(n,'a')&&attr(n,'aria-current')==='page');
 if(new URL(attr(active,'href'),source.url).pathname!==new URL(source.url).pathname)throw new Error('Wrong active board');
 const categories=all(header,n=>tag(n,'button')&&attr(n,'aria-pressed')==='true'); if(categories.length&&text(categories[0])!=='전체')throw new Error('Filtered board');
 const searches=all(content,n=>tag(n,'input')&&attr(n,'type')==='search'); if(searches.some(n=>attr(n,'value').trim()))throw new Error('Filtered search');
 const table=one(one(content,n=>cls(n,'board-list')),n=>tag(n,'table')); const tbody=one(table,n=>tag(n,'tbody')); const rows=all(tbody,n=>tag(n,'tr'));
 if(!rows.length)throw new Error('Empty board needs explicit validation');
 const notices:Notice[]=[]; const regularIds:string[]=[]; const ids=new Set<string>();
 for(const row of rows){const cell=one(row,n=>cls(n,'board-list-title'));const a=one(cell,n=>tag(n,'a'));const u=new URL(attr(a,'href'),source.url);const match=u.pathname.match(new RegExp(`^/ko/community/${source.id}/detail/([1-9]\\d*)$`));
  if(u.origin!=='https://computing.sogang.ac.kr'||!match)throw new Error('Invalid computing link');const id=match[1];if(ids.has(id))throw new Error('Duplicate computing row');ids.add(id);
  const numberCell=one(row,n=>cls(n,'board-list-number'));const pinned=all(numberCell,n=>cls(n,'board-list-notice')).length>0;
  if(!pinned){if(!positive(text(numberCell)))throw new Error('Invalid row ordinal');regularIds.push(id);}
  notices.push({id,source:source.id,title:title(text(a)),published:date(text(one(row,n=>cls(n,'board-list-date')))),url:u.origin+u.pathname});
 }
 if(regularIds.length>10 || (!regularIds.length&&notices.length))throw new Error('Unexpected regular coverage');
 return {notices,regularIds,regularCount:regularIds.length};
}
export async function collectNotices(source:Source):Promise<Notice[]> {
 if(!SOURCES.some(s=>s.id===source.id&&s.url===source.url))throw new Error('Unknown source');
 if(source.kind==='university'){const r=await sourceBytes(source.url);if(!r.type.includes('json'))throw new Error('Expected JSON');return parseUniversity(JSON.parse(new TextDecoder().decode(r.bytes)),source);}
 const found=new Map<string,Notice>();const regular=new Set<string>();
 for(let page=1;page<=3;page++){const u=new URL(source.url);u.searchParams.set('num',String(page));const parsed=parseComputing(await html(u.href),source);
  for(const id of parsed.regularIds){if(regular.has(id))throw new Error('Overlapping regular pages');regular.add(id);}
  for(const n of parsed.notices){const old=found.get(n.id);if(old&&JSON.stringify(old)!==JSON.stringify(n))throw new Error('Conflicting repeated pin');found.set(n.id,n);}
  if(parsed.regularCount<10)break;
 }
 return [...found.values()].sort((a,b)=>b.published.localeCompare(a.published)||Number(b.id)-Number(a.id));
}
export const MEAL_SOURCE_URL='https://scc.sogang.ac.kr/front/cmsboardlist.do?bbsConfigFK=1185&siteId=dormitory&currentPage=1';
function cmsIdentity(doc:Node):void { for(const [name,value] of [['bbsConfigFK','1185'],['siteId','dormitory']]){const inputs=all(doc,n=>tag(n,'input')&&attr(n,'name')===name);if(!inputs.length||inputs.some(n=>attr(n,'value')!==value))throw new Error('Wrong meal board');} }
export function mealPeriod(titleText:string,published:string):{start:string;end:string} {
 date(published);const m=titleText.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*[~～\-–]\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*식단/);if(!m)throw new Error('Unrecognized meal period');
 const years=[Number(published.slice(0,4))-1,Number(published.slice(0,4)),Number(published.slice(0,4))+1]; const candidates:{start:string;end:string}[]=[];
 for(const year of years){try{const start=date(`${year}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);const endYear=Number(m[3])<Number(m[1])?year+1:year;const end=date(`${endYear}-${m[3].padStart(2,'0')}-${m[4].padStart(2,'0')}`);if((Date.parse(end)-Date.parse(start))/86400000===6&&Math.abs(Date.parse(start)-Date.parse(published))<=45*86400000&&new Date(start).getUTCDay()===1)candidates.push({start,end});}catch{/* Other inferred years may have invalid leap dates. */}}
 if(candidates.length!==1)throw new Error('Ambiguous meal period');return candidates[0];
}
export function parseMealList(input:string):{url:string;published:string;start:string;end:string}[] {
 const doc=parse(input);cmsIdentity(doc);const box=one(doc,n=>cls(n,'list_box')&&!cls(n,'for_mobile'));const entries=all(box,n=>tag(n,'li'));const result:{url:string;published:string;start:string;end:string}[]=[];
 for(const entry of entries){const links=all(entry,n=>tag(n,'a')&&cls(n,'title'));if(!links.length)continue;if(links.length!==1)throw new Error('Ambiguous meal row');const a=links[0];
  const comments=all(a,n=>n.nodeName==='#comment').map(n=>'data'in n?n.data:'');const t=comments.join(' ').trim()||text(a);if(!t.includes('식단'))continue;
  const info=one(entry,n=>cls(n,'info'));const spans=all(info,n=>tag(n,'span'));if(spans.length<2)throw new Error('Missing meal publication');const published=date(text(spans[1]));const period=mealPeriod(t,published);
  const u=new URL(attr(a,'href'),MEAL_SOURCE_URL);if(u.origin!=='https://scc.sogang.ac.kr'||u.pathname!=='/front/cmsboardview.do'||u.searchParams.get('bbsConfigFK')!=='1185'||u.searchParams.get('siteId')!=='dormitory'||!positive(u.searchParams.get('pkid')))throw new Error('Wrong meal article');
  const url=`https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=${u.searchParams.get('pkid')}`;result.push({url,published,...period});
 }
 if(!result.length)throw new Error('No recognizable meal articles');return result;
}
export function parseMealImage(input:string,article:{url:string;start:string;end:string;published:string}):string {
 const doc=parse(input);cmsIdentity(doc);const ids=all(doc,n=>tag(n,'input')&&attr(n,'name')==='pkid');if(!ids.length||ids.some(n=>attr(n,'value')!==new URL(article.url).searchParams.get('pkid')))throw new Error('Wrong meal post');
 const info=one(doc,n=>cls(n,'post_info'));const period=mealPeriod(text(one(info,n=>cls(n,'title'))),article.published);if(period.start!==article.start||period.end!==article.end)throw new Error('Changed meal title');
 const image=one(one(doc,n=>cls(n,'post_cont')),n=>tag(n,'img'));const u=new URL(attr(image,'src'),article.url);if(u.protocol==='http:'&&u.hostname==='scc.sogang.ac.kr')u.protocol='https:';validateImageUrl(u.href);return u.href;
}
function validateImageUrl(url:string):void {const u=new URL(url);if(u.origin!=='https://scc.sogang.ac.kr'||!/^\/dataview\/board\/1185\/[^/]+\.(?:png|jpe?g)$/i.test(u.pathname)||u.search||u.hash||u.username||u.password)throw new Error('Disallowed meal image');}
export async function discoverMeal():Promise<{url:string;imageUrl:string;published:string;start:string;end:string}> {
 const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);const candidates=[];
 for(let page=1;page<=2;page++){const u=new URL(MEAL_SOURCE_URL);u.searchParams.set('currentPage',String(page));candidates.push(...parseMealList(await html(u.href)));}
 // Prefer today's applicable post; otherwise expose newest known source without pretending it is today's menu.
 const sorted=candidates.sort((a,b)=>b.published.localeCompare(a.published));const chosen=sorted.find(a=>a.start<=today&&a.end>=today)??sorted[0];
 return {...chosen,imageUrl:parseMealImage(await html(chosen.url),chosen)};
}
export async function fetchImage(url:string):Promise<{bytes:Uint8Array;mime:string;hash:string}> {
 validateImageUrl(url);const r=await sourceBytes(url,5*1024*1024);const b=r.bytes;const png=b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);const jpeg=b.length>=4&&b[0]===255&&b[1]===216&&b[2]===255;
 const mime=png?'image/png':jpeg?'image/jpeg':null;if(!mime||!r.type.toLowerCase().startsWith(mime))throw new Error('Invalid image format');
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(b).buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');return {bytes:b,mime,hash};
}
