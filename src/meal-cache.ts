import type {Env} from './types';
import {addDays,dayDifference,todayKst,validDate} from './time.ts';

export interface MealSource {url:string;imageUrl:string;published:string;start:string;end:string}
export function mealWindow(today=todayKst()):{start:string;end:string} {
 if(!validDate(today))throw new Error('Invalid meal retention date');
 const weekday=(new Date(`${today}T00:00:00Z`).getUTCDay()+6)%7;
 const start=addDays(today,-weekday);
 return {start,end:addDays(start,13)};
}
function validateSource(source:MealSource):void {
 if(!validDate(source.start)||!validDate(source.end)||!validDate(source.published)||dayDifference(source.start,source.end)!==6||new Date(`${source.start}T00:00:00Z`).getUTCDay()!==1||Math.abs(dayDifference(source.start,source.published))>45)throw new Error('Invalid meal source period');
 const article=new URL(source.url),image=new URL(source.imageUrl);
 if(source.url!==`https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=${article.searchParams.get('pkid')}`||! /^[1-9]\d*$/.test(article.searchParams.get('pkid')??'')||image.origin!=='https://scc.sogang.ac.kr'||!/^\/dataview\/board\/1185\/[^/]+\.(?:png|jpe?g)$/i.test(image.pathname)||image.search||image.hash||image.username||image.password)throw new Error('Invalid meal source URL');
}
export async function pruneMealContent(env:Env,today=todayKst()):Promise<void> {
 const window=mealWindow(today);
 await env.DB.batch([
  env.DB.prepare('DELETE FROM meal_sources WHERE start_date<? OR end_date>?').bind(window.start,window.end),
  env.DB.prepare('DELETE FROM meals WHERE start_date<? OR end_date>?').bind(window.start,window.end),
  // Retain the audit identity and reservation history, not expired derived menu bodies.
  env.DB.prepare("UPDATE jobs SET payload=json_remove(payload,'$.rejectedExtraction.data') WHERE kind='meal-extract' AND json_type(payload,'$.rejectedExtraction.data') IS NOT NULL AND (COALESCE(json_extract(payload,'$.rejectedExtraction.startDate'),json_extract(payload,'$.rejectedExtraction.data.start'))<? OR COALESCE(json_extract(payload,'$.rejectedExtraction.endDate'),json_extract(payload,'$.rejectedExtraction.data.end'))>?)").bind(window.start,window.end)
 ]);
}
export async function cacheMealSources(env:Env,sources:MealSource[],today=todayKst()):Promise<void> {
 const window=mealWindow(today);
 // Validate the complete capture before writing, so a failed capture preserves last-good metadata.
 for(const source of sources)validateSource(source);
 const kept=sources.filter(source=>source.start>=window.start&&source.end<=window.end);
 if(!kept.length)return;
 const at=new Date().toISOString();
 await env.DB.batch(kept.map(source=>env.DB.prepare('INSERT INTO meal_sources(source_url,image_url,published,start_date,end_date,verified_at) VALUES(?,?,?,?,?,?) ON CONFLICT(start_date,end_date) DO UPDATE SET source_url=excluded.source_url,image_url=excluded.image_url,published=excluded.published,verified_at=excluded.verified_at WHERE excluded.published>=meal_sources.published').bind(source.url,source.imageUrl,source.published,source.start,source.end,at)));
}
export async function mealImageSource(env:Env,date:string):Promise<MealSource|null> {
 if(!validDate(date))return null;
 const window=mealWindow();if(date<window.start||date>window.end)return null;
 const row=await env.DB.prepare('SELECT source_url,image_url,published,start_date,end_date FROM meal_sources WHERE start_date<=? AND end_date>=? AND start_date>=? AND end_date<=? ORDER BY published DESC,verified_at DESC LIMIT 1').bind(date,date,window.start,window.end).first<{source_url:string;image_url:string;published:string;start_date:string;end_date:string}>();
 return row?{url:row.source_url,imageUrl:row.image_url,published:row.published,start:row.start_date,end:row.end_date}:null;
}
