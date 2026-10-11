import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {consume,mealCommandResponse} from '../src/jobs';
import {enqueue} from '../src/storage';
import {fetchImage} from '../src/sources';
vi.mock('../src/sources',async original=>({...await original<object>(),fetchImage:vi.fn()}));
let db:ReturnType<typeof testDatabase>;
const source='https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660';
const image='https://scc.sogang.ac.kr/dataview/board/1185/20261008_0923_5910001.jpg';
const picture={bytes:new Uint8Array([137,80,78,71,13,10,26,10]),mime:'image/png',hash:'fixture'};
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));db=testDatabase();
 db.sqlite.prepare('INSERT INTO meal_sources VALUES(?,?,?,?,?,?)').run(source,image,'2026-10-08','2026-10-12','2026-10-18',new Date().toISOString());
 vi.mocked(fetchImage).mockReset().mockResolvedValue(picture);
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.useRealTimers();});
async function command(date='2026-10-14',expires=Date.now()+900000){
 await enqueue(db.env,'file-reply','interaction',{interaction:{id:'file-reply',application_id:'777',token:'fixture-secret',guild_id:'111',type:2,member:{permissions:'0'},data:{name:'meal',options:[{name:'date',value:date}]}},expires});
}
const run=()=>consume(db.env,{messages:[{body:{id:'file-reply'},ack:vi.fn()}]} as any);
const job=()=>db.sqlite.prepare("SELECT state,payload,attempts FROM jobs WHERE id='file-reply'").get()!;
describe('official meal file replies',()=>{
 it('explains download failure instead of claiming an image was attached',async()=>{
  vi.mocked(fetchImage).mockRejectedValueOnce(new Error('private upstream detail'));
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));await command();await run();
  const body=JSON.parse(send.mock.calls[0][1]!.body as string);
  expect(body.content).toContain('이미지 파일을 불러오지 못했습니다');expect(body.content).toContain(source);expect(body.content).not.toContain('private upstream detail');
  expect(body).not.toHaveProperty('attachments');expect(body).not.toHaveProperty('embeds');expect(job().state).toBe('done');
 });
 it('replaces the attachment set on a retried original-message PATCH',async()=>{
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:503})).mockResolvedValueOnce(new Response('{}'));
  await command();await run();expect(job().state).toBe('retry');expect(job().payload).toContain('fixture-secret');
  vi.advanceTimersByTime(30000);await run();expect(job().state).toBe('done');expect(job().payload).toBe('{}');expect(send).toHaveBeenCalledTimes(2);
  for(const [,request] of send.mock.calls){
   expect(request!.method).toBe('PATCH');expect(request!.headers).toBeUndefined();
   const form=request!.body as FormData,body=JSON.parse(form.get('payload_json') as string);
   expect(body.attachments).toEqual([{id:0,filename:'bellarmino-2026-10-12-2026-10-18.png'}]);expect(body.allowed_mentions.parse).toEqual([]);
   expect(await (form.get('files[0]') as File).arrayBuffer()).toEqual(picture.bytes.buffer);
  }
 });
 it('does not upload an image whose week expires during download',async()=>{
  vi.setSystemTime(new Date('2026-10-18T14:59:30Z'));
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.advanceTimersByTime(120000);return picture;});
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));await command('2026-10-18');await run();
  const body=JSON.parse(send.mock.calls[0][1]!.body as string);expect(body.content).toContain('식단 확인 불가 (2026-10-18)');expect(body).not.toHaveProperty('attachments');
 });
 it('does not send to an interaction which expires during download',async()=>{
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.advanceTimersByTime(20000);return picture;});
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));await command('2026-10-14',Date.now()+10000);await run();
  expect(send).not.toHaveBeenCalled();expect(job().state).toBe('needs_review');expect(job().attempts).toBe(1);
 });
 it.each(['2026-02-30','2026-10-11','2026-10-26'])('does not download an invalid/out-of-window image for %s',async date=>{
  expect(typeof await mealCommandResponse(db.env,date)).toBe('string');expect(fetchImage).not.toHaveBeenCalled();
 });
});
