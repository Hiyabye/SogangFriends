#!/usr/bin/env node
/** Bounded, read-only official history capture for local crop/date verification. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MEAL_SOURCE_URL,parseMealList,parseMealImage,fetchImage,sourceBytes} from '../../src/sources.ts';
import {validateCollectorLaunch} from '../notice-collector.mjs';

const OUTPUT=fileURLToPath(new URL('./output/cross-week-sources/',import.meta.url));
const EXCLUDED_WEEK='2026-10-12';
const MAX_WEEKS=5;

async function officialHtml(value) {
 const url=new URL(value);
 if(url.origin!=='https://scc.sogang.ac.kr'||!['/front/cmsboardlist.do','/front/cmsboardview.do'].includes(url.pathname)||url.searchParams.get('bbsConfigFK')!=='1185'||url.searchParams.get('siteId')!=='dormitory')throw new Error('Unexpected meal board URL');
 // Existing sourceBytes bounds streaming HTML to 2 MiB, uses a 20-second timeout,
 // refuses redirects, and spaces source requests by at least one second.
 const response=await sourceBytes(url.href);
 if(!response.type.toLowerCase().includes('text/html'))throw new Error('Expected board HTML');
 return new TextDecoder('utf-8',{fatal:true}).decode(response.bytes);
}

export async function sampleWeeks(env=process.env) {
 // Also calls verifyCertificate: one pinned intermediate, validated against roots.
 validateCollectorLaunch(env);
 await mkdir(fileURLToPath(new URL('./output/',import.meta.url)),{recursive:true});
 // Never overwrite an earlier capture or mix results from separate sampling runs.
 await mkdir(OUTPUT);
 const candidates=new Map(),pageFailures=[];
 for(let page=1;page<=2;page++){
  const url=new URL(MEAL_SOURCE_URL);url.searchParams.set('currentPage',String(page));
  try{
   for(const article of parseMealList(await officialHtml(url.href))){
    if(article.start===EXCLUDED_WEEK)continue;
    const prior=candidates.get(article.start);
    if(!prior||article.published>prior.published)candidates.set(article.start,article);
   }
  }catch(error){
   // The shared parser rejects a whole page containing an ambiguous/partial week.
   // Do not relax source validation or let that discard a separately valid page.
   pageFailures.push({page,reason:error.name==='SourceHttpError'?`source_http_${error.status}`:'source_page_rejected'});
  }
 }
 const recent=[...candidates.values()].sort((a,b)=>b.start.localeCompare(a.start)||b.published.localeCompare(a.published));
 const crossing=recent.find(article=>article.start.slice(0,7)!==article.end.slice(0,7));
 // One spare candidate allows a rejected/deleted article without retaining over five images.
 const selected=(crossing?[crossing,...recent.filter(article=>article.start!==crossing.start)]:recent).slice(0,MAX_WEEKS+1);
 if(!selected.length)throw new Error('No other complete menu weeks in the bounded board pages');
 const manifest={evaluationOnly:true,capturedAt:new Date().toISOString(),pagesRead:2,excludedWeek:EXCLUDED_WEEK,maximumWeeks:MAX_WEEKS,pageFailures,sources:[],failures:[]};
 for(const article of selected){
  if(manifest.sources.length===MAX_WEEKS)break;
  try{
   const imageUrl=parseMealImage(await officialHtml(article.url),article);
   const image=await fetchImage(imageUrl);
   const filename=`${article.start}-${new URL(article.url).searchParams.get('pkid')}.${image.mime==='image/png'?'png':'jpg'}`;
   await writeFile(resolve(OUTPUT,filename),image.bytes,{flag:'wx'});
   manifest.sources.push({...article,imageUrl,imageHash:image.hash,imageBytes:image.bytes.length,mime:image.mime,filename});
  }catch(error){
   // Diagnostic identity only: never upstream HTML, authors, or full error bodies.
   manifest.failures.push({start:article.start,url:article.url,reason:error.name==='SourceHttpError'?`source_http_${error.status}`:'source_capture_failed'});
  }
 }
 await writeFile(resolve(OUTPUT,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return manifest;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.length!==2){console.error('Usage: NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem node scripts/meal-ocr/sample-weeks.mjs');process.exitCode=1;}
 else sampleWeeks().then(manifest=>{
  console.log(JSON.stringify({output:OUTPUT,sources:manifest.sources.map(({start,end,filename,imageBytes})=>({start,end,filename,imageBytes})),pageFailures:manifest.pageFailures,failures:manifest.failures},null,2));
  if(!manifest.sources.length||manifest.failures.length)process.exitCode=1;
 }).catch(()=>{console.error('Cross-week sampling failed; inspect TLS configuration, source structure, or whether the fresh output directory already exists. No upstream bodies logged.');process.exitCode=1;});
}
