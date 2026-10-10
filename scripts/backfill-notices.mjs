import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SOURCES} from '../src/sources.ts';
import {validateCollectorLaunch,validateEndpoint} from './notice-collector.mjs';
import {createArchiveClient,captureRawNotices} from './notice-archive-client.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function parseBackfillArgs(args) {
 let send=false,dry=false,start=false,pages;
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--send'&&!send)send=true;
  else if(arg==='--dry-run'&&!dry)dry=true;
  else if(arg==='--start'&&!start)start=true;
  else if(arg==='--pages'&&pages===undefined&&/^[1-6]$/.test(args[i+1]??''))pages=Number(args[++i]);
  else throw new Error('Usage: backfill-notices [--dry-run | --send] [--start] [--pages 1..6]');
 }
 if(send&&dry||start&&!send)throw new Error('Backfill --start requires --send; modes cannot be combined');
 return {send,start,pages:pages??(send?6:1)};
}
function activeProgress(result,sources,excluded) {
 if(!Array.isArray(result.sources)||new Set(result.sources.map(row=>row?.source)).size!==result.sources.length)throw new Error('Invalid archive status acknowledgement');
 for(const row of result.sources){
  if(!sources.some(source=>source.id===row?.source)||!Number.isSafeInteger(row.page)||row.page<1||!['active','done'].includes(row.state))throw new Error('Invalid archive status acknowledgement');
 }
 return result.sources.filter(row=>row.state==='active'&&!excluded.has(row.source));
}
export async function runBackfill({send=false,start=false,pages=send?6:1,client,collectPage,collectRaw,sources=SOURCES,sleep=delay,now=Date.now,log=console.log,maxMs=7*60_000}={}) {
 if(!Number.isInteger(pages)||pages<1||pages>6||start&&!send)throw new Error('Invalid backfill options');
 if(!collectPage||!collectRaw){const module=await import('../src/notice-archive-sources.ts');collectPage??=module.collectNoticePage;collectRaw??=module.collectNoticeRaw;}
 const began=now(),withinBudget=()=>now()-began<maxMs;
 if(!send){
  const source=sources[0];await sleep(3000);const page=await collectPage(source,1);let count=0;
  for(const notice of page.notices){if(!withinBudget())break;await sleep(3000);await collectRaw(notice);count++;}
  log(`${source.id}: dry-run page 1, ${count} raw articles checked; no uploads, checkpoints or model calls`);
  return 0;
 }
 if(typeof client!=='function')throw new Error('Archive client required for --send');
 if(start){const result=await client({action:'start'});if(result.started!==true)throw new Error('Invalid archive start acknowledgement');}
 const failedSources=new Set(),selected=new Map();let failures=0;
 for(let step=0;step<pages&&withinBudget();step++){
  const status=await client({action:'status'}),active=activeProgress(status,sources,failedSources);
  if(!active.length){log(status.sources.length?'No active backfill pages remain for this run':'Backfill not started; explicitly use --send --start after approval');break;}
  active.sort((a,b)=>{
   const at=Date.parse(a.updated_at),bt=Date.parse(b.updated_at);
   if(Number.isFinite(at)&&Number.isFinite(bt)&&at!==bt)return at-bt;
   return a.page-b.page||(selected.get(a.source)??-1)-(selected.get(b.source)??-1)||sources.findIndex(s=>s.id===a.source)-sources.findIndex(s=>s.id===b.source);
  });
  const cursor=active[0],source=sources.find(s=>s.id===cursor.source);selected.set(source.id,step);
  try{
   await sleep(3000);const result=await collectPage(source,cursor.page);
   if(!Array.isArray(result.notices)||typeof result.done!=='boolean'||!result.notices.length&&!result.done)throw new Error('Invalid source page');
   const capture=await captureRawNotices(source,result.notices,{client,collectRaw,sleep,paceMs:3000,beforeRecord:withinBudget,allowUnavailable:true});
   if(!capture.complete){log(`${source.id}: paused within page ${cursor.page}; saved records retained, cursor unchanged`);break;}
   const committed=await client({action:'commit',source:source.id,page:cursor.page,ids:result.notices.map(notice=>notice.id),done:result.done});
   if(committed.committed!==true||!Number.isSafeInteger(committed.page)||committed.page<=cursor.page||!['active','done'].includes(committed.state))throw new Error('Invalid archive commit acknowledgement');
   log(`${source.id}: page ${cursor.page} committed, ${capture.captured} raw articles captured, ${capture.unavailable} definitively unavailable, state ${committed.state}`);
  }catch{
   failedSources.add(source.id);failures++;log(`${source.id}: backfill page ${cursor.page} failed; resume from durable cursor next run`);
  }
 }
 return failures?1:0;
}
export async function main(args=process.argv.slice(2),env=process.env) {
 const options=parseBackfillArgs(args);validateCollectorLaunch(env);
 let client;
 if(options.send){
  if(env.NOTICE_ARCHIVE_ENABLED!=='true')throw new Error('NOTICE_ARCHIVE_ENABLED must be true before backfill upload');
  validateEndpoint(env.NOTICE_INGEST_URL);client=createArchiveClient({endpoint:env.NOTICE_INGEST_URL,secret:env.NOTICE_INGEST_SECRET});
 }
 return runBackfill({...options,client});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().then(code=>{process.exitCode=code;}).catch(()=>{
  console.error('Backfill startup failed; check arguments, archive enablement, certificate and ingress configuration. No secrets or source bodies are logged.');process.exitCode=1;
 });
}
