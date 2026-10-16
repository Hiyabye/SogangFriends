import {parse,parseFragment,type DefaultTreeAdapterMap} from 'parse5';
import type {Notice,Source} from './types';
import {validDate} from './time.ts';

type Node=DefaultTreeAdapterMap['node'];
const ORIGIN='https://sbs.sogang.ac.kr',LIST='/bbs/sbs/649/artclList.do';
export const BUSINESS_NOTICE_SOURCE:Source={id:'businessNotice',name:'경영대학 학부 공지사항',kind:'business',url:ORIGIN+LIST};
const attr=(n:Node,key:string)=>'attrs'in n?n.attrs.find(a=>a.name===key)?.value??'':'';
const tag=(n:Node,t:string)=>'tagName'in n&&n.tagName===t;
const cls=(n:Node,c:string)=>attr(n,'class').split(/\s+/).includes(c);
function all(n:Node,p:(n:Node)=>boolean):Node[]{const out:Node[]=[],stack=[n];while(stack.length){const x=stack.pop()!;if(p(x))out.push(x);if('childNodes'in x)stack.push(...x.childNodes.slice().reverse());}return out;}
function one(n:Node,p:(n:Node)=>boolean):Node{const found=all(n,p);if(found.length!==1)throw new Error('Unexpected business notice structure');return found[0];}
const text=(n:Node)=>all(n,x=>x.nodeName==='#text').map(x=>'value'in x?x.value:'').join('').replace(/\s+/g,' ').trim();
const positive=(s:string)=>/^[1-9]\d{0,19}$/.test(s);
function integer(s:string):number{if(!positive(s)||!Number.isSafeInteger(Number(s)))throw new Error('Invalid business notice number');return Number(s);}
function date(s:string):string{const d=s.replaceAll('.','-');if(!validDate(d))throw new Error('Invalid business notice date');return d;}
function title(s:string):string{if(!s||s.length>1000)throw new Error('Invalid business notice title');return s;}
function known(source:Source):void{if(source.id!==BUSINESS_NOTICE_SOURCE.id||source.kind!=='business'||source.url!==BUSINESS_NOTICE_SOURCE.url)throw new Error('Unknown business notice source');}
export function businessDetailUrl(source:Source,id:string):string{known(source);if(!positive(id))throw new Error('Invalid business notice identity');return `${ORIGIN}/bbs/sbs/649/${id}/artclView.do`;}
export function businessPageUrl(source:Source,page:number):string{known(source);if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid business notice page');return `${source.url}?page=${page}`;}
function documentIdentity(doc:Node,url:string):void{
 // K2Web's canonical link is only the site root; og:url proves the board/post.
 if(attr(one(doc,n=>tag(n,'meta')&&attr(n,'property')==='og:url'),'content')!==url)throw new Error('Wrong business notice document identity');
}
function formIdentity(form:Node):void{
 if(attr(form,'action')!==LIST||attr(form,'method').toLowerCase()!=='post')throw new Error('Wrong business notice form');
 for(const name of ['findWord','findClSeq','findOpnwrd'])if(attr(one(form,n=>tag(n,'input')&&attr(n,'name')===name),'value').trim())throw new Error('Filtered business notice board');
 for(const name of ['rgsBgndeStr','rgsEnddeStr'])if(all(form,n=>tag(n,'input')&&attr(n,'name')===name).some(n=>attr(n,'value').trim()))throw new Error('Filtered business notice dates');
}
function pageTarget(a:Node):number{const m=attr(a,'href').match(/^javascript:page_link\('([1-9]\d*)'\)$/);if(!m)throw new Error('Invalid business pagination link');return integer(m[1]);}
export function parseBusinessNoticePage(input:string,source:Source,page=1):{notices:Notice[];regularIds:string[];regularCount:number;done:boolean}{
 const url=businessPageUrl(source,page),doc=parse(input);
 const identity=attr(one(doc,n=>tag(n,'meta')&&attr(n,'property')==='og:url'),'content');if(identity!==url&&(page!==1||identity!==source.url))throw new Error('Wrong business notice document identity');
 const board=one(doc,n=>cls(n,'board-list'));
 const search=one(board,n=>tag(n,'form')&&attr(n,'name')==='searchForm');formIdentity(search);
 const pageForm=one(board,n=>tag(n,'form')&&attr(n,'name')==='pageForm');formIdentity(pageForm);
 if(attr(one(pageForm,n=>tag(n,'input')&&attr(n,'name')==='page'),'value')!==String(page))throw new Error('Wrong business notice page');
 const total=integer(text(one(one(search,n=>cls(n,'srch_counts')),n=>tag(n,'strong'))));const last=Math.ceil(total/10);
 const table=one(board,n=>tag(n,'table')&&cls(n,'board-table'));
 if(text(one(table,n=>tag(n,'caption')))!==source.name)throw new Error('Wrong business notice board caption');
 const rows=all(one(table,n=>tag(n,'tbody')),n=>tag(n,'tr'));if(!rows.length)throw new Error('Unverified empty business board');
 const found=new Map<string,Notice>(),regularIds:string[]=[],pinIds=new Set<string>(),ordinals:number[]=[];
 for(const row of rows){
  const pinned=cls(row,'notice'),number=one(row,n=>cls(n,'td-num'));
  if(pinned){if(text(number)!=='일반공지')throw new Error('Invalid business notice pin');}else ordinals.push(integer(text(number)));
  const a=one(one(row,n=>cls(n,'td-title')),n=>tag(n,'a'));const u=new URL(attr(a,'href'),source.url),match=u.pathname.match(/^\/bbs\/sbs\/649\/([1-9]\d*)\/artclView\.do$/);
  if(!match||u.href!==businessDetailUrl(source,match[1])||attr(a,'onclick')!==`jf_viewArtcl('sbs', '649', '${match[1]}')`)throw new Error('Wrong business notice link');
  const id=match[1],notice:Notice={id,source:source.id,title:title(text(one(a,n=>tag(n,'strong')))),published:date(text(one(row,n=>cls(n,'td-date')))),url:businessDetailUrl(source,id)};
  // Pinned posts are repeated in the regular list and on later pages by the source.
  const previous=found.get(id);if(previous&&JSON.stringify(previous)!==JSON.stringify(notice))throw new Error('Conflicting business notice pin');
  if(pinned){if(pinIds.has(id))throw new Error('Duplicate business notice pin');pinIds.add(id);}else{if(regularIds.includes(id))throw new Error('Duplicate business notice identity');regularIds.push(id);}
  found.set(id,notice);
 }
 const count=Math.min(10,total-(page-1)*10);
 if(page>last||count<1||regularIds.length!==count||ordinals.some((n,i)=>n!==total-(page-1)*10-i))throw new Error('Conflicting business notice coverage');
 const pager=one(pageForm,n=>cls(n,'_paging'));
 if(text(one(pager,n=>cls(n,'_curPage')))!==String(page)||text(one(pager,n=>cls(n,'_totPage')))!==String(last)||text(one(pager,n=>tag(n,'strong')))!==String(page))throw new Error('Wrong business pagination state');
 for(const a of all(pager,n=>tag(n,'a'))){if(pageTarget(a)>last)throw new Error('Conflicting business pagination bounds');}
 if(pageTarget(one(pager,n=>tag(n,'a')&&cls(n,'_last')))!==last)throw new Error('Wrong business last page');
 const next=all(pager,n=>tag(n,'a')&&cls(n,'_listNext'));const done=page===last;
 if(done?next.length!==0:next.length!==1||pageTarget(next[0])!==page+1)throw new Error('Wrong business next page');
 return {notices:[...found.values()],regularIds,regularCount:regularIds.length,done};
}
function reference(value:string,base:string):string{const u=new URL(value,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Invalid business archive reference');return u.href;}
export function parseBusinessNoticeRaw(input:string,source:Source,notice:Notice):{bodyHtml:string;attachments:string[];imageUrls:string[]}{
 if(notice.source!==source.id||notice.url!==businessDetailUrl(source,notice.id))throw new Error('Wrong business archive identity');
 const doc=parse(input,{sourceCodeLocationInfo:true});documentIdentity(doc,notice.url);const board=one(doc,n=>cls(n,'board-view'));
 formIdentity(one(board,n=>tag(n,'form')&&attr(n,'name')==='listForm'));
 const encodedTitle=attr(one(board,n=>tag(n,'input')&&attr(n,'id')==='artclViewTitle'),'value');
 // K2Web escapes entity text again in this attribute, while its list cuts the
 // encoded title at 100 characters (even mid-entity). Keep the full heading check.
 const decodeTitle=(value:string)=>text(parseFragment(value.replaceAll('<','&lt;')));
 const fullTitle=decodeTitle(encodedTitle);
 if(notice.title!==fullTitle&&(encodedTitle.length<=100||notice.title!==decodeTitle(encodedTitle.slice(0,100))))throw new Error('Changed business notice title');
 const content=one(board,n=>cls(n,'viewCont')),heading=one(content,n=>cls(n,'title'));
 const visible=text(one(heading,n=>tag(n,'strong')));if(visible!==fullTitle&&visible.replace(/^\[[^\[\]]+\] /,'')!==fullTitle)throw new Error('Changed business visible title');
 const dateRow=one(one(heading,n=>cls(n,'detail')),n=>tag(n,'li')&&all(n,x=>tag(x,'span')&&text(x)==='작성일').length===1);
 const stamp=text(dateRow).match(/^작성일 (\d{4}\.\d{2}\.\d{2})$/);if(!stamp||date(stamp[1])!==notice.published)throw new Error('Changed business notice date');
 const body=one(content,n=>cls(n,'txt')),loc='tagName'in body?body.sourceCodeLocation:null;if(!loc?.startTag||!loc.endTag)throw new Error('Missing original business body offsets');
 const bodyHtml=input.slice(loc.startTag.endOffset,loc.endTag.startOffset),bodyDoc=parse(bodyHtml),attachments:string[]=[];
 const files=all(content,n=>cls(n,'attachment'));if(files.length>1)throw new Error('Ambiguous business attachments');
 if(files.length){const links=all(files[0],n=>tag(n,'a')),empty=all(files[0],n=>tag(n,'span')&&cls(n,'no-file'));
  if(links.length?empty.length!==0:empty.length!==1||text(files[0])!=='첨부파일이(가) 없습니다.')throw new Error('Unresolved business attachments');for(const a of links){const url=reference(attr(a,'href'),notice.url);if(!/^https:\/\/sbs\.sogang\.ac\.kr\/bbs\/sbs\/649\/[1-9]\d*\/download\.do$/.test(url))throw new Error('Wrong business attachment identity');attachments.push(url);}}
 for(const a of all(bodyDoc,n=>tag(n,'a')&&!!attr(n,'href'))){if(('attrs'in a&&a.attrs.some(x=>x.name==='download'))||/\.(?:pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(?:[?#]|$)/i.test(attr(a,'href')))attachments.push(reference(attr(a,'href'),notice.url));}
 const imageUrls=all(bodyDoc,n=>tag(n,'img')&&!!attr(n,'src')&&!/^(?:data|file):/i.test(attr(n,'src').trim())).map(n=>reference(attr(n,'src'),notice.url));
 return {bodyHtml,attachments:[...new Set(attachments)],imageUrls:[...new Set(imageUrls)]};
}
