import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {parseMealImage,fetchImage} from '../src/sources';
import {cacheMealSources,mealImageSource,type MealSource} from '../src/meal-cache';
import {testDatabase} from './helpers/db';

const article:MealSource={url:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=123',imageUrl:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=123',published:'2026-10-08',start:'2026-10-12',end:'2026-10-18'};
const fixture=readFileSync(new URL('./fixtures/meal-article.html',import.meta.url),'utf8');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const reference=(bytes:Uint8Array=png)=>`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const html=(src=reference())=>fixture.replace('http://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg',src);
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('official inline meal PNGs',()=>{
 it('uses the verified article as the inline fetch identity, never a stored data URL',()=>{
  expect(parseMealImage(html(),article)).toBe(article.url);
  expect(parseMealImage(fixture,article)).toBe('https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg');
 });
 it('retains article title, board, post, and canonical URL validation',()=>{
  for(const input of [html().replace('value="123"','value="124"'),html().replace('value="1185"','value="1186"'),html().replace('12일 ~ 10월 18일','19일 ~ 10월 25일'),html().replace('<div class="post_cont">','<div class="post_cont"><img src="'+reference()+'">')])expect(()=>parseMealImage(input,article)).toThrow();
  expect(()=>parseMealImage(html(),{...article,url:'https://example.com/?pkid=123'})).toThrow('Disallowed meal article');
 });
 it('rejects non-PNG data, invalid or noncanonical base64, and bad PNG signatures',()=>{
  for(const src of ['data:image/jpeg;base64,'+png.toString('base64'),'data:image/png,'+png.toString('base64'),reference()+'!',reference()+'\n','data:image/png;base64,','data:image/png;base64,AAAA','data:image/png;base64,a===','data:image/png;base64,AB=='])expect(()=>parseMealImage(html(src),article)).toThrow();
  const bad=Buffer.from(png);bad[0]=0;expect(()=>parseMealImage(html(reference(bad)),article)).toThrow('Invalid inline meal PNG');
 });
 it('bounds decoded bytes and PNG dimensions before accepting an inline source',()=>{
  const oversized=Buffer.alloc(5*1024*1024+1);expect(()=>parseMealImage(html(reference(oversized)),article)).toThrow('Invalid inline meal base64');
  for(const [width,height] of [[0,1],[1,0],[10000,3000]]){
   const bytes=Buffer.from(png);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);
   expect(()=>parseMealImage(html(reference(bytes)),article)).toThrow('Invalid inline meal dimensions');
  }
  const bad=Buffer.from(png);bad.writeUInt32BE(12,8);expect(()=>parseMealImage(html(reference(bad)),article)).toThrow('Invalid inline meal PNG');
 });
 it('refetches only the official article and hashes the transient PNG bytes',async()=>{
  const fetcher=vi.fn(async(url:unknown,options?:RequestInit)=>{
   expect(url).toBe(article.url);expect(options?.redirect).toBe('manual');
   return new Response(html(),{headers:{'content-type':'text/html;charset=utf-8'}});
  });vi.stubGlobal('fetch',fetcher);
  const result=await fetchImage(article.url);
  expect(Buffer.from(result.bytes)).toEqual(png);expect(result.mime).toBe('image/png');expect(result.hash).toBe(createHash('sha256').update(png).digest('hex'));expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('rejects a wrong fetched board/post and articles no longer containing an inline PNG',async()=>{
  for(const input of [html().replace('value="123"','value="124"'),html().replace('value="1185"','value="1186"'),fixture]){
   vi.stubGlobal('fetch',vi.fn(async()=>new Response(input,{headers:{'content-type':'text/html'}})));
   await expect(fetchImage(article.url)).rejects.toThrow();
  }
 },15_000);
 it('does not accept direct data URLs or noncanonical/foreign article identities',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  for(const url of [reference(),article.url+'#image',article.url+'&other=1',article.url.replace('scc.sogang.ac.kr','example.com'),article.url.replace('pkid=123','pkid=0')])await expect(fetchImage(url)).rejects.toThrow('Disallowed');
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects non-HTML responses and oversized article responses',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(html(),{headers:{'content-type':'image/png'}})));
  await expect(fetchImage(article.url)).rejects.toThrow('Expected source HTML');
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('small',{headers:{'content-type':'text/html','content-length':'8000000'}})));
  await expect(fetchImage(article.url)).rejects.toThrow('Source too large');
 },10_000);
 it('accepts the official temporary upload path through parsing, download and cache',async()=>{
  const imageUrl='https://scc.sogang.ac.kr/dataview/temp/'+encodeURIComponent('주간메뉴표 (2026)1019 최종 (1).jpg');
  expect(parseMealImage(html(imageUrl.replace('https:','http:')),article)).toBe(imageUrl);
  const bytes=new Uint8Array([255,216,255,224]);
  const fetcher=vi.fn(async()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}}));vi.stubGlobal('fetch',fetcher);
  expect((await fetchImage(imageUrl)).bytes).toEqual(bytes);
  expect(fetcher.mock.calls).toHaveLength(1);
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-13T00:00:00Z'));
  const db=testDatabase();try{
   await cacheMealSources(db.env,[{...article,imageUrl}]);
   expect((await mealImageSource(db.env,'2026-10-13'))?.imageUrl).toBe(imageUrl);
   for(const invalid of [imageUrl+'?download=1',imageUrl+'#image',imageUrl.replace('/temp/','/temp/nested/'),imageUrl.replace('scc.sogang.ac.kr','example.com'),imageUrl.replace('https:','http:'),imageUrl.replace('.jpg','.svg')]){
    await expect(fetchImage(invalid)).rejects.toThrow('Disallowed');
    await expect(cacheMealSources(db.env,[{...article,imageUrl:invalid}])).rejects.toThrow();
   }
   expect(fetcher).toHaveBeenCalledTimes(1);
  }finally{db.close();}
 });
 it('keeps remote JPEG download behavior unchanged',async()=>{
  const bytes=new Uint8Array([255,216,255,224]);vi.stubGlobal('fetch',vi.fn(async()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}})));
  const result=await fetchImage('https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg');expect(result.bytes).toEqual(bytes);expect(result.mime).toBe('image/jpeg');
 });
 it('caches the inline article identity only for its matching retained week',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-13T00:00:00Z'));
  const db=testDatabase();try{
   await cacheMealSources(db.env,[article]);expect((await mealImageSource(db.env,'2026-10-13'))?.imageUrl).toBe(article.url);
   const stored=db.sqlite.prepare('SELECT image_url FROM meal_sources').get();expect(stored?.image_url).toBe(article.url);
   await expect(cacheMealSources(db.env,[{...article,imageUrl:reference()}])).rejects.toThrow();
   await expect(cacheMealSources(db.env,[{...article,imageUrl:article.url.replace('pkid=123','pkid=124')}])).rejects.toThrow();
   expect(await mealImageSource(db.env,'2026-10-26')).toBeNull();
  }finally{db.close();}
 });
});
