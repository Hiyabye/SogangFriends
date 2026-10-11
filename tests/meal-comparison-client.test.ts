import {describe,it,expect,vi} from 'vitest';
import {createHash,createHmac} from 'node:crypto';
import {compareMeal,comparisonRequest} from '../scripts/compare-meal.mjs';
import {MealExtractionError} from '../src/meals';
const image={bytes:new Uint8Array([255,216,255]),mime:'image/jpeg'};
const config={id:'actions-meal-compare:'+'a'.repeat(32),runId:'123',model:'dots-studio/dots-3-note-preview:free',maxAttempts:2,imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/20260930_1516_3210001.jpg',sourceUrl:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941444',imageHash:createHash('sha256').update(image.bytes).digest('hex'),expected:{start:'2026-10-05',end:'2026-10-11',published:'2026-09-30'}};
describe('controlled Actions meal comparison',()=>{
 it('uses the exact image and shared extraction settings without cache writes',async()=>{
  const extract=vi.fn().mockResolvedValue({week:{fixture:true},actualCost:0});
  const result=await compareMeal(config,'fixture',{extract,loadImage:vi.fn().mockResolvedValue(image)});
  expect(extract).toHaveBeenCalledWith({LLM_ENABLED:'true',OPENROUTER_API_KEY:'fixture',MEAL_MODEL:config.model},image,config.expected,{disableReasoning:true});
  expect(result).toMatchObject({state:'completed',attempts:1,actualCost:0,week:{fixture:true}});expect(JSON.stringify(result)).not.toContain('OPENROUTER_API_KEY');
 });
 it('refuses changed images before inference',async()=>{
  const extract=vi.fn();const result=await compareMeal({...config,imageHash:'0'.repeat(64)},'fixture',{extract,loadImage:vi.fn().mockResolvedValue(image)});
  expect(extract).not.toHaveBeenCalled();expect(result.state).toBe('safe_retry');expect(result.attempts).toBe(1);
 });
 it('permits only two safe attempts and honors a longer Retry-After',async()=>{
  const sleep=vi.fn();const extract=vi.fn().mockRejectedValue(new MealExtractionError('Model service HTTP 429',null,true,90));
  const result=await compareMeal(config,'fixture',{extract,sleep,loadImage:vi.fn().mockResolvedValue(image)});
  expect(extract).toHaveBeenCalledTimes(2);expect(sleep).toHaveBeenCalledWith(90000);expect(result.state).toBe('safe_retry');expect(result.actualCost).toBeNull();
 });
 it('stops on uncertainty and preserves prior observed cost without assuming unknown cost zero',async()=>{
  const extract=vi.fn().mockRejectedValueOnce(new MealExtractionError('Invalid answer JSON',0,true)).mockRejectedValueOnce(new MealExtractionError('Model service transport failed'));
  const result=await compareMeal(config,'fixture',{extract,sleep:vi.fn(),loadImage:vi.fn().mockResolvedValue(image)});
  expect(result).toMatchObject({state:'reserved',attempts:2,actualCost:0});expect(extract).toHaveBeenCalledTimes(2);
  const uncertain=vi.fn().mockRejectedValue(new Error('private-upstream-body'));
  const stopped=await compareMeal(config,'fixture',{extract:uncertain,loadImage:vi.fn().mockResolvedValue(image)});
  expect(uncertain).toHaveBeenCalledTimes(1);expect(JSON.stringify(stopped)).not.toContain('private');expect(stopped.actualCost).toBeNull();
 });
 it('rejects other models or increased attempt limits without fetching',async()=>{
  const loadImage=vi.fn();for(const changed of [{model:'paid/model'},{maxAttempts:3}])await expect(compareMeal({...config,...changed},'fixture',{loadImage})).rejects.toThrow('Invalid diagnostic');
  expect(loadImage).not.toHaveBeenCalled();
 });
 it('signs exact request bytes and never retries an unacknowledged claim',async()=>{
  const fetcher=vi.fn().mockResolvedValue(Response.json({accepted:true}));const secret='s'.repeat(32);
  await comparisonRequest('https://worker.example/internal/meal-compare',secret,{action:'claim',id:config.id,runId:config.runId},{fetcher});
  const request=fetcher.mock.calls[0][1];expect(request.redirect).toBe('manual');expect(request.headers['x-collector-signature']).toBe(createHmac('sha256',secret).update(`${request.headers['x-collector-timestamp']}.${request.body}`).digest('hex'));
  const failed=vi.fn().mockRejectedValue(new Error('network'));
  await expect(comparisonRequest('https://worker.example/internal/meal-compare',secret,{action:'claim'},{fetcher:failed})).rejects.toThrow();expect(failed).toHaveBeenCalledTimes(1);
 });
});
