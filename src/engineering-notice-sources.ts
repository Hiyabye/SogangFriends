import {parse,type DefaultTreeAdapterMap} from 'parse5';
import type {Notice,Source} from './types';
import {validDate,todayKst} from './time.ts';

type Node=DefaultTreeAdapterMap['node'];
const BOARDS=[
 ['engineeringNotice','notice','일반공지'],
 ['engineeringRecruit','recruit','채용/홍보'],
 ['engineeringAcademic','academic','학사공지'],
 ['engineeringResearch','research','연구성과'],
] as const;
export const ENGINEERING_NOTICE_SOURCES:Source[]=BOARDS.map(([id,slug,name])=>({id,name:`공과대학 ${name}`,kind:'engineering',url:`https://eng.sogang.ac.kr/board/${slug}`}));
const attr=(n:Node,key:string)=>'attrs'in n?n.attrs.find(a=>a.name===key)?.value??'':'';
const tag=(n:Node,t:string)=>'tagName'in n&&n.tagName===t;
const cls=(n:Node,c:string)=>attr(n,'class').split(/\s+/).includes(c);
function all(n:Node,p:(n:Node)=>boolean):Node[]{const out:Node[]=[];const stack=[n];while(stack.length){const x=stack.pop()!;if(p(x))out.push(x);if('childNodes'in x)stack.push(...x.childNodes.slice().reverse());}return out;}
function one(n:Node,p:(n:Node)=>boolean):Node{const found=all(n,p);if(found.length!==1)throw new Error('Unexpected Engineering notice structure');return found[0];}
const text=(n:Node)=>all(n,x=>x.nodeName==='#text').map(x=>'value'in x?x.value:'').join('').replace(/\s+/g,' ').trim();
const positive=(s:string)=>/^[1-9]\d{0,19}$/.test(s);
function date(s:string):string{const d=s.replaceAll('.','-');if(!validDate(d))throw new Error('Invalid Engineering notice date');return d;}
function title(s:string):string{if(!s||s.length>1000)throw new Error('Invalid Engineering notice title');return s;}
function known(source:Source):typeof BOARDS[number]{const board=BOARDS.find(([id])=>id===source.id);if(!board||source.kind!=='engineering'||source.url!==`https://eng.sogang.ac.kr/board/${board[1]}`)throw new Error('Unknown Engineering notice source');return board;}
export function engineeringDetailUrl(source:Source,id:string):string{known(source);if(!positive(id))throw new Error('Invalid Engineering notice identity');return `${source.url}/${id}`;}
export function engineeringPageUrl(source:Source,page:number):string{known(source);if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid Engineering notice page');return `${source.url}?page=${page}`;}
function documentIdentity(doc:Node,source:Source,urls:string[]):void{
 const board=known(source);
 if(!urls.includes(attr(one(doc,n=>tag(n,'link')&&attr(n,'rel')==='canonical'),'href')))throw new Error('Wrong Engineering canonical identity');
 const heading=one(doc,n=>cls(n,'subvis-title'));
 if(text(heading)!==board[2])throw new Error('Wrong Engineering board heading');
 const nav=one(doc,n=>cls(n,'subnav'));
 if(attr(one(nav,n=>tag(n,'a')&&attr(n,'aria-current')==='page'),'href')!==new URL(source.url).pathname)throw new Error('Wrong Engineering active board');
}
function pageLink(node:Node,source:Source):number{
 const u=new URL(attr(node,'href'),source.url);
 if(u.origin!=='https://eng.sogang.ac.kr'||u.pathname!==new URL(source.url).pathname||u.username||u.password||u.hash||[...u.searchParams.keys()].some(k=>k!=='page')||u.searchParams.getAll('page').length!==1||!positive(u.searchParams.get('page')??''))throw new Error('Invalid Engineering pagination link');
 const page=Number(u.searchParams.get('page'));if(!Number.isSafeInteger(page))throw new Error('Invalid Engineering pagination number');return page;
}
export function parseEngineeringNoticePage(input:string,source:Source,page=1):{notices:Notice[];regularIds:string[];regularCount:number;done:boolean}{
 const url=engineeringPageUrl(source,page);const doc=parse(input);documentIdentity(doc,source,page===1?[source.url,url]:[url]);
 const board=one(doc,n=>cls(n,'board')&&cls(n,'board--list'));
 const search=one(board,n=>tag(n,'form')&&cls(n,'board-search'));
 if(attr(search,'action')!==new URL(source.url).pathname||attr(search,'method')!=='get'||attr(one(search,n=>tag(n,'input')&&attr(n,'name')==='q'),'value').trim())throw new Error('Filtered Engineering board');
 const selected=all(search,n=>tag(n,'option')&&'attrs'in n&&n.attrs.some(a=>a.name==='selected'));
 if(selected.length!==1||attr(selected[0],'value')!=='all')throw new Error('Filtered Engineering search field');
 const totalText=text(one(one(board,n=>cls(n,'board-total')),n=>tag(n,'b')));
 if(!/^\d+$/.test(totalText))throw new Error('Invalid Engineering total');const total=Number(totalText);if(!Number.isSafeInteger(total))throw new Error('Invalid Engineering total');
 const list=one(board,n=>tag(n,'ul')&&cls(n,'blist'));
 const rows=all(list,n=>tag(n,'li')&&cls(n,'brow')&&!cls(n,'brow-head'));
 // An empty or out-of-range response has no verified end-of-history evidence.
 if(!rows.length)throw new Error('Unverified empty Engineering board');
 const notices:Notice[]=[],regularIds:string[]=[],ordinals:number[]=[];const ids=new Set<string>();let pins=0;
 for(const row of rows){
  const a=one(row,n=>tag(n,'a')&&cls(n,'c-title'));const u=new URL(attr(a,'href'),source.url);
  const prefix=new URL(source.url).pathname+'/';const id=u.pathname.startsWith(prefix)?u.pathname.slice(prefix.length):'';
  const canonical=engineeringDetailUrl(source,id);
  if(u.href!==canonical||ids.has(id))throw new Error('Wrong/duplicate Engineering notice link');ids.add(id);
  const number=one(row,n=>cls(n,'c-no'));const pinned=cls(row,'is-notice');
  if(pinned){if(page!==1||text(number)!=='공지')throw new Error('Invalid Engineering pin');pins++;}
  else{if(!positive(text(number)))throw new Error('Invalid Engineering ordinal');ordinals.push(Number(text(number)));regularIds.push(id);}
  // Due-date and new/attachment badges are presentation, not part of the title.
  const span=one(a,n=>tag(n,'span'));
  notices.push({id,source:source.id,title:title(text(span)),published:date(text(one(row,n=>cls(n,'c-date')))),url:canonical});
 }
 if(!regularIds.length||regularIds.length>10||ordinals.some((n,i)=>!Number.isSafeInteger(n)||n<1||(i>0&&n!==ordinals[i-1]-1)))throw new Error('Conflicting Engineering row coverage');
 const regularTotal=ordinals[0]+(page-1)*10;const last=Math.ceil(regularTotal/10);const done=page===last;
 if(regularTotal>total||(page===1&&regularTotal+pins!==total)||page>last||regularIds.length!==Math.min(10,regularTotal-(page-1)*10))throw new Error('Conflicting Engineering total coverage');
 const pagers=all(board,n=>tag(n,'nav')&&cls(n,'pager'));
 if(last===1){if(page!==1||pagers.length)throw new Error('Conflicting Engineering single-page evidence');}
 else{
  if(pagers.length!==1)throw new Error('Missing Engineering pagination');const pager=pagers[0];
  if(text(one(pager,n=>tag(n,'strong')&&attr(n,'aria-current')==='page'))!==String(page))throw new Error('Wrong Engineering page number');
  const links=all(pager,n=>tag(n,'a'));for(const link of links){const target=pageLink(link,source);if(target>last)throw new Error('Conflicting Engineering pagination bounds');}
  const next=links.filter(n=>attr(n,'aria-label')==='다음글'),lastLinks=links.filter(n=>attr(n,'aria-label')==='last');
  if(done){if(next.length||lastLinks.length||ordinals.at(-1)!==1)throw new Error('Conflicting Engineering end-of-history evidence');}
  else if(next.length!==1||pageLink(next[0],source)!==page+1||lastLinks.length!==1||pageLink(lastLinks[0],source)!==last)throw new Error('Conflicting Engineering next/last page');
 }
 return {notices,regularIds,regularCount:regularIds.length,done};
}
function reference(value:string,base:string):string{const u=new URL(value,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Invalid Engineering archive reference');return u.href;}
export function parseEngineeringNoticeRaw(input:string,source:Source,notice:Notice):{bodyHtml:string;attachments:string[];imageUrls:string[]}{
 if(notice.source!==source.id||notice.url!==engineeringDetailUrl(source,notice.id))throw new Error('Wrong Engineering notice identity');
 const doc=parse(input,{sourceCodeLocationInfo:true});documentIdentity(doc,source,[notice.url]);
 const article=one(doc,n=>tag(n,'article')&&cls(n,'post'));
 if(text(one(article,n=>cls(n,'post-title')))!==notice.title)throw new Error('Changed Engineering title');
 const time=one(one(article,n=>cls(n,'post-meta')),n=>tag(n,'time'));const visible=text(time).match(/^(\d{4}\.\d{2}\.\d{2}) \d{2}:\d{2}$/);
 const stamp=attr(time,'datetime');
 if(!visible||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp)||!Number.isFinite(Date.parse(stamp))||date(visible[1])!==notice.published||todayKst(new Date(stamp))!==notice.published)throw new Error('Changed Engineering date');
 const body=one(article,n=>cls(n,'post-body'));const loc='tagName'in body?body.sourceCodeLocation:null;if(!loc?.startTag||!loc.endTag)throw new Error('Missing original Engineering body offsets');
 const bodyHtml=input.slice(loc.startTag.endOffset,loc.endTag.startOffset);const bodyDoc=parse(bodyHtml);const attachments:string[]=[];
 const files=all(article,n=>cls(n,'post-files'));if(files.length>1)throw new Error('Ambiguous Engineering attachments');
 if(files.length){
  const count=text(one(one(files[0],n=>cls(n,'post-files-t')),n=>tag(n,'b')));const links=all(files[0],n=>tag(n,'a')&&'attrs'in n&&n.attrs.some(a=>a.name==='download'));
  if(!positive(count)||Number(count)!==links.length)throw new Error('Unresolved Engineering attachments');
  for(const a of links){const url=reference(attr(a,'href'),notice.url);if(!/^https:\/\/eng\.sogang\.ac\.kr\/download\/[1-9]\d*$/.test(url))throw new Error('Wrong Engineering attachment URL');attachments.push(url);}
 }
 for(const a of all(bodyDoc,n=>tag(n,'a')&&!!attr(n,'href'))){if(('attrs'in a&&a.attrs.some(x=>x.name==='download'))||/\.(?:pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(?:[?#]|$)/i.test(attr(a,'href')))attachments.push(reference(attr(a,'href'),notice.url));}
 // Local/inline Office image markup stays exact in bodyHtml, not web references.
 const imageUrls=all(bodyDoc,n=>tag(n,'img')&&!!attr(n,'src')&&!/^(?:data|file):/i.test(attr(n,'src').trim())).map(n=>reference(attr(n,'src'),notice.url));
 return {bodyHtml,attachments:[...new Set(attachments)],imageUrls:[...new Set(imageUrls)]};
}
