import {describe,it,expect,vi,afterEach} from 'vitest';
import {validateMeal,reusableMeal,formatMeal,extractMeal,MealExtractionError} from '../src/meals';
import type {Env} from '../src/types';
const expected={start:'2026-10-12',end:'2026-10-18',published:'2026-10-08'};
const metadata=()=>({id:'custom/model:free',architecture:{input_modalities:['text','image']},supported_parameters:['structured_outputs','response_format'],pricing:{prompt:'0',completion:'0',image:'0',request:'0'}});
const env={LLM_ENABLED:'true',OPENROUTER_API_KEY:'fixture',MEAL_MODEL:'custom/model:free'} as Env;
const image={bytes:new Uint8Array([255,216,255]),mime:'image/jpeg'};
const unknown=()=>({status:'unknown',items:[],time:null,evidence:''});
const sample=()=>({start:expected.start,end:expected.end,certain:true,days:Array.from({length:7},(_,i)=>({date:`2026-10-${12+i}`,weekday:i+1,breakfastKorean:unknown(),breakfastWestern:unknown(),breakfastCommon:unknown(),cupRice:unknown(),dinner:unknown(),drinks:unknown()}))});
afterEach(()=>vi.unstubAllGlobals());
describe('strict observed meal validation',()=>{
 it('maps reordered valid observations by actual date, not array position',()=>{const x=sample();x.days.reverse();expect(validateMeal(x,expected).days[0].date).toBe('2026-10-12');});
 it('rejects duplicate, omitted and conflicting weekdays or dates',()=>{const x=sample();x.days[1].date=x.days[0].date;expect(()=>validateMeal(x,expected)).toThrow();const y=sample();y.days[0].weekday=2;expect(()=>validateMeal(y,expected)).toThrow();const z=sample();z.days.pop();expect(()=>validateMeal(z,expected)).toThrow();});
 it('rejects uncertainty/banner conflict and title-publication conflict',()=>{expect(()=>validateMeal({...sample(),certain:false},expected)).toThrow();expect(()=>validateMeal({...sample(),start:'2026-10-19'},expected)).toThrow();expect(()=>validateMeal(sample(),{...expected,published:'2025-01-01'})).toThrow();});
 it('distinguishes unknown from explicit closed and requires evidence',()=>{const x=sample();x.days[0].dinner={status:'closed',items:[],time:null,evidence:'휴무'};const w=validateMeal(x,expected);expect(formatMeal(w,'2026-10-12','https://school.example')).toContain('석식: 미운영');expect(formatMeal(w,'2026-10-13','https://school.example')).toContain('석식: 확인 불가');x.days[0].dinner.evidence='';expect(()=>validateMeal(x,expected)).toThrow();});
 it('shows cup rice on ANY day only with date-specific evidence, checks explicit time',()=>{const x=sample();x.days[0].cupRice={status:'available',items:['컵밥'],time:'11:40' as never,evidence:'10/12 컵밥 11:40'};const w=validateMeal(x,expected);expect(formatMeal(w,'2026-10-12','https://school.example')).toContain('컵밥: 컵밥 (11:40)');expect(formatMeal(w,'2026-10-13','https://school.example')).not.toContain('컵밥:');x.days[0].cupRice.evidence='컵밥';expect(()=>validateMeal(x,expected)).toThrow();});
 it('rejects invalid enum/types and available menu without evidence',()=>{const x=sample() as any;x.days[0].dinner.status='false';expect(()=>validateMeal(x,expected)).toThrow();x.days[0].dinner={status:'available',items:['Rice'],time:null,evidence:''};expect(()=>validateMeal(x,expected)).toThrow();});
 it('does not show expired cached meal as current',()=>{const w=validateMeal(sample(),expected);expect(formatMeal(w,'2026-10-19','https://school.example')).toBe('2026-10-19 식단 확인 불가\n원문: <https://school.example>');});
 it('reuses only same image, version, source and period',()=>{const id={image_hash:'abc',version:'v1',source_url:'https://school.example',start_date:expected.start,end_date:expected.end};expect(reusableMeal(id,id)).toBe(true);for(const field of Object.keys(id))expect(reusableMeal(id,{...id,[field]:'changed'})).toBe(false);});
 it('missing API key does not call external services',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(extractMeal({LLM_ENABLED:'true'} as Env,{bytes:new Uint8Array([1]),mime:'image/jpeg'},expected)).rejects.toThrow('key missing');expect(fetcher).not.toHaveBeenCalled();});
 it('checks free metadata, sends inline image and strict schema with zero-price routing',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[metadata()]}))).mockResolvedValueOnce(new Response(JSON.stringify({model:'custom/model:free',choices:[{finish_reason:'stop',message:{content:JSON.stringify(sample())}}],usage:{cost:0}})));
  vi.stubGlobal('fetch',fetcher);const r=await extractMeal(env,image,expected);expect(r.actualCost).toBe(0);
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual');expect(fetcher.mock.calls[1][1].redirect).toBe('manual');
  const body=JSON.parse(fetcher.mock.calls[1][1].body);expect(body.max_tokens).toBe(6000);expect(body.provider.require_parameters).toBe(true);
  expect(body.provider.max_price).toEqual({prompt:0,completion:0,image:0,request:0});expect(body.response_format.json_schema.strict).toBe(true);
  expect(body.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,/9j/');expect(body.messages[0].content[0].text).not.toContain(expected.start);
 });
 it('does not follow catalog redirects or attempt inference after redirect rejection',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://example.com/untrusted'}}));vi.stubGlobal('fetch',fetcher);
  await expect(extractMeal(env,image,expected)).rejects.toThrow('Model service HTTP 302');expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
 });
 it('rejects paid model IDs before any network call even if pricing might be zero',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(extractMeal({...env,MEAL_MODEL:'custom/model'},image,expected)).rejects.toThrow('Only :free');expect(fetcher).not.toHaveBeenCalled();
 });
 it('uses Gemma default JSON mode with explicit schema prompt and unchanged semantic validation',async()=>{
  const free={...metadata(),id:'google/gemma-4-31b-it:free',supported_parameters:['response_format']};
  const response=(content:string)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage:{cost:0}}));
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[free]}))).mockResolvedValueOnce(response(JSON.stringify(sample())));vi.stubGlobal('fetch',fetcher);
  await extractMeal({...env,MEAL_MODEL:undefined},image,expected);const body=JSON.parse(fetcher.mock.calls[1][1].body);
  expect(body.model).toBe(free.id);expect(body.response_format).toEqual({type:'json_object'});expect(body.messages[0].content[0].text).toContain('breakfastKorean');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[free]}))).mockResolvedValueOnce(response(JSON.stringify({...sample(),certain:false}))));
  await expect(extractMeal({...env,MEAL_MODEL:undefined},image,expected)).rejects.toThrow('output rejected');
 });
 it('caps maximum valid menus while preserving the complete original link and labels',()=>{
  const x=sample() as any;
  for(const key of ['breakfastKorean','breakfastWestern','dinner','cupRice']) x.days[0][key]={status:'available',items:Array(20).fill('메뉴😀'.repeat(25)),time:key==='cupRice'?'11:40':null,evidence:'10/12 메뉴 11:40'};
  const url='https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660';
  const text=formatMeal(validateMeal(x,expected),expected.start,url);
  expect(text.length).toBeLessThanOrEqual(2000);expect(text.endsWith(`원문: <${url}>`)).toBe(true);
  for(const label of ['조식 한식:','조식 양식·일품:','석식:','컵밥:'])expect(text).toContain(label);
  expect(text).toContain('일부 생략');expect(text).toContain('(11:40)');
 });
 it('refuses expensive, unpriced and extra-charge models before inference',async()=>{
  for(const pricing of [{prompt:'1',completion:'1'},undefined,{prompt:'0',completion:'0',audio:'0.01'}]){
   const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:[{...metadata(),pricing}]})));vi.stubGlobal('fetch',fetcher);
   const error=await extractMeal(env,image,expected).catch(e=>e);expect(error).toBeInstanceOf(MealExtractionError);expect(error.safeRetry).toBe(true);expect(error.actualCost).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1);
  }
 });
 it('rejects any image or request charge even with free text pricing',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:[{...metadata(),pricing:{prompt:'0',completion:'0',image:'.2',request:'.1'}}]})));vi.stubGlobal('fetch',fetcher);
  await expect(extractMeal(env,image,expected)).rejects.toThrow('Only zero-price');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('preserves available cost for rejected dates, invalid JSON, refusal and missing choices',async()=>{
  for(const response of [
   {choices:[{finish_reason:'stop',message:{content:JSON.stringify({...sample(),certain:false})}}]},
   {choices:[{finish_reason:'stop',message:{content:'not json'}}]},
   {choices:[{finish_reason:'stop',message:{content:'{}',refusal:'no'}}]},
   {choices:[]}
  ]){
   vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[metadata()]}))).mockResolvedValueOnce(new Response(JSON.stringify({...response,usage:{cost:.012}}))));
   const error=await extractMeal(env,image,expected).catch(e=>e);expect(error).toBeInstanceOf(MealExtractionError);expect(error.actualCost).toBe(.012);expect(error.safeRetry).toBe(true);
  }
 });
 it('retries confirmed 429 rejection but not ambiguous inference transport',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[metadata()]}))).mockResolvedValueOnce(new Response('',{status:429,headers:{'Retry-After':'15'}}));vi.stubGlobal('fetch',fetcher);
  const rate=await extractMeal(env,image,expected).catch(e=>e);expect(rate).toBeInstanceOf(MealExtractionError);expect(rate.safeRetry).toBe(true);expect(rate.retryAfter).toBe(15);expect(rate.actualCost).toBeNull();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[metadata()]}))).mockRejectedValueOnce(new Error('network secret')));
  const unknown=await extractMeal(env,image,expected).catch(e=>e);expect(unknown.safeRetry).toBe(false);expect(unknown.message).not.toContain('secret');
 });
 it('records only numeric quota diagnostics after a confirmed inference 429',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({data:[metadata()]}))
   .mockResolvedValueOnce(new Response('upstream-sensitive-body',{status:429,headers:{'X-RateLimit-Limit':'20','X-RateLimit-Remaining':'0','X-RateLimit-Reset':'not-numeric-secret','Retry-After':'30'}}))
   .mockResolvedValueOnce(Response.json({data:{label:'profile-sensitive-label',free_model_daily_requests:{used:12,limit:1000,remaining:988}}}));
  vi.stubGlobal('fetch',fetcher);
  const error=await extractMeal(env,image,expected).catch(e=>e);
  expect(error.safeRetry).toBe(true);expect(error.retryAfter).toBe(30);
  expect(error.message).toContain('429 (inference; limit=20, remaining=0)');
  expect(error.message).toContain('account daily used=12, limit=1000, remaining=988 (UTC)');
  expect(error.message).not.toContain('sensitive');expect(error.message).not.toContain('secret');
  expect(fetcher.mock.calls[2][0]).toBe('https://openrouter.ai/api/v1/key');
 });
 it('retries complete malformed JSON but not interrupted response transport or ambiguous server errors',async()=>{
  for(const response of [new Response('complete invalid JSON'),new Response('rejected',{status:422})]){
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json({data:[metadata()]})).mockResolvedValueOnce(response);vi.stubGlobal('fetch',fetcher);
   expect((await extractMeal(env,image,expected).catch(e=>e)).safeRetry).toBe(true);
  }
  for(const response of [new Response('ambiguous',{status:503}),new Response('timeout',{status:408}),new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"partial":'));controller.error(new Error('sensitive interrupted body'));}}))]){
   const fetcher=vi.fn().mockResolvedValueOnce(Response.json({data:[metadata()]})).mockResolvedValueOnce(response);vi.stubGlobal('fetch',fetcher);
   const error=await extractMeal(env,image,expected).catch(e=>e);
   expect(error.safeRetry).toBe(false);expect(error.message).not.toContain('sensitive');
  }
 });
 it('classifies pre-inference metadata transport failure as safely retryable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('network')));
  const error=await extractMeal(env,image,expected).catch(e=>e);expect(error).toBeInstanceOf(MealExtractionError);expect(error.safeRetry).toBe(true);expect(error.actualCost).toBeNull();
 });
 it('never exposes malformed metadata bodies or transport details in retry diagnostics',async()=>{
  for(const response of [new Response('upstream-sensitive-body'),new Error('transport-sensitive-detail')]){
   const fetcher=vi.fn();if(response instanceof Error)fetcher.mockRejectedValue(response);else fetcher.mockResolvedValue(response);
   vi.stubGlobal('fetch',fetcher);
   const error=await extractMeal(env,image,expected).catch(e=>e);
   expect(error.safeRetry).toBe(true);expect(error.message).not.toContain('sensitive');expect(fetcher).toHaveBeenCalledTimes(1);
  }
 });
 it('rejects free model without image or JSON output support',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{...metadata(),architecture:{input_modalities:['text']},supported_parameters:[]}]}))));await expect(extractMeal(env,image,expected)).rejects.toThrow('lacks required');});
});
