import {afterEach, describe, expect, it, vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {handleRequest, completeInteraction} from '../src/worker';
import {consume} from '../src/jobs';
import {enqueue, recover, saveNotices} from '../src/storage';
import {MealExtractionError} from '../src/meals';
vi.mock('../src/meals',async importOriginal=>({...await importOriginal<object>(),extractMeal:vi.fn()}));
vi.mock('../src/sources',async importOriginal=>({...await importOriginal<object>(),fetchImage:vi.fn(async()=>({bytes:new Uint8Array([1]),mime:'image/png',hash:'hash'}))}));
afterEach(()=>vi.restoreAllMocks());
async function signed(env:any,body:any) {
 const key=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
 const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
 env.DISCORD_PUBLIC_KEY=hex(await crypto.subtle.exportKey('raw',key.publicKey)); env.DISCORD_APPLICATION_ID='777';
 const text=JSON.stringify(body);const ts=String(Math.floor(Date.now()/1000));
 const signature=hex(await crypto.subtle.sign('Ed25519',key.privateKey,new TextEncoder().encode(ts+text)));
 return new Request('https://bot.test/interactions',{method:'POST',body:text,headers:{'x-signature-ed25519':signature,'x-signature-timestamp':ts}});
}
const interaction=(name:string,guild='111',permissions='32')=>({id:'123',application_id:'777',token:'secret-webhook',type:2,guild_id:guild,member:{permissions,user:{id:'private-user'}},data:{name}});
describe('interaction and durable integration',()=>{
 it('rejects bad signatures; responds to signed PING without bot/model keys',async()=>{
 const db=testDatabase();try{
 expect((await handleRequest(new Request('https://bot.test/interactions',{method:'POST',body:'{}'}),db.env)).status).toBe(401);
 expect(await (await handleRequest(await signed(db.env,{type:1}),db.env)).json()).toEqual({type:1});
 }finally{db.close();}});
 it('admin denial and allowlist denial are ephemeral and never enqueue',async()=>{
 const db=testDatabase();try{
 for(const data of [interaction('setup','111','0'),interaction('status','333')]){
 const response=await handleRequest(await signed(db.env,data),db.env);expect((await response.json() as any).data.flags).toBe(64);
 }expect(db.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()!.n).toBe(0);
 }finally{db.close();}});
 it('defers admin work privately, minimizes token data, schedules acknowledgement propagation delay',async()=>{
 const db=testDatabase();try{
 const response=await handleRequest(await signed(db.env,interaction('status')),db.env);
 expect(await response.json()).toEqual({type:5,data:{flags:64}});
 expect(db.env.JOBS.send).toHaveBeenCalledWith({id:'interaction:123'},{delaySeconds:2});
 const payload=String(db.sqlite.prepare('SELECT payload FROM jobs').get()!.payload);
 expect(payload).toContain('secret-webhook');expect(payload).not.toContain('private-user');
 }finally{db.close();}});
 it('status is guild scoped and webhook edit disables mentions',async()=>{
 const db=testDatabase();try{
 db.sqlite.exec("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','1111','now'),('222','2222','now')");
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{id:'x',kind:'interaction',payload:JSON.stringify({interaction:interaction('status'),expires:Date.now()+5000})} as any);
 const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(body.content).toContain('1111');expect(body.content).not.toContain('2222');expect(body.allowed_mentions.parse).toEqual([]);
 }finally{db.close();}});
 it('idempotent webhook PATCH retries a transient acknowledgement race and clears tokens only after completion',async()=>{
 const db=testDatabase();try{
 await enqueue(db.env,'interaction:retry','interaction',{interaction:interaction('meal'),expires:Date.now()+50000});
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:404})).mockResolvedValueOnce(new Response('{}'));
 const batch={messages:[{body:{id:'interaction:retry'},ack:vi.fn()}],queue:'test'} as any;
 await consume(db.env,batch);
 let row=db.sqlite.prepare('SELECT state,payload FROM jobs').get()!;
 expect(row.state).toBe('retry');expect(row.payload).toContain('secret-webhook');
 db.sqlite.exec("UPDATE jobs SET available_at='2020-01-01'");
 await consume(db.env,batch);row=db.sqlite.prepare('SELECT state,payload FROM jobs').get()!;
 expect(row.state).toBe('done');expect(row.payload).toBe('{}');expect(fetchMock).toHaveBeenCalledTimes(2);
 }finally{db.close();}});
 it('recovery purges expired and crashed webhook secrets',async()=>{
 const db=testDatabase();try{
 await enqueue(db.env,'old','interaction',{token:'secret'});
 db.sqlite.exec("UPDATE jobs SET state='running',created_at='2020-01-01',lease_until='2020-01-01'");
 await recover(db.env);expect(db.sqlite.prepare('SELECT payload FROM jobs').get()!.payload).toBe('{}');
 }finally{db.close();}});
 it('overlapping source snapshot saves cannot both create new alerts',async()=>{
 const db=testDatabase();try{
 await saveNotices(db.env,'a',[],new Date().toISOString());
 const notice={source:'a',id:'1',title:'new',published:'2026-10-09',url:'https://www.sogang.ac.kr/ko/detail/1'};
 await Promise.allSettled([saveNotices(db.env,'a',[notice],'2026-10-09T00:00:00Z'),saveNotices(db.env,'a',[notice],'2026-10-09T00:00:01Z')]);
 expect(db.sqlite.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(1);
 }finally{db.close();}});
 it('records supplied cost even for rejected meal content without retrying ambiguous inference',async()=>{
 const db=testDatabase();try{
 db.env.LLM_ENABLED='true';db.env.OPENROUTER_API_KEY='test';
 const {extractMeal}=await import('../src/meals');vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('rejected',0.04));
 await enqueue(db.env,'meal-job','meal-extract',{imageUrl:'fixture',hash:'hash'});
 const ack=vi.fn();await consume(db.env,{messages:[{body:{id:'meal-job'},ack}],queue:'test'} as any);
 expect(db.sqlite.prepare('SELECT actual_usd FROM llm_usage').get()!.actual_usd).toBe(0.04);
 expect(db.sqlite.prepare('SELECT state FROM jobs').get()!.state).toBe('needs_review');expect(ack).toHaveBeenCalled();
 }finally{db.close();}});
 it('confirmed OpenRouter 429 can retry after delay while retaining one reservation',async()=>{
 const db=testDatabase();try{
 db.env.LLM_ENABLED='true';db.env.OPENROUTER_API_KEY='test';
 const {extractMeal}=await import('../src/meals');vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('429',null,true,120));
 await enqueue(db.env,'rate-job','meal-extract',{imageUrl:'fixture',hash:'hash'});
 await consume(db.env,{messages:[{body:{id:'rate-job'},ack:vi.fn()}],queue:'test'} as any);
 expect(db.sqlite.prepare('SELECT state FROM jobs').get()!.state).toBe('retry');
 expect(db.sqlite.prepare('SELECT state FROM llm_usage').get()!.state).toBe('safe_retry');
 }finally{db.close();}});
});
