import {parse,type DefaultTreeAdapterMap} from 'parse5';

export const LIBRARY_URL='https://libseat.sogang.ac.kr:444/SEAT/roomview5.asp?room_no=5';
const EXCLUDED_SEATS=new Set([1,3,44,85,101,102]);
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
/** Read all seat states before excluding the user-selected disability/recliner seats. */
export function parseLibrarySnapshot(html:string,now=Date.now()):LibrarySnapshot{
 if(!Number.isFinite(now)||new TextEncoder().encode(html).length>MAX_BYTES*3)invalid();
 // parse5 otherwise silently keeps only the first of conflicting duplicate attributes.
 let duplicateAttribute=false;
 const doc=parse(html,{onParseError:error=>{if(error.code==='duplicate-attribute')duplicateAttribute=true;}});
 if(duplicateAttribute)invalid();
 const summaries=all(doc,n=>tag(n,'tr')).map(row=>children(row).filter(n=>tag(n,'td')))
  .filter(cells=>cells.length===5&&text(cells[0])==='133 로욜라 인벤툼 II');
 if(summaries.length!==1)invalid();
 const cells=summaries[0];
 const count=(index:number,label:string)=>{
  const match=text(cells[index]).match(new RegExp(`^${label}\\s*:\\s*(\\d+)$`));
  if(!match)invalid();return integer(match[1]);
 };
 const total=count(1,'총 좌석수'),used=count(2,'사용 좌석수'),remaining=count(3,'잔여 좌석수');
 if(total!==102||used+remaining!==total)invalid();
 const sourceAt=sourceTime(text(cells[4]),now);
 for(const [label,color] of [['사용중','red'],['미사용','gray']]){
  const legend=all(doc,n=>tag(n,'td')&&text(n)===label);
  if(legend.length!==1||attr(legend[0],'bgcolor').trim().toLowerCase()!==color)invalid();
 }
 const maps=all(doc,n=>attr(n,'id')==='maptemp'),backgrounds=all(doc,n=>attr(n,'id')==='backimage');
 if(maps.length!==1||!tag(maps[0],'div')||backgrounds.length!==1)invalid();
 const map=maps[0],background=backgrounds[0];
 if(!children(map).includes(background)||!tag(background,'div'))invalid();
 const images=all(background,n=>tag(n,'img'));
 if(images.length!==1)invalid();
 try{
  const image=new URL(attr(images[0],'src'),LIBRARY_URL);
  if(image.href!==new URL('./MAP/5-back.jpg',LIBRARY_URL).href)invalid();
 }catch{invalid();}
 const layers=all(doc,n=>/^Layer/i.test(attr(n,'id')));
 if(layers.length!==102||all(map,n=>tag(n,'td')).length!==102)invalid();
 const seen=new Set<number>();let mapRemaining=0,eligibleRemaining=0;
 for(const layer of layers){
  const match=attr(layer,'id').match(/^Layer([1-9]\d*)$/);
  if(!match||!tag(layer,'div')||!children(map).includes(layer))invalid();
  const seat=integer(match[1]);
  if(seat>102||seen.has(seat))invalid();seen.add(seat);
  const statuses=all(layer,n=>tag(n,'td'));
  if(statuses.length!==1||text(statuses[0])!==String(seat)||text(layer)!==String(seat))invalid();
  const color=attr(statuses[0],'bgcolor').trim().toLowerCase();
  if(!['red','gray'].includes(color)||/background(?:-color)?\s*:/i.test(attr(statuses[0],'style')))invalid();
  if(color==='gray'){mapRemaining++;if(!EXCLUDED_SEATS.has(seat))eligibleRemaining++;}
 }
 // Summary and map come from one response; do not combine two independently changing pages.
 if(mapRemaining!==remaining)invalid();
 return {total:96,used:96-eligibleRemaining,remaining:eligibleRemaining,sourceAt};
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
