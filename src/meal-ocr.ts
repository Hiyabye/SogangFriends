import type {Env,MealWeek} from './types';
import {verifyCollectorRequest} from './notice-ingest';
import {cacheMealSources,mealWindow,type MealSource} from './meal-cache';
import {validateMeal} from './meals';
import {addDays,dayDifference,validDate} from './time';
import {nowIso} from './storage';

export const OCR_VERSION='ocr-v1';
interface ObservedIdentity {banner:string[];headers:string[][]}
interface Capture {source:MealSource;imageHash:string;version:typeof OCR_VERSION;key:string}
const weekdays=['월요일','화요일','수요일','목요일','금요일','토요일','일요일'];
function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid OCR object');
 return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,expected:string[]):void {
 if(Object.keys(value).length!==expected.length||expected.some(key=>!Object.hasOwn(value,key)))throw new Error('Unexpected OCR fields');
}
function lines(value:unknown):string[] {
 if(!Array.isArray(value)||!value.length||value.length>12||value.some(line=>typeof line!=='string'||!line.trim()||line.length>150))throw new Error('Invalid observed text');
 return value as string[];
}
function canonical(year:number,month:number,day:number):string {
 const date=`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 if(!validDate(date))throw new Error('Invalid observed calendar date');
 return date;
}
/** Validate actual OCR observations; expected dates only check them, never fill missing text. */
export function validateObservedIdentity(value:unknown,source:Pick<MealSource,'start'|'end'>):ObservedIdentity {
 const identity=object(value);keys(identity,['banner','headers']);
 const banner=lines(identity.banner),text=banner.join('').normalize('NFC').replace(/\s/g,'');
 const ranges=[...text.matchAll(/(?<!\d)(\d{4})[.,/-](\d{1,2})[.,/-](\d{1,2})[~～\-–](?:(\d{4})[.,/-])?(\d{1,2})[.,/-](\d{1,2})(?!\d)/g)];
 if(ranges.length!==1)throw new Error('Unobserved or ambiguous banner');
 const range=ranges[0],year=Number(range[1]),month=Number(range[2]);
 const start=canonical(year,month,Number(range[3]));
 const endYear=range[4]?Number(range[4]):year+(Number(range[5])<month?1:0);
 const end=canonical(endYear,Number(range[5]),Number(range[6]));
 if(start!==source.start||end!==source.end||dayDifference(start,end)!==6||new Date(`${start}T00:00:00Z`).getUTCDay()!==1)throw new Error('Conflicting observed banner');
 if(!Array.isArray(identity.headers)||identity.headers.length!==7)throw new Error('Seven observed headers required');
 const headers=identity.headers.map((header,index)=>{
  const observed=lines(header),text=observed.join('').normalize('NFC').replace(/\s/g,'');
  const dates=[...text.matchAll(/(?<!\d)(\d{1,2})월(\d{1,2})일?(?!\d)/g)];
  const names=text.match(/[월화수목금토일]요일/g)??[];
  const years=[...text.matchAll(/(\d{4})년/g)];
  const expected=addDays(start,index);
  if(dates.length!==1||names.length!==1||names[0]!==weekdays[index]||Number(dates[0][1])!==Number(expected.slice(5,7))||Number(dates[0][2])!==Number(expected.slice(8,10))||years.length>1||(years.length===1&&Number(years[0][1])!==Number(expected.slice(0,4))))throw new Error('Conflicting observed column date or weekday');
  return observed;
 });
 return {banner,headers};
}
function capture(data:Record<string,unknown>):Capture {
 const raw=object(data.source);keys(raw,['url','imageUrl','published','start','end']);
 if(Object.values(raw).some(value=>typeof value!=='string'))throw new Error('Invalid OCR source');
 const source=raw as unknown as MealSource;
 if(!validDate(source.start)||!validDate(source.end)||!validDate(source.published)||dayDifference(source.start,source.end)!==6||new Date(`${source.start}T00:00:00Z`).getUTCDay()!==1||Math.abs(dayDifference(source.published,source.start))>45)throw new Error('Invalid OCR source period');
 if(!/^https:\/\/scc\.sogang\.ac\.kr\/front\/cmsboardview\.do\?bbsConfigFK=1185&siteId=dormitory&pkid=[1-9]\d{0,19}$/.test(source.url))throw new Error('Invalid OCR source URL');
 if(source.imageUrl!==source.url&&!/^https:\/\/scc\.sogang\.ac\.kr\/dataview\/board\/1185\/[^/?#]+\.(?:png|jpe?g)$/i.test(source.imageUrl))throw new Error('Invalid OCR image URL');
 if(new URL(source.url).href!==source.url||new URL(source.imageUrl).href!==source.imageUrl)throw new Error('Noncanonical OCR source URL');
 if(typeof data.imageHash!=='string'||! /^[a-f0-9]{64}$/.test(data.imageHash)||data.version!==OCR_VERSION)throw new Error('Invalid OCR processing identity');
 retained(source);
 return {source,imageHash:data.imageHash,version:OCR_VERSION,key:`${data.imageHash}:${OCR_VERSION}:${source.start}:${source.end}:${source.url}`};
}
function retained(source:MealSource):void {
 const window=mealWindow();
 if(source.start<window.start||source.end>window.end)throw new Error('OCR source outside retained weeks');
}
const CURRENT='SELECT 1 FROM meal_sources WHERE source_url=? AND image_url=? AND published=? AND start_date=? AND end_date=?';
const sourceValues=(source:MealSource)=>[source.url,source.imageUrl,source.published,source.start,source.end];
async function current(env:Env,source:MealSource):Promise<boolean> {
 return Boolean(await env.DB.prepare(CURRENT).bind(...sourceValues(source)).first());
}
export async function handleMealOcr(request:Request,env:Env):Promise<Response> {
 if(!env.MEAL_OCR_INGEST_SECRET||env.MEAL_OCR_INGEST_SECRET.length<32)return new Response('OCR ingestion disabled',{status:503});
 const verified=await verifyCollectorRequest(request,env.MEAL_OCR_INGEST_SECRET);
 if(verified instanceof Response)return verified;
 let data:Record<string,unknown>,identity:Capture,meal:MealWeek|undefined;
 try{
  data=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(verified.body)));
  if(data.action==='lookup')keys(data,['action','source','imageHash','version']);
  else if(data.action==='store')keys(data,['action','source','imageHash','version','engine','identity','meal']);
  else throw new Error('Invalid OCR action');
  identity=capture(data);
  if(data.action==='store'){
   if(data.engine!=='paddle'&&data.engine!=='easy')throw new Error('Invalid OCR engine');
   validateObservedIdentity(data.identity,identity.source);
   meal=validateMeal(data.meal,identity.source);
  }
 }catch{return new Response('Invalid OCR capture',{status:400});}
 try{
  const {source,key,imageHash,version}=identity;
  if(data.action==='lookup'){
   // Source capture is separate from OCR success so the official-image fallback remains usable.
   await cacheMealSources(env,[source]);
   if(!await current(env,source))return new Response('OCR source superseded',{status:409});
   retained(source);
   const result=await env.DB.prepare(`UPDATE meals SET verified_at=? WHERE cache_key=? AND source_url=? AND image_hash=? AND version=? AND start_date=? AND end_date=? AND EXISTS(${CURRENT}) RETURNING cache_key`).bind(nowIso(),key,source.url,imageHash,version,source.start,source.end,...sourceValues(source)).first();
   return Response.json({cached:Boolean(result)});
  }
  if(!await current(env,source))return new Response('OCR source superseded or not captured',{status:409});
  retained(source);
  const at=nowIso(),model=data.engine==='paddle'?'paddleocr':'easyocr';
  // Conditional writes and the health update share one transaction. A source changed
  // after preflight cannot insert stale serving data or falsely mark OCR healthy.
  const results=await env.DB.batch([
   env.DB.prepare(`INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(${CURRENT}) ON CONFLICT(cache_key) DO NOTHING`).bind(key,source.url,imageHash,version,source.start,source.end,JSON.stringify(meal),at,at,model,...sourceValues(source)),
   env.DB.prepare(`INSERT INTO health(id,last_attempt,last_success,error) SELECT 'meal',?,?,NULL WHERE EXISTS(${CURRENT}) AND EXISTS(SELECT 1 FROM meals WHERE cache_key=?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,error=NULL`).bind(at,at,...sourceValues(source),key),
   env.DB.prepare(`SELECT cache_key FROM meals WHERE cache_key=? AND EXISTS(${CURRENT})`).bind(key,...sourceValues(source))
  ]);
  if(!results[2].results.length)return new Response('OCR source superseded',{status:409});
  return Response.json({accepted:true,cached:results[0].meta.changes===0});
 }catch{return new Response('OCR cache unavailable or retention expired',{status:503});}
}
