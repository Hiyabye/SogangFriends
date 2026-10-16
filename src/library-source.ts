import {parse,type DefaultTreeAdapterMap} from 'parse5';

export const LIBRARY_URL='https://libseat.sogang.ac.kr:444/SEAT/domian5.asp';
export interface LibrarySnapshot {total:number;used:number;remaining:number;sourceAt:string}
const MAX_BYTES=256*1024;
type Node=DefaultTreeAdapterMap['node'];
const children=(node:Node):Node[]=>'childNodes' in node?node.childNodes:[];
const tag=(node:Node,name:string)=>'tagName' in node&&node.tagName===name;
const attr=(node:Node,name:string)=>'attrs' in node?node.attrs.find(a=>a.name===name)?.value??'':'';
function all(node:Node,test:(node:Node)=>boolean):Node[]{
 const found:Node[]=[],stack=[node];
 while(stack.length){const current=stack.pop()!;if(test(current))found.push(current);stack.push(...children(current).slice().reverse());}
 return found;
}
function text(node:Node):string{return all(node,n=>n.nodeName==='#text').map(n=>'value'in n?n.value:'').join('').normalize('NFKC').replace(/\s+/g,' ').trim();}
function ancestor(node:Node,name:string):Node|undefined{
 let parent='parentNode'in node?node.parentNode:null;
 while(parent){if(tag(parent,name))return parent;parent='parentNode'in parent?parent.parentNode:null;}
}
function invalid():never{throw new Error('Invalid library snapshot');}
function integer(value:string):number{
 if(!/^\d+$/.test(value))invalid();
 const n=Number(value);if(!Number.isSafeInteger(n))invalid();return n;
}
function sourceTime(value:string,now:number):string{
 const m=value.match(/^(\d{4}-\d{2}-\d{2}) (오전|오후) (\d{1,2}):(\d{2}):(\d{2}) 현재$/);
 if(!m)invalid();
 const hour=Number(m[3]),minute=Number(m[4]),second=Number(m[5]);
 if(hour<1||hour>12||minute>59||second>59)invalid();
 const local=`${m[1]}T${String(hour%12+(m[2]==='오후'?12:0)).padStart(2,'0')}:${m[4]}:${m[5]}`;
 const at=Date.parse(`${local}+09:00`);
 if(!Number.isFinite(at)||new Date(at+9*3600_000).toISOString().slice(0,19)!==local||at<now-120_000||at>now+30_000)invalid();
 return new Date(at).toISOString();
}
/** Parse only the room's own aggregate table; detail maps and release estimates are not evidence. */
export function parseLibrarySnapshot(html:string,now=Date.now()):LibrarySnapshot{
 if(!Number.isFinite(now)||new TextEncoder().encode(html).length>MAX_BYTES*3)invalid();
 const doc=parse(html);
 const links=all(doc,n=>{
  if(!tag(n,'a'))return false;
  try{const u=new URL(attr(n,'href'),LIBRARY_URL);return u.origin===new URL(LIBRARY_URL).origin&&u.pathname==='/SEAT/roomview5.asp'&&!u.username&&!u.password&&!u.hash&&u.searchParams.size===1&&u.searchParams.get('room_no')==='5';}catch{return false;}
 });
 if(links.length!==1||text(links[0])!=='133 로욜라 인벤툼 II')invalid();
 const row=ancestor(links[0],'tr'),table=ancestor(links[0],'table');if(!row||!table)invalid();
 const rows=all(table,n=>tag(n,'tr')&&ancestor(n,'table')===table);
 const cells=children(row).filter(n=>tag(n,'td'));
 if(cells.length!==7||!all(cells[1],n=>n===links[0]).length)invalid();
 const headers=['순번','열람실명','전체 좌석수','사용 좌석수','잔여 좌석수','이용율(%)'];
 const headerRows=rows.filter(r=>{const c=children(r).filter(n=>tag(n,'td')||tag(n,'th'));return headers.every((h,i)=>c[i]&&text(c[i])===h);});
 if(headerRows.length!==1)invalid();
 const totalMatch=text(cells[2]).match(/^(\d+)\s*\((\d+)\)$/);if(!totalMatch)invalid();
 const total=integer(totalMatch[1]),accessible=integer(totalMatch[2]),used=integer(text(cells[3])),remaining=integer(text(cells[4]));
 const occupancy=text(cells[5]).match(/^(\d+(?:\.\d{1,2})?)\s*%$/);if(!occupancy)invalid();
 const percent=Number(occupancy[1]);
 if(total<1||accessible>total||used>total||remaining>total||used+remaining!==total||percent>100||Math.abs(percent-used/total*100)>0.011)invalid();
 const timestamps=rows.flatMap(r=>children(r).filter(n=>tag(n,'td')||tag(n,'th')).filter(c=>/^\d{4}-\d{2}-\d{2} /.test(text(c))).map(text));
 if(timestamps.length!==1)invalid();
 return {total,used,remaining,sourceAt:sourceTime(timestamps[0],now)};
}

/** Fixed origin/port, verified platform TLS, no redirects, bounded streaming and lifetime. */
export async function fetchLibrarySnapshot():Promise<LibrarySnapshot>{
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Library request timed out'));},8000);});
 try{
  return await Promise.race([timeout,(async()=>{
   const response=await fetch(LIBRARY_URL,{redirect:'manual',signal:controller.signal,headers:{'User-Agent':'SogangFriendsBot/0.1 (bounded library availability monitor)'}});
   if(!response.ok||!response.body||!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
    void response.body?.cancel().catch(()=>{});throw new Error('Library response rejected');
   }
   if(Number(response.headers.get('content-length'))>MAX_BYTES){void response.body.cancel().catch(()=>{});throw new Error('Library response too large');}
   reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw new Error('Library response too large');chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   return parseLibrarySnapshot(new TextDecoder('euc-kr',{fatal:true}).decode(bytes));
  })()]);
 }catch{throw new Error('Library collection failed');}
 finally{clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}
