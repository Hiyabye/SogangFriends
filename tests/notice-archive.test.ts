import {describe,it,expect,vi,afterEach} from 'vitest';
import {handleRequest} from '../src/worker';
import {saveNotices} from '../src/storage';
import {SOURCES,SourceHttpError} from '../src/sources';
import {createArchiveClient,captureRawNotices} from '../scripts/notice-archive-client.mjs';
import {runBackfill} from '../scripts/backfill-notices.mjs';
import {testDatabase} from './helpers/db';
const secret='fixture-archive-secret-'.repeat(3);
const notice=(source='university',id='1')=>({source,id,title:'공식 본문 공지',published:'2026-10-09',url:source==='university'?`https://www.sogang.ac.kr/ko/detail/${id}?bbsConfigFk=2`:`https://computing.sogang.ac.kr/ko/community/${source}/detail/${id}`});
const raw=(source='university',id='1')=>({notice:notice(source,id),bodyHtml:'<p>원문 &amp; <script>untrusted()</script></p>',attachments:['https://www.sogang.ac.kr/file.pdf'],imageUrls:['https://www.sogang.ac.kr/image.png']});
async function signed(value:unknown,key=secret,timestamp=String(Date.now())) {
 const body=typeof value==='string'?value:JSON.stringify(value),encoder=new TextEncoder();
 const k=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,encoder.encode(`${timestamp}.${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
 return new Request('https://worker.test/internal/notice-archive',{method:'POST',body,headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':signature}});
}
function database(){
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-09T17:00:00Z'));
 const db=testDatabase(),objects=new Map<string,string>();
 const bucket={
  put:vi.fn(async(key:string,value:string,options:{onlyIf:Headers})=>{expect(options.onlyIf.get('If-None-Match')).toBe('*');if(objects.has(key))return null;objects.set(key,value);return {key};}),
  get:vi.fn(async(key:string)=>objects.has(key)?{json:async()=>JSON.parse(objects.get(key)!)}:null)
 };
 db.env.NOTICE_ARCHIVE_ENABLED='true';db.env.NOTICE_ARCHIVE=bucket as unknown as R2Bucket;db.env.NOTICE_INGEST_SECRET=secret;
 const send=async(data:unknown)=>handleRequest(await signed(data),db.env);
 return {...db,objects,bucket,send};
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('private raw notice archive',()=>{
 it('is disabled by default and uses shared HMAC before any storage',async()=>{
  const db=database();try{
   delete db.env.NOTICE_ARCHIVE_ENABLED;expect((await db.send({action:'status'})).status).toBe(503);
   db.env.NOTICE_ARCHIVE_ENABLED='true';
   expect((await handleRequest(await signed({action:'status'},'wrong'),db.env)).status).toBe(401);
   expect((await handleRequest(await signed({action:'status'},secret,String(Date.now()-301000)),db.env)).status).toBe(401);
   const req=await signed({action:'status'});expect((await handleRequest(new Request(req.url,{method:'POST',headers:req.headers,body:'{"action":"start"}'}),db.env)).status).toBe(401);
   expect((await handleRequest(new Request(req.url),db.env)).status).toBe(404);
   expect(db.bucket.put).not.toHaveBeenCalled();expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notice_archive_progress').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('starts six cursors once without resetting completed progress',async()=>{
  const db=database();try{
   expect(await (await db.send({action:'status'})).json()).toEqual({sources:[]});
   expect(await (await db.send({action:'start'})).json()).toEqual({started:true});
   const status=await (await db.send({action:'status'})).json() as any;
   expect(status.sources).toHaveLength(6);expect(status.sources.every((s:any)=>s.page===1&&s.state==='active'&&s.started_at==='2026-10-09T17:00:00.000Z'&&s.updated_at===s.started_at)).toBe(true);
   db.sqlite.prepare("UPDATE notice_archive_progress SET page=7,state='done' WHERE source='news'").run();
   vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));await db.send({action:'start'});
   expect(db.sqlite.prepare("SELECT page,state,started_at,updated_at FROM notice_archive_progress WHERE source='news'").get()).toMatchObject({page:7,state:'done',started_at:'2026-10-09T17:00:00.000Z',updated_at:'2026-10-09T17:00:00.000Z'});
  }finally{db.close();}
 });
 it('stores exact inert original HTML in R2, only its index in D1, and preserves first capture',async()=>{
  const db=database();try{
   const input=raw();const r=await db.send({action:'record',raw:input});expect(r.status).toBe(200);expect(await r.json()).toEqual({recorded:true,key:'raw/university/1.json'});
   const stored=JSON.parse(db.objects.get('raw/university/1.json')!);expect(stored).toMatchObject({...input,version:1});expect(stored.contentHash).toMatch(/^[a-f0-9]{64}$/);expect(Number.isFinite(Date.parse(stored.capturedAt))).toBe(true);
   const row=db.sqlite.prepare('SELECT * FROM notice_archive').get()!;expect(row.raw_key).toBe('raw/university/1.json');expect(Object.keys(row)).not.toContain('bodyHtml');expect(row.content_hash).toBe(stored.contentHash);
   expect(await (await db.send({action:'record',raw:{...input,bodyHtml:'changed'}})).json()).toEqual({recorded:false,key:'raw/university/1.json'});
   expect(db.bucket.put).toHaveBeenCalledTimes(1);expect(JSON.parse(db.objects.get('raw/university/1.json')!).bodyHtml).toBe(input.bodyHtml);
   expect(await (await db.send({action:'missing',source:'university',ids:['1','2']})).json()).toEqual({missing:['2']});
  }finally{db.close();}
 });
 it('raw recording does not swallow normal new-ID alerts',async()=>{
  const db=database();try{
   await saveNotices(db.env,'university',[notice('university','2')],new Date().toISOString());
   await db.send({action:'record',raw:raw()});expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notices WHERE id='1'").get()!.n).toBe(0);
   await saveNotices(db.env,'university',[notice()],new Date(Date.now()+1000).toISOString());
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(1);
  }finally{db.close();}
 });
 it('commits historical metadata atomically with progress, without alerts or baseline/health updates',async()=>{
  const db=database();try{
   for(const s of SOURCES)db.sqlite.prepare('INSERT INTO sources(id,initialized,last_success,last_attempt) VALUES(?,1,?,?)').run(s.id,'live-success','live-attempt');
   await db.send({action:'start'});
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1'],done:false})).status).toBe(409);
   expect(db.sqlite.prepare("SELECT page FROM notice_archive_progress WHERE source='university'").get()!.page).toBe(1);
   await db.send({action:'record',raw:raw()});
   expect(await (await db.send({action:'commit',source:'university',page:1,ids:['1'],done:false})).json()).toEqual({committed:true,replayed:false,page:2,state:'active'});
   expect(await (await db.send({action:'commit',source:'university',page:1,ids:['1'],done:false})).json()).toEqual({committed:true,replayed:true,page:2,state:'active'});
   expect((await db.send({action:'commit',source:'university',page:4,ids:['1'],done:false})).status).toBe(409);
   expect(await (await db.send({action:'commit',source:'university',page:2,ids:['1'],done:true})).json()).toEqual({committed:true,replayed:false,page:3,state:'done'});
   expect((await db.send({action:'commit',source:'university',page:3,ids:['1'],done:true})).status).toBe(409);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(1);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM deliveries').get()!.n).toBe(0);
   const sources=db.sqlite.prepare('SELECT * FROM sources').all();expect(sources).toHaveLength(6);for(const s of sources)expect(s).toMatchObject({initialized:1,last_success:'live-success',last_attempt:'live-attempt'});
  }finally{db.close();}
 });
 it('commits a full fifty-row page with five queries and at most fifty-four bound parameters',async()=>{
  const db=database();try{
   await db.send({action:'start'});const ids=Array.from({length:50},(_,i)=>String(i+1));
   for(const id of ids)expect((await db.send({action:'record',raw:raw('university',id)})).status).toBe(200);
   const prepared=vi.spyOn(db.env.DB,'prepare'),batch=vi.spyOn(db.env.DB,'batch');
   expect((await db.send({action:'commit',source:'university',page:1,ids,done:false})).status).toBe(200);
   expect(prepared).toHaveBeenCalledTimes(5);expect(batch).toHaveBeenCalledTimes(1);
   const writes=batch.mock.calls[0][0] as any[];expect(writes).toHaveLength(2);
   expect(writes[0].sql).toMatch(/^INSERT OR IGNORE INTO notices.*SELECT/);expect(writes[0].values).toHaveLength(54);
   expect(writes.every(s=>s.values.length<=100)).toBe(true);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(50);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('checkpoints definitive unavailable details without raw objects, metadata or alerts',async()=>{
  const db=database();try{
   await db.send({action:'start'});await db.send({action:'record',raw:raw()});
   for(const status of [404,410])expect((await db.send({action:'unavailable',notice:notice('university','2'),status})).status).toBe(200);
   expect(db.sqlite.prepare('SELECT status FROM notice_archive_unavailable').get()!.status).toBe(404);
   expect(await (await db.send({action:'missing',source:'university',ids:['1','2','3']})).json()).toEqual({missing:['2','3']});
   expect(await (await db.send({action:'missing',source:'university',ids:['1','2','3'],includeUnavailable:true})).json()).toEqual({missing:['3']});
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1','2'],done:true})).status).toBe(200);
   expect(db.objects.size).toBe(1);expect(db.bucket.put).toHaveBeenCalledTimes(1);
   expect(db.sqlite.prepare('SELECT id FROM notices').all()).toEqual([{id:'1'}]);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
   // A restored recent detail is still requested and can acquire a real raw object.
   expect((await db.send({action:'record',raw:raw('university','2')})).status).toBe(200);
   expect(await (await db.send({action:'missing',source:'university',ids:['2']})).json()).toEqual({missing:[]});
  }finally{db.close();}
 });
 it('rejects unsafe unavailable evidence and keeps fifty-ID marker probes bounded',async()=>{
  const db=database();try{
   for(const status of [200,403,429,503,'404'])expect((await db.send({action:'unavailable',notice:notice(),status})).status).toBe(400);
   expect((await db.send({action:'unavailable',notice:{...notice(),url:'https://evil.test/1'},status:404})).status).toBe(400);
   expect((await db.send({action:'missing',source:'university',ids:['1'],includeUnavailable:'true'})).status).toBe(400);
   const ids=Array.from({length:50},(_,i)=>String(i+1));
   for(const id of ids)await db.send({action:'unavailable',notice:notice('university',id),status:410});
   const prepared=vi.spyOn(db.env.DB,'prepare');
   expect(await (await db.send({action:'missing',source:'university',ids,includeUnavailable:true})).json()).toEqual({missing:[]});
   expect(prepared).toHaveBeenCalledTimes(1);const statement=prepared.mock.results[0].value as any;
   expect(statement.sql).toMatch(/^WITH requested/);expect((statement.sql.match(/\?/g)??[]).length).toBe(52);
   expect(db.objects.size).toBe(0);expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('integrates one available and one deleted detail, skips the durable marker on retry, and leaves 503 pages retryable',async()=>{
  const db=database();try{
   await db.send({action:'start'});db.sqlite.prepare("DELETE FROM notice_archive_progress WHERE source!='university'").run();
   const client=createArchiveClient({endpoint:'https://worker.test/internal/notices',secret,fetcher:async(url:string,options:any)=>handleRequest(new Request(url,options),db.env),sleep:async()=>{}});
   const page={notices:[notice(),notice('university','2')],done:false};
   const collectRaw=vi.fn(async(n:any)=>{if(n.id==='2')throw new SourceHttpError(404);return raw();});
   expect(await runBackfill({send:true,pages:1,client,sources:[SOURCES[0]],collectPage:async()=>page,collectRaw,sleep:async()=>{},log:vi.fn()})).toBe(0);
   expect(db.sqlite.prepare("SELECT page FROM notice_archive_progress WHERE source='university'").get()!.page).toBe(2);
   expect(db.objects.size).toBe(1);expect(db.sqlite.prepare('SELECT id FROM notices').all()).toEqual([{id:'1'}]);
   collectRaw.mockClear();
   expect(await captureRawNotices(SOURCES[0],page.notices,{client,collectRaw,allowUnavailable:true,sleep:async()=>{}})).toEqual({complete:true,captured:0,unavailable:0});
   expect(collectRaw).not.toHaveBeenCalled();
   expect(await runBackfill({send:true,pages:1,client,sources:[SOURCES[0]],collectPage:async()=>({notices:[notice('university','3')],done:false}),collectRaw:async()=>{throw new SourceHttpError(503);},sleep:async()=>{},log:vi.fn()})).toBe(1);
   expect(db.sqlite.prepare("SELECT page FROM notice_archive_progress WHERE source='university'").get()!.page).toBe(2);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notice_archive_unavailable').get()!.n).toBe(1);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('keeps same-day and later publications unseen for live polling after archival commit',async()=>{
  const db=database();try{
   await saveNotices(db.env,'university',[notice('university','99')],new Date().toISOString());
   await db.send({action:'start'});
   const inputs=[raw(),{...raw('university','2'),notice:{...notice('university','2'),published:'2026-10-10'}},{...raw('university','3'),notice:{...notice('university','3'),published:'2026-10-11'}}];
   for(const input of inputs)expect((await db.send({action:'record',raw:input})).status).toBe(200);
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1','2','3'],done:true})).status).toBe(200);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notice_archive').get()!.n).toBe(3);expect(db.objects.size).toBe(3);
   expect(db.sqlite.prepare("SELECT id FROM notices WHERE id!='99' ORDER BY id").all()).toEqual([{id:'1'}]);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(0);
   await saveNotices(db.env,'university',inputs.map(input=>input.notice),new Date().toISOString());
   const alerts=db.sqlite.prepare("SELECT payload FROM jobs WHERE kind='notice-alert'").all();expect(alerts).toHaveLength(1);
   expect(JSON.parse(String(alerts[0].payload)).notices.map((n:any)=>n.id)).toEqual(['2','3']);
  }finally{db.close();}
 });
 it('keeps the original KST cutoff across repeated start and retry days',async()=>{
  const db=database();try{
   await db.send({action:'start'});
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1','2'],done:false})).status).toBe(409);
   vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));await db.send({action:'start'});
   await db.send({action:'record',raw:raw()});await db.send({action:'record',raw:{...raw('university','2'),notice:{...notice('university','2'),published:'2026-10-10'}}});
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1','2'],done:false})).status).toBe(200);
   expect(db.sqlite.prepare('SELECT id FROM notices ORDER BY id').all()).toEqual([{id:'1'}]);
   const status=await (await db.send({action:'status'})).json() as any;
   expect(status.sources.find((s:any)=>s.source==='university')).toMatchObject({page:2,state:'active',started_at:'2026-10-09T17:00:00.000Z',updated_at:'2026-10-12T00:00:00.000Z'});
  }finally{db.close();}
 });
 it('does not overwrite live title metadata during historical commit',async()=>{
  const db=database();try{
   await db.send({action:'start'});await db.send({action:'record',raw:raw()});
   await saveNotices(db.env,'university',[{...notice(),title:'newer title'}],new Date().toISOString());
   await db.send({action:'commit',source:'university',page:1,ids:['1'],done:true});
   expect(db.sqlite.prepare('SELECT title FROM notices').get()!.title).toBe('newer title');
  }finally{db.close();}
 });
 it('rejects unsafe references, wrong IDs/URLs, malformed JSON and bounded oversized bodies',async()=>{
  const db=database();try{
   for(const bad of [{...raw(),attachments:['javascript:alert(1)']},{...raw(),imageUrls:['https://user:pass@example.test/a']},{...raw(),notice:{...notice(),url:'https://evil.test/1'}},{...raw(),bodyHtml:'x'.repeat(1024*1024+1)},{...raw(),attachments:Array(101).fill('https://example.test/a')}])expect((await db.send({action:'record',raw:bad})).status).toBe(400);
   for(const bad of [{action:'missing',source:'university',ids:['1','1']},{action:'missing',source:'unknown',ids:['1']},{action:'missing',source:'news',ids:Array.from({length:51},(_,i)=>String(i+1))},{action:'commit',source:'news',page:1,ids:[],done:false},{action:'commit',source:'news',page:0,ids:['1'],done:true}])expect((await db.send(bad)).status).toBe(400);
   expect((await db.send('not JSON')).status).toBe(400);
   expect((await db.send('x'.repeat(2*1024*1024+1))).status).toBe(413);
   expect(db.objects.size).toBe(0);
  }finally{db.close();}
 });
 it('keeps the cursor/index untouched after R2 failure',async()=>{
  const db=database();try{
   await db.send({action:'start'});db.bucket.put.mockRejectedValueOnce(new Error('storage unavailable'));
   expect((await db.send({action:'record',raw:raw()})).status).toBe(503);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notice_archive').get()!.n).toBe(0);
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1'],done:true})).status).toBe(409);
   expect(db.sqlite.prepare("SELECT page FROM notice_archive_progress WHERE source='university'").get()!.page).toBe(1);
  }finally{db.close();}
 });
 it('reconciles an orphaned first R2 capture after a D1 write failure, including concurrent replay',async()=>{
  const db=database();try{
   const original=db.env.DB.prepare.bind(db.env.DB);let fail=true;
   vi.spyOn(db.env.DB,'prepare').mockImplementation(sql=>{if(fail&&sql.startsWith('INSERT OR IGNORE INTO notice_archive(')){fail=false;return {bind:()=>({run:async()=>{throw new Error('D1 unavailable');}})} as any;}return original(sql);});
   expect((await db.send({action:'record',raw:raw()})).status).toBe(503);expect(db.objects.size).toBe(1);
   expect((await db.send({action:'record',raw:{...raw(),bodyHtml:'different after retry'}})).status).toBe(200);
   expect(JSON.parse(db.objects.get('raw/university/1.json')!).bodyHtml).toBe(raw().bodyHtml);
   expect(db.sqlite.prepare('SELECT content_hash FROM notice_archive').get()!.content_hash).toBe(JSON.parse(db.objects.get('raw/university/1.json')!).contentHash);
   const results=await Promise.all([db.send({action:'record',raw:raw('news','2')}),db.send({action:'record',raw:{...raw('news','2'),bodyHtml:'second'}})]);
   expect(results.map(r=>r.status)).toEqual([200,200]);
   // Either concurrent request may win the first conditional put after asynchronous hashing.
   const first=db.objects.get('raw/news/2.json')!;const stored=JSON.parse(first);
   expect([raw('news','2').bodyHtml,'second']).toContain(stored.bodyHtml);
   expect(db.sqlite.prepare("SELECT content_hash FROM notice_archive WHERE source='news' AND id='2'").get()!.content_hash).toBe(stored.contentHash);
   await db.send({action:'record',raw:{...raw('news','2'),bodyHtml:'later replay'}});expect(db.objects.get('raw/news/2.json')).toBe(first);
  }finally{db.close();}
 });
 it('rolls back historical inserts if checkpoint update fails and supports a verified empty terminal page',async()=>{
  const db=database();try{
   await db.send({action:'start'});await db.send({action:'record',raw:raw()});
   db.sqlite.exec("CREATE TRIGGER reject_progress BEFORE UPDATE ON notice_archive_progress BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
   expect((await db.send({action:'commit',source:'university',page:1,ids:['1'],done:false})).status).toBe(503);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notices').get()!.n).toBe(0);
   expect(db.sqlite.prepare("SELECT page FROM notice_archive_progress WHERE source='university'").get()!.page).toBe(1);
   db.sqlite.exec('DROP TRIGGER reject_progress');
   expect(await (await db.send({action:'commit',source:'news',page:1,ids:[],done:true})).json()).toEqual({committed:true,replayed:false,page:2,state:'done'});
  }finally{db.close();}
 });
});
