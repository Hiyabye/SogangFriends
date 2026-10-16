import {parse,type DefaultTreeAdapterMap} from 'parse5';
import type {Notice,Source} from './types';
import {validDate} from './time.ts';
import {universityBoardId} from './university-notice-sources.ts';
import {engineeringDetailUrl} from './engineering-notice-sources.ts';

type Node=DefaultTreeAdapterMap['node'];
const attr=(n:Node,key:string)=>'attrs'in n?n.attrs.find(a=>a.name===key)?.value??'':'';
const tag=(n:Node,t:string)=>'tagName'in n&&n.tagName===t;
const cls=(n:Node,c:string)=>attr(n,'class').split(/\s+/).includes(c);
function all(n:Node,p:(n:Node)=>boolean):Node[]{const out:Node[]=[];const stack=[n];while(stack.length){const x=stack.pop()!;if(p(x))out.push(x);if('childNodes'in x)stack.push(...x.childNodes.slice().reverse());}return out;}
function one(n:Node,p:(n:Node)=>boolean):Node{const nodes=all(n,p);if(nodes.length!==1)throw new Error('Unexpected legacy notice structure');return nodes[0];}
const text=(n:Node)=>all(n,x=>x.nodeName==='#text').map(x=>'value'in x?x.value:'').join('').replace(/\s+/g,' ').trim();
const positive=(v:string)=>/^[1-9]\d{0,19}$/.test(v);
function date(v:string):string{const d=v.replaceAll('.','-');if(!validDate(d))throw new Error('Invalid legacy notice date');return d;}
function title(v:string):string{if(!v||v.length>1000)throw new Error('Invalid legacy notice title');return v;}
export const ADDITIONAL_NOTICE_SOURCES:Source[]=[
 {id:'sweduNotice',name:'SW중심대학사업단 공지사항',kind:'cms',url:'https://scc.sogang.ac.kr/front/cmsboardlist.do?siteId=sweducenter&bbsConfigFK=7250'},
 {id:'sweduNews',name:'SW중심대학사업단 소식',kind:'cms',url:'https://scc.sogang.ac.kr/front/cmsboardlist.do?siteId=sweducenter&bbsConfigFK=7251'},
 {id:'sweduPress',name:'SW중심대학사업단 언론보도',kind:'cms',url:'https://scc.sogang.ac.kr/front/cmsboardlist.do?siteId=sweducenter&bbsConfigFK=7252'},
 {id:'conveduNotice',name:'융합교육원 공지사항',kind:'cms',url:'https://convedu.sogang.ac.kr/front/cmsboardlist.do?siteId=convedu&bbsConfigFK=5551'},
 {id:'conveduNews',name:'융합교육원 센터소식',kind:'cms',url:'https://convedu.sogang.ac.kr/front/cmsboardlist.do?siteId=convedu&bbsConfigFK=5550'},
 {id:'bdataNotice',name:'빅데이터 융복합 인재양성사업단 공지사항',kind:'legacy',url:'https://sc.sogang.ac.kr/bdata/4305.html'},
 {id:'bdataNews',name:'빅데이터 융복합 인재양성사업단 News',kind:'legacy',url:'https://sc.sogang.ac.kr/bdata/4306.html'}
];
const legacyBoardId=(source:Source)=>source.id==='bdataNews'?'5255':'5256';
function known(source:Source):void{if(!ADDITIONAL_NOTICE_SOURCES.some(s=>s.id===source.id&&s.kind===source.kind&&s.url===source.url))throw new Error('Unknown legacy notice source');}
export function noticeDetailUrl(source:Source,id:string):string{
 if(!positive(id))throw new Error('Invalid notice identity');
 if(source.kind==='university')return `https://www.sogang.ac.kr/ko/detail/${id}?bbsConfigFk=${universityBoardId(source)}`;
 if(source.kind==='computing')return `https://computing.sogang.ac.kr/ko/community/${source.id}/detail/${id}`;
 if(source.kind==='engineering')return engineeringDetailUrl(source,id);
 known(source);const u=new URL(source.url);
 if(source.kind==='cms')return `${u.origin}/front/cmsboardview.do?bbsConfigFK=${u.searchParams.get('bbsConfigFK')}&siteId=${u.searchParams.get('siteId')}&pkid=${id}`;
 return `https://sc.sogang.ac.kr/bbs/bbsview.do?bbsid=${legacyBoardId(source)}&wslID=bdata&pkid=${id}`;
}
export function legacyNoticePageUrl(source:Source,page:number):string{
 known(source);if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid legacy notice page');
 const u=new URL(source.kind==='cms'?source.url:`https://sc.sogang.ac.kr/bbs/bbslist.do?wslID=bdata&bbsid=${legacyBoardId(source)}`);u.searchParams.set('currentPage',String(page));return u.href;
}
function identity(doc:Node,source:Source,id?:string):void{
 known(source);const u=new URL(source.url);const values=source.kind==='cms'?[['bbsConfigFK',u.searchParams.get('bbsConfigFK')!],['siteId',u.searchParams.get('siteId')!]]:[['bbsid',legacyBoardId(source)],['wslID','bdata']];
 if(id)values.push(['pkid',id]);
 for(const [name,value]of values){const inputs=all(doc,n=>tag(n,'input')&&attr(n,'name')===name);if(!inputs.length||inputs.some(n=>attr(n,'value')!==value))throw new Error('Wrong legacy notice board/post');}
 if(all(doc,n=>tag(n,'input')&&attr(n,'name')==='searchValue').some(n=>attr(n,'value').trim()))throw new Error('Filtered legacy notice search');
 if(source.kind==='cms'&&all(doc,n=>tag(n,'input')&&attr(n,'name')==='searchLowItem').some(n=>!['','ALL'].includes(attr(n,'value'))))throw new Error('Filtered legacy notice category');
}
function pageNumber(n:Node):number{const m=attr(n,'onclick').match(/^sendPage\('pageForm','([1-9]\d*)'\);return false;?$/);if(!m)throw new Error('Invalid legacy pagination');return Number(m[1]);}
export interface LegacyNoticePage {notices:Notice[];regularIds:string[];regularCount:number;done:boolean}
export function parseLegacyNoticePage(input:string,source:Source,page=1):LegacyNoticePage{
 if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid legacy notice page');const doc=parse(input);identity(doc,source);
 const cms=source.kind==='cms';const paging=one(doc,n=>cms?cls(n,'board_paging'):cls(n,'align')&&all(n,x=>tag(x,'a')&&cls(x,'last')).length===1);
 const active=one(paging,n=>cms?tag(n,'li')&&cls(n,'on'):cls(n,'current'));
 if(text(active)!==String(page))throw new Error('Wrong legacy notice page number');
 const last=pageNumber(one(paging,n=>tag(n,'a')&&(cms?!!('parentNode'in n&&n.parentNode&&cls(n.parentNode,'btn_last')):cls(n,'last'))));
 if(!Number.isSafeInteger(last)||page>last)throw new Error('Invalid legacy last page');
 if(cms&&text(one(paging,n=>cls(n,'total_cnt')))!==`/ ${last}`)throw new Error('Conflicting CMS pagination');
 const photo=source.id==='bdataNews';
 const container=cms?one(doc,n=>cls(n,'list_box')&&!cls(n,'for_mobile')):one(one(doc,n=>cls(n,'bbs-list')&&!cls(n,'bbs-nav')&&(!photo||cls(n,'photo-list'))),n=>tag(n,'tbody'));
 // WebSTYLIST pads the final photo-table row with genuinely empty .item cells.
 const rows=all(container,n=>photo?cls(n,'item')&&('childNodes'in n&&n.childNodes.some(child=>child.nodeName!=='#text'||text(child)!=='')):tag(n,cms?'li':'tr'));if(!rows.length)throw new Error('Unverified empty legacy board');
 const notices:Notice[]=[];const regularIds:string[]=[];const ordinals:number[]=[];const ids=new Set<string>();
 for(const row of rows){
  const a=cms?one(row,n=>tag(n,'a')&&cls(n,'title')):photo?one(row,n=>tag(n,'a')&&cls(n,'subject')):one(one(row,n=>cls(n,'subject')),n=>tag(n,'a'));
  const u=new URL(attr(a,'href'),legacyNoticePageUrl(source,page));const id=u.searchParams.get('pkid')??'';const canonical=noticeDetailUrl(source,id);const expected=new URL(canonical);
  if(u.origin!==expected.origin||u.pathname!==expected.pathname||u.username||u.password||u.hash||['bbsConfigFK','siteId','bbsid','wslID','pkid'].some(key=>expected.searchParams.has(key)&&(u.searchParams.getAll(key).length!==1||u.searchParams.get(key)!==expected.searchParams.get(key))))throw new Error('Wrong legacy notice link');
  if(u.searchParams.get('currentPage')!==String(page)||!['','ALL'].includes(u.searchParams.get('searchValue')??'')||!['','ALL'].includes(u.searchParams.get('searchLowItem')??''))throw new Error('Filtered/wrong-page legacy notice link');
  if(ids.has(id))throw new Error('Duplicate legacy notice identity');ids.add(id);
  const rowCells='childNodes'in row?row.childNodes.filter(n=>tag(n,'td')):[];
  const pinned=cms?all(a,n=>tag(n,'strong')&&text(n)==='[공지]').length>0:!photo&&text(rowCells[0])==='공지';
  let published:string,heading:string;
  if(cms){const spans=all(one(row,n=>cls(n,'info')),n=>tag(n,'span'));if(spans.length!==3)throw new Error('Invalid CMS notice metadata');published=date(text(spans[1]));
   // CMS truncates visible titles; its comment retains the full entity-encoded title.
   const comments=all(a,n=>n.nodeName==='#comment').map(n=>'data'in n?n.data.trim():'');if(comments.length>1)throw new Error('Ambiguous CMS full title');
   heading=comments.length?text(parse(`<textarea>${comments[0].replaceAll('<','&lt;')}</textarea>`)):text(a).replace(pinned?/^\[공지\]\s*/:/^$/, '');
   if(!pinned){const ordinal=one(row,n=>tag(n,'div')&&positive(text(n)));ordinals.push(Number(text(ordinal)));}
  }else if(photo){const metadata=text(one(row,n=>cls(n,'date')));const match=metadata.match(/^(\d{4}\.\d{2}\.\d{2}) \/ .+$/);if(!match)throw new Error('Invalid legacy photo metadata');published=date(match[1]);heading=text(a);
  }else{const cells='childNodes'in row?row.childNodes.filter(n=>tag(n,'td')):[];if(cells.length!==6)throw new Error('Invalid legacy notice row');published=date(text(cells[4]));heading=text(a);if(!pinned)ordinals.push(Number(text(cells[0])));}
  if(!pinned)regularIds.push(id);notices.push({id,source:source.id,title:title(heading),published,url:canonical});
 }
 if(photo){
  // Photo cards have no ordinals; the board's total proves page coverage instead.
  const total=Number(text(one(one(doc,n=>cls(n,'summary')&&cls(n,'local')),n=>tag(n,'em'))));
  if(!Number.isSafeInteger(total)||total<1||Math.ceil(total/10)!==last||regularIds.length!==Math.min(10,total-(page-1)*10))throw new Error('Conflicting legacy history coverage');
  return {notices,regularIds,regularCount:regularIds.length,done:page===last};
 }
 const size=source.id==='sweduNotice'||source.id==='sweduNews'||source.id==='sweduPress'?15:10;
 if(ordinals.some((n,i)=>!Number.isSafeInteger(n)||n<1||(i>0&&n!==ordinals[i-1]-1))||regularIds.length>size||!regularIds.length||(page<last&&regularIds.length!==size)||(page===last&&!ordinals.includes(1)))throw new Error('Conflicting legacy history coverage');
 return {notices,regularIds,regularCount:regularIds.length,done:page===last};
}
export function parseLegacyNoticeRaw(input:string,source:Source,notice:Notice):{bodyHtml:string;attachments:string[];imageUrls:string[]}{
 const doc=parse(input,{sourceCodeLocationInfo:true});identity(doc,source,notice.id);const cms=source.kind==='cms';const article=one(doc,n=>cls(n,cms?'board_read_wrap':'bbs-read'));
 const heading=cms?one(one(article,n=>cls(n,'post_info')),n=>cls(n,'title')):one(article,n=>cls(n,'subject'));
 if(text(heading)!==notice.title)throw new Error('Changed legacy notice title');
 const observed=cms?all(one(one(article,n=>cls(n,'post_info')),n=>cls(n,'info')),n=>tag(n,'span')).map(text).filter(v=>/^\d{4}\.\d{2}\.\d{2} /.test(v)).map(v=>v.slice(0,10)):all(article,n=>cls(n,'unit')&&all(n,x=>cls(x,'label')&&text(x)==='작성일').length===1).map(n=>text(one(n,x=>cls(x,'value'))));
 if(observed.length!==1||date(observed[0])!==notice.published)throw new Error('Changed legacy notice date');
 const body=one(article,n=>cls(n,cms?'post_cont':'substance'));const loc='tagName'in body?body.sourceCodeLocation:null;if(!loc?.startTag||!loc.endTag)throw new Error('Missing original legacy body offsets');
 const bodyHtml=input.slice(loc.startTag.endOffset,loc.endTag.startOffset);
 const resolve=(v:string)=>{const u=new URL(v,notice.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Invalid legacy archive reference');return u.href;};
 // Official CMS/WebSTYLIST attachment links use /Download, not file extensions.
 const attachments=all(cms?article:one(doc,n=>cls(n,'bbs-attachment')),n=>tag(n,'a')&&!!attr(n,'href')).filter(n=>new URL(attr(n,'href'),notice.url).pathname==='/Download').map(n=>resolve(attr(n,'href')));
 const bodyDoc=parse(bodyHtml);for(const a of all(bodyDoc,n=>tag(n,'a')&&!!attr(n,'href'))){if(('attrs'in a&&a.attrs.some(x=>x.name==='download'))||/\.(?:pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(?:[?#]|$)/i.test(attr(a,'href')))attachments.push(resolve(attr(a,'href')));}
 const imageUrls=all(bodyDoc,n=>tag(n,'img')&&!!attr(n,'src')&&!/^data:/i.test(attr(n,'src'))).map(n=>resolve(attr(n,'src')));
 return {bodyHtml,attachments:[...new Set(attachments)],imageUrls:[...new Set(imageUrls)]};
}
