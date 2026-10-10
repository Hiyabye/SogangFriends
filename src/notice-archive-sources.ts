import {parse,type DefaultTreeAdapterMap} from 'parse5';
import {SOURCES,sourceBytes,parseUniversity,parseComputing} from './sources.ts';
import type {Notice,Source} from './types';
import {validDate} from './time.ts';

type Node=DefaultTreeAdapterMap['node'];
export interface NoticeRaw {notice:Notice;bodyHtml:string;attachments:string[];imageUrls:string[]}
const headings:Record<string,string>={academicNotice:'학사 공지',graduateNotice:'대학원 공지',externalInfo:'대외정보',news:'소식',career:'취업·인턴십'};
const attr=(n:Node,key:string)=>'attrs'in n?n.attrs.find(a=>a.name===key)?.value??'':'';
const tag=(n:Node,t:string)=>'tagName'in n&&n.tagName===t;
const cls=(n:Node,c:string)=>attr(n,'class').split(/\s+/).includes(c);
function all(n:Node,p:(n:Node)=>boolean):Node[]{const out:Node[]=[];const stack=[n];while(stack.length){const x=stack.pop()!;if(p(x))out.push(x);if('childNodes'in x)stack.push(...x.childNodes.slice().reverse());}return out;}
function one(n:Node,p:(n:Node)=>boolean):Node{const nodes=all(n,p);if(nodes.length!==1)throw new Error('Unexpected archive source structure');return nodes[0];}
const text=(n:Node)=>all(n,x=>x.nodeName==='#text').map(x=>'value'in x?x.value:'').join('').replace(/\s+/g,' ').trim();
function sourceFor(source:Source):Source{const known=SOURCES.find(s=>s.id===source.id&&s.url===source.url&&s.kind===source.kind);if(!known)throw new Error('Unknown archive source');return known;}
function identity(notice:Notice):Source{
 const source=SOURCES.find(s=>s.id===notice.source);if(!source||!/^[1-9]\d{0,19}$/.test(notice.id)||!validDate(notice.published)||!notice.title.trim()||notice.title.length>1000)throw new Error('Invalid archive notice');
 const expected=source.kind==='university'?`https://www.sogang.ac.kr/ko/detail/${notice.id}?bbsConfigFk=2`:`https://computing.sogang.ac.kr/ko/community/${source.id}/detail/${notice.id}`;
 if(notice.url!==expected)throw new Error('Wrong archive detail URL');return source;
}
function board(doc:Node,source:Source):Node{
 const content=one(doc,n=>cls(n,'board-content'));const header=one(content,n=>cls(n,'board-content-header'));
 if(text(one(header,n=>tag(n,'h2')))!==headings[source.id])throw new Error('Wrong archive board');
 const active=one(one(doc,n=>cls(n,'board-lnb')),n=>tag(n,'a')&&attr(n,'aria-current')==='page');
 if(new URL(attr(active,'href'),source.url).href!==new URL(source.url).origin+new URL(source.url).pathname)throw new Error('Wrong archive active board');
 const filters=all(header,n=>tag(n,'button')&&attr(n,'aria-pressed')==='true');if(filters.some(n=>text(n)!=='전체'))throw new Error('Filtered archive board');
 if(all(content,n=>tag(n,'input')&&attr(n,'type')==='search').some(n=>attr(n,'value').trim()))throw new Error('Filtered archive search');return content;
}
export function parseNoticePage(input:string,source:Source,page:number):{notices:Notice[];done:boolean}{
 sourceFor(source);if(source.kind!=='computing'||!Number.isSafeInteger(page)||page<1)throw new Error('Invalid archive page');
 const doc=parse(input);const content=board(doc,source);const pagination=one(content,n=>cls(n,'board-pagination'));
 if(text(one(pagination,n=>tag(n,'button')&&attr(n,'aria-current')==='page'))!==String(page))throw new Error('Wrong archive page number');
 const last=one(pagination,n=>tag(n,'button')&&attr(n,'aria-label')==='마지막 페이지');const lastDisabled='attrs'in last&&last.attrs.some(a=>a.name==='disabled');
 const tbody=one(one(content,n=>cls(n,'board-list')),n=>tag(n,'tbody'));const rows=all(tbody,n=>tag(n,'tr'));
 const empty=rows.length===1&&all(rows[0],n=>tag(n,'td')).length===1&&text(rows[0])==='등록된 게시물이 없습니다.';
 if(empty){if(page!==1||!lastDisabled||all(rows[0],n=>tag(n,'a')).length)throw new Error('Unverified empty archive page');return {notices:[],done:true};}
 const parsed=parseComputing(input,source);const ordinals=all(tbody,n=>cls(n,'board-list-number')).filter(n=>!all(n,x=>cls(x,'board-list-notice')).length).map(n=>Number(text(n)));
 if(ordinals.some((n,i)=>!Number.isSafeInteger(n)||n<1||(i>0&&n!==ordinals[i-1]-1)))throw new Error('Conflicting archive row ordinals');
 if(lastDisabled!==ordinals.includes(1)||(!lastDisabled&&parsed.regularCount<10))throw new Error('Conflicting archive end-of-history evidence');
 return {notices:parsed.notices,done:lastDisabled};
}
export async function collectNoticePage(source:Source,page:number):Promise<{notices:Notice[];done:boolean}>{
 sourceFor(source);if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid archive page');
 const u=new URL(source.url);u.searchParams.set(source.kind==='university'?'pageNum':'num',String(page));
 const response=await sourceBytes(u.href);const input=new TextDecoder('utf-8',{fatal:true}).decode(response.bytes);
 if(source.kind==='computing'){if(!response.type.includes('text/html'))throw new Error('Expected archive HTML');return parseNoticePage(input,source,page);}
 if(!response.type.includes('json'))throw new Error('Expected archive JSON');const data=JSON.parse(input);const notices=parseUniversity(data,source,page);
 const total=data.data.total;if(!Number.isSafeInteger(total)||page>Math.max(1,Math.ceil(total/50)))throw new Error('Invalid archive total/page');
 return {notices,done:page*50>=total};
}
function link(value:string,base:string):string{const u=new URL(value,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Unresolved archive link');return u.href;}
function references(html:string,base:string):{attachments:string[];imageUrls:string[]}{
 const doc=parse(html);
 // Ordinary hyperlinks remain in the original HTML; do not mislabel them as attachments.
 const attachments=all(doc,n=>tag(n,'a')&&!!attr(n,'href')).filter(n=>('attrs'in n&&n.attrs.some(a=>a.name==='download'))||/\.(?:pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(?:[?#]|$)/i.test(attr(n,'href'))).map(n=>link(attr(n,'href'),base));
 const imageUrls=all(doc,n=>tag(n,'img')&&!!attr(n,'src')&&!/^data:/i.test(attr(n,'src'))).map(n=>link(attr(n,'src'),base));
 return {attachments:[...new Set(attachments)],imageUrls:[...new Set(imageUrls)]};
}
// Parse only literal tokens and parameter references from Nuxt's serialized data.
// Never evaluate site JavaScript to obtain its attachment metadata.
function pieces(input:string,delimiter=','):string[]{const out:string[]=[];let start=0,depth=0,quote='',escaped=false;for(let i=0;i<input.length;i++){const c=input[i];if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if('([{'.includes(c))depth++;else if(')]}'.includes(c))depth--;else if(c===delimiter&&depth===0){out.push(input.slice(start,i).trim());start=i+1;}}if(quote||depth!==0)throw new Error('Invalid archive hydration');out.push(input.slice(start).trim());return out;}
function block(input:string,start:number):string{const opener=input[start],closer=opener==='['?']':'}';let depth=0,quote='',escaped=false;for(let i=start;i<input.length;i++){const c=input[i];if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c===opener)depth++;else if(c===closer&&--depth===0)return input.slice(start,i+1);}throw new Error('Invalid archive hydration block');}
function hydration(input:string):{value:(token:string)=>unknown;object:(name:string)=>Record<string,unknown>;routePath:()=>string;files:Record<string,unknown>[]} {
 const doc=parse(input);const scripts=all(doc,n=>tag(n,'script')).map(n=>all(n,x=>x.nodeName==='#text').map(x=>'value'in x?x.value:'').join('')).filter(s=>s.startsWith('window.__NUXT__='));
 if(scripts.length!==1)throw new Error('Missing archive hydration identity');const script=scripts[0].slice('window.__NUXT__='.length);
 const header=script.match(/^\(function\(([\w$,]*)\)\{/);if(!header)throw new Error('Unsupported archive hydration');
 const end=script.lastIndexOf('}(');if(end<0||!script.endsWith('));'))throw new Error('Unsupported archive hydration call');
 const names=header[1].split(',');const args=pieces(script.slice(end+2,-3));if(names.length!==args.length)throw new Error('Invalid archive hydration arguments');
 const bindings=new Map(names.map((name,i)=>[name,args[i]]));
 const value=(token:string):unknown=>{token=token.trim();if(bindings.has(token))token=bindings.get(token)!;if(token.startsWith('"'))return JSON.parse(token);if(/^-?\d+(?:\.\d+)?$/.test(token))return Number(token);if(token==='null')return null;if(token==='!0'||token==='true')return true;if(token==='!1'||token==='false')return false;throw new Error('Unsupported archive hydration value');};
 const decode=(object:string)=>Object.fromEntries(pieces(object.slice(1,-1)).map(field=>{const m=field.match(/^([\w$]+):(.*)$/s);if(!m)throw new Error('Invalid archive hydration field');return [m[1],value(m[2])];}));
 const object=(name:string)=>{const m=new RegExp(`\\b${name}:\\{`).exec(script);if(!m)throw new Error('Missing archive hydration object');const fields=pieces(block(script,m.index+name.length+1).slice(1,-1));const id=fields.find(f=>/^SN:/.test(f));if(!id)throw new Error('Missing archive hydration identity');return {SN:value(id.slice(3))};};
 const fileMatch=/\bFILE_LIST:\[/.exec(script);const files=fileMatch?pieces(block(script,fileMatch.index+'FILE_LIST:'.length).slice(1,-1)).filter(Boolean).map(decode):[];
 const routePath=()=>{const matches=[...script.matchAll(/\broutePath:([^,}]+)/g)];if(matches.length!==1)throw new Error('Missing archive route identity');const path=value(matches[0][1]);if(typeof path!=='string')throw new Error('Invalid archive route identity');return path;};
 return {value,object,routePath,files};
}
export function parseNoticeRaw(input:string|unknown,notice:Notice):NoticeRaw {
 const source=identity(notice);
 if(source.kind==='university'){
  const response=input as {statusCode?:unknown;data?:Record<string,unknown>};const d=response?.data;
  if(response?.statusCode!==200||!d||String(d.pkId)!==notice.id||d.configPkId!==2||typeof d.content!=='string'||typeof d.title!=='string'||d.title.trim()!==notice.title||typeof d.regDate!=='string'||!/^(?:\d{14}|\d{4}-\d{2}-\d{2}.*)$/.test(d.regDate))throw new Error('Wrong university archive detail');
  const published=/^\d{14}$/.test(d.regDate)?`${d.regDate.slice(0,4)}-${d.regDate.slice(4,6)}-${d.regDate.slice(6,8)}`:d.regDate.slice(0,10);if(published!==notice.published)throw new Error('Changed university archive date');
  const refs=references(d.content,notice.url);for(let i=1;i<=5;i++){const f=d[`fileValue${i}`];if(f===null||f===undefined||f==='')continue;if(typeof f!=='string'||!/^https?:\/\/|^\//.test(f))throw new Error('Unresolved university attachment metadata');refs.attachments.push(link(f,notice.url));}
  return {notice,bodyHtml:d.content,attachments:[...new Set(refs.attachments)],imageUrls:refs.imageUrls};
 }
 if(typeof input!=='string')throw new Error('Expected computing archive detail');const doc=parse(input,{sourceCodeLocationInfo:true});const content=board(doc,source);const article=one(content,n=>tag(n,'article')&&cls(n,'board-detail'));
 if(text(one(one(article,n=>cls(n,'board-detail-title-row')),n=>tag(n,'h3')))!==notice.title)throw new Error('Changed computing archive title');
 const meta=one(article,n=>cls(n,'board-detail-meta'));const dateRow=one(meta,n=>tag(n,'div')&&all(n,x=>tag(x,'dt')&&text(x)==='작성일').length===1);
 if(text(one(dateRow,n=>tag(n,'dd'))).replaceAll('.','-')!==notice.published)throw new Error('Changed computing archive date');
 const state=hydration(input);const detail=state.object('DETAIL');const detailId=String(detail.SN);
 if(detailId!==notice.id){
  // News exposes a public route ID distinct from its internal DETAIL.SN on newer posts.
  // Keep the official route ID; require both canonical and hydrated route proof, plus
  // the board/title/date checks above. Attachments name the internal parent but
  // retain a public-ID file path; both are validated below.
  if(source.id!=='news'||!/^[1-9]\d{0,19}$/.test(detailId))throw new Error('Wrong computing archive detail identity');
  const canonical=one(doc,n=>tag(n,'link')&&attr(n,'rel').split(/\s+/).includes('canonical'));
  if(attr(canonical,'href')!==notice.url||state.routePath()!==new URL(notice.url).pathname)throw new Error('Wrong computing archive route identity');
 }
 const body=one(article,n=>cls(n,'board-detail-reading-area'));const loc='tagName'in body?body.sourceCodeLocation:null;if(!loc?.startTag||!loc.endTag)throw new Error('Missing original archive body offsets');
 const bodyHtml=input.slice(loc.startTag.endOffset,loc.endTag.startOffset);const refs=references(bodyHtml,notice.url);
 const buttons=all(article,n=>tag(n,'a')&&cls(n,'board-detail-file-download'));
 if(buttons.length!==state.files.length)throw new Error('Unresolved computing attachment metadata');
 for(let i=0;i<state.files.length;i++){const file=state.files[i];if(String(file.PARENT_SEQ)!==detailId||file.FILE_PATH!==`community/${source.id}/${notice.id}/`||typeof file.SAVE_FILE_NAME!=='string'||!/^[\w.-]+$/.test(file.SAVE_FILE_NAME)||file.FILE_NAME!==attr(buttons[i],'title'))throw new Error('Wrong computing attachment identity');refs.attachments.push(`https://computing.sogang.ac.kr/web/file/${file.FILE_PATH}${file.SAVE_FILE_NAME}`);}
 return {notice,bodyHtml,attachments:[...new Set(refs.attachments)],imageUrls:refs.imageUrls};
}
export async function collectNoticeRaw(notice:Notice):Promise<NoticeRaw>{
 const source=identity(notice);const url=source.kind==='university'?`https://www.sogang.ac.kr/api/api/v1/mainKo/BbsData?pkId=${notice.id}`:notice.url;
 const response=await sourceBytes(url);const input=new TextDecoder('utf-8',{fatal:true}).decode(response.bytes);
 if(!response.type.includes(source.kind==='university'?'json':'text/html'))throw new Error('Unexpected archive detail content type');
 return parseNoticeRaw(source.kind==='university'?JSON.parse(input):input,notice);
}
