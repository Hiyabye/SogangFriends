import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {cleanupLibraryMessage,recordLibraryMessage,saveLibrarySnapshot} from '../src/library';
import {consume,executeJob} from '../src/jobs';
import type {Job} from '../src/types';

let db:ReturnType<typeof testDatabase>;
const guild='111',channel='9001';
const iso=()=>new Date().toISOString();
const completion=(suffix:string)=>`library:${guild}:${suffix}`;
function delivery(id:string,state='sending',destination=channel,owner=guild){
 db.sqlite.prepare('INSERT INTO deliveries(id,guild_id,channel_id,content,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,owner,destination,'fixture',state,iso(),iso(),new Date(Date.now()+120_000).toISOString());
}
const tracking=(destination=channel,owner=guild)=>db.sqlite.prepare('SELECT * FROM library_messages WHERE guild_id=? AND channel_id=?').get(owner,destination);
const cleanupJobs=()=>db.sqlite.prepare("SELECT * FROM jobs WHERE kind='library-cleanup' ORDER BY id").all();
const getDelivery=(id:string)=>db.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id)!;
const getJob=(id:string)=>db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job;
const cleanupPayload=()=>JSON.parse(String(cleanupJobs()[0].payload)) as {guild:string;channel:string;messageId:string;replacementId:string};
async function sent(suffix:string,message:string,destination=channel,owner=guild){
 const id=`library:${owner}:${suffix}`;delivery(id,'sending',destination,owner);await recordLibraryMessage(db.env,owner,destination,message,id);return id;
}
async function replacement(){await sent('first','100');await sent('second','200');return cleanupPayload();}
const batch=(id:string)=>({messages:[{body:{id},ack:vi.fn()}]}) as unknown as MessageBatch<{id:string}>;
async function opening(){
 db.sqlite.prepare('INSERT INTO guilds(id,library_channel,updated_at) VALUES(?,?,?)').run(guild,channel,iso());
 await saveLibrarySnapshot(db.env,{total:96,used:96,remaining:0,sourceAt:iso()});
 vi.advanceTimersByTime(60_000);
 await saveLibrarySnapshot(db.env,{total:96,used:95,remaining:1,sourceAt:iso()});
 return String(db.sqlite.prepare('SELECT event_id FROM library_watches WHERE guild_id=?').get(guild)!.event_id);
}

beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T01:00:00Z'));db=testDatabase();db.env.DISCORD_TOKEN='fixture-token';
 // Every test must explicitly authorize its mock; no fallback can contact the network.
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Unexpected external request')));
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('library confirmed-message transactions',()=>{
 it('records the first successful send without a cleanup job or network action',async()=>{
  const id=await sent('first','100');
  expect(tracking()).toMatchObject({guild_id:guild,channel_id:channel,message_id:'100',updated_at:iso()});
  expect(getDelivery(id)).toMatchObject({state:'sent',message_id:'100',error:null});
  expect(cleanupJobs()).toEqual([]);expect(fetch).not.toHaveBeenCalled();
 });
 it('atomically records the replacement and a deterministic cleanup intent for only its prior message',async()=>{
  await sent('other-channel','400','9002');await sent('other-guild','500',channel,'222');
  delivery('notice:fixture');db.sqlite.prepare("UPDATE deliveries SET state='sent',message_id='600' WHERE id='notice:fixture'").run();
  await sent('first','100');const id=await sent('second','200');
  expect(getDelivery(id)).toMatchObject({state:'sent',message_id:'200'});expect(tracking()!.message_id).toBe('200');
  expect(tracking('9002')!.message_id).toBe('400');expect(tracking(channel,'222')!.message_id).toBe('500');
  expect(cleanupJobs()).toHaveLength(1);
  expect(cleanupJobs()[0]).toMatchObject({id:`library-cleanup:${guild}:${channel}:100`,state:'pending',created_at:iso(),available_at:iso()});
  expect(cleanupPayload()).toEqual({guild,channel,messageId:'100',replacementId:'200'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('never rolls a newer tracked message back on repeated completion of an older send',async()=>{
  const first=await sent('first','100');await sent('second','200');await sent('third','300');
  const before=cleanupJobs();await recordLibraryMessage(db.env,guild,channel,'100',first);
  expect(tracking()!.message_id).toBe('300');expect(cleanupJobs()).toEqual(before);
 });
 it.each(['cleanup','tracking','delivery'])('rolls the whole completion back when the %s write fails',async phase=>{
  await sent('first','100');const id=completion('second');delivery(id);
  const trigger=phase==='cleanup'?"BEFORE INSERT ON jobs WHEN NEW.kind='library-cleanup'":phase==='tracking'?'BEFORE UPDATE ON library_messages':"BEFORE UPDATE ON deliveries WHEN NEW.state='sent'";
  db.sqlite.exec(`CREATE TRIGGER fail_completion ${trigger} BEGIN SELECT RAISE(ABORT,'injected completion failure'); END`);
  await expect(recordLibraryMessage(db.env,guild,channel,'200',id)).rejects.toThrow('injected completion failure');
  expect(getDelivery(id)).toMatchObject({state:'sending',message_id:null});expect(tracking()!.message_id).toBe('100');expect(cleanupJobs()).toEqual([]);
 });
 it.each(['uncertain','failed','pending'])('does not adopt a %s delivery without confirmed completion',async state=>{
  await sent('first','100');const id=completion('invalid');delivery(id,state);
  await expect(recordLibraryMessage(db.env,guild,channel,'200',id)).rejects.toThrow('no sending delivery');
  expect(tracking()!.message_id).toBe('100');expect(cleanupJobs()).toEqual([]);expect(getDelivery(id).state).toBe(state);
 });
 it('rejects a nonlibrary completion and a delivery/channel mismatch without mutations',async()=>{
  delivery('notice:fixture');await expect(recordLibraryMessage(db.env,guild,channel,'100','notice:fixture')).rejects.toThrow('identity');
  const id=completion('mismatch');delivery(id,'sending','9002');await expect(recordLibraryMessage(db.env,guild,channel,'100',id)).rejects.toThrow('no sending delivery');
  expect(tracking()).toBeUndefined();expect(cleanupJobs()).toEqual([]);
 });
});

describe('library cleanup authorization and HTTP semantics',()=>{
 it('deletes only the prior ID after persisted replacement proof',async()=>{
  const payload=await replacement();const api=vi.mocked(fetch).mockResolvedValue(new Response(null,{status:204}));
  await cleanupLibraryMessage(db.env,payload);
  expect(api).toHaveBeenCalledExactlyOnceWith(`https://discord.com/api/v10/channels/${channel}/messages/100`,expect.objectContaining({method:'DELETE',headers:{Authorization:'Bot fixture-token'},signal:expect.any(AbortSignal)}));
  expect(tracking()!.message_id).toBe('200');expect(getDelivery(completion('first'))).toMatchObject({state:'sent',message_id:'100'});
 });
 it('allows delayed cleanup of A after A→B→C without deleting B or C',async()=>{
  const payload=await replacement();await sent('third','300');vi.mocked(fetch).mockResolvedValue(new Response(null,{status:204}));
  await cleanupLibraryMessage(db.env,payload);expect(fetch).toHaveBeenCalledOnce();expect(tracking()!.message_id).toBe('300');
 });
 it.each(['no-tracking','current-target','unconfirmed','other-channel','nonlibrary'] as const)('refuses deletion with %s replacement evidence',async reason=>{
  const payload=await replacement();
  if(reason==='no-tracking')db.sqlite.prepare('DELETE FROM library_messages').run();
  if(reason==='current-target')db.sqlite.prepare("UPDATE library_messages SET message_id='100'").run();
  if(reason==='unconfirmed')db.sqlite.prepare("UPDATE deliveries SET state='uncertain' WHERE message_id='200'").run();
  if(reason==='other-channel')db.sqlite.prepare("UPDATE deliveries SET channel_id='9002' WHERE message_id='200'").run();
  if(reason==='nonlibrary')db.sqlite.prepare("UPDATE deliveries SET id='notice:replacement' WHERE message_id='200'").run();
  await expect(cleanupLibraryMessage(db.env,payload)).rejects.toThrow(/replacement/);expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects malformed IDs and identical old/replacement IDs',async()=>{
  const payload=await replacement();
  for(const invalid of [{...payload,channel:'bad'},{...payload,messageId:payload.replacementId}])await expect(cleanupLibraryMessage(db.env,invalid)).rejects.toThrow('identity');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('skips a disabled guild without any request',async()=>{
  const payload=await replacement();db.env.ALLOWED_GUILDS='222';await cleanupLibraryMessage(db.env,payload);expect(fetch).not.toHaveBeenCalled();
 });
 it('still cleans the old channel after configuration changes without adopting the new channel',async()=>{
  const payload=await replacement();db.sqlite.prepare('INSERT INTO guilds(id,library_channel,updated_at) VALUES(?,?,?)').run(guild,'9002',iso());
  await sent('new-channel','300','9002');vi.mocked(fetch).mockResolvedValue(new Response(null,{status:204}));
  await cleanupLibraryMessage(db.env,payload);expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/channels/${channel}/messages/100`),expect.anything());expect(tracking('9002')!.message_id).toBe('300');
 });
 it('accepts only exact Unknown Message 10008 as successful missing-message proof',async()=>{
  const payload=await replacement();vi.mocked(fetch).mockResolvedValue(Response.json({code:10008},{status:404}));
  await expect(cleanupLibraryMessage(db.env,payload)).resolves.toBeUndefined();
 });
 it.each([10003,'10008',null])('does not accept a generic404/code%s as deletion proof',async code=>{
  const payload=await replacement();vi.mocked(fetch).mockResolvedValue(Response.json({code},{status:404}));
  await expect(cleanupLibraryMessage(db.env,payload)).rejects.toThrow('cleanup failed');
 });
 it.each([[0.2,1],[2.1,3],[100_000,86400],['bad',60]])('propagates bounded retry_after %s as %s seconds',async(retry_after,retryAfter)=>{
  const payload=await replacement();vi.mocked(fetch).mockResolvedValue(Response.json({retry_after},{status:429}));
  await expect(cleanupLibraryMessage(db.env,payload)).rejects.toMatchObject({message:'Library cleanup rate limited',retryAfter});
 });
 it('fails safely without a token or on a transient network failure',async()=>{
  const payload=await replacement();delete db.env.DISCORD_TOKEN;
  await expect(cleanupLibraryMessage(db.env,payload)).rejects.toThrow('token unavailable');expect(fetch).not.toHaveBeenCalled();
  db.env.DISCORD_TOKEN='fixture';await expect(cleanupLibraryMessage(db.env,payload)).rejects.toThrow('Unexpected external request');
 });
});

describe('library delivery and cleanup job integration',()=>{
 it('POSTs once, commits tracking before deferred DELETE, and retries only a failed cleanup',async()=>{
  await sent('previous','100');const event=await opening();
  const api=vi.mocked(fetch).mockResolvedValueOnce(Response.json({id:'200',channel_id:channel}));
  await consume(db.env,batch(`send:${event}`));
  expect(api).toHaveBeenCalledTimes(1);expect(api.mock.calls[0][1]!.method).toBe('POST');expect(tracking()!.message_id).toBe('200');
  expect(getJob(`send:${event}`).state).toBe('done');expect(getDelivery(event)).toMatchObject({state:'sent',message_id:'200'});
  const cleanup=String(cleanupJobs()[0].id);expect(getJob(cleanup).state).toBe('pending');
  api.mockResolvedValueOnce(new Response(null,{status:503}));await consume(db.env,batch(cleanup));
  expect(getJob(cleanup)).toMatchObject({state:'retry',attempts:1});expect(tracking()!.message_id).toBe('200');
  vi.advanceTimersByTime(120_000);api.mockResolvedValueOnce(new Response(null,{status:204}));await consume(db.env,batch(cleanup));
  await consume(db.env,batch(`send:${event}`));await consume(db.env,batch(cleanup));
  expect(api.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','DELETE','DELETE']);expect(getJob(cleanup)).toMatchObject({state:'done',attempts:2});
 });
 it.each(['uncertain','failed'] as const)('does not clean up or adopt a %s send result',async outcome=>{
  await sent('previous','100');const event=await opening();
  vi.mocked(fetch).mockResolvedValue(new Response(null,{status:outcome==='uncertain'?503:403}));
  await consume(db.env,batch(`send:${event}`));await consume(db.env,batch(`send:${event}`));
  expect(getDelivery(event).state).toBe(outcome);expect(tracking()!.message_id).toBe('100');expect(cleanupJobs()).toEqual([]);expect(fetch).toHaveBeenCalledOnce();
 });
 it('retains old tracking after confirmed POST but failed atomic storage, without another POST',async()=>{
  await sent('previous','100');const event=await opening();
  db.sqlite.exec("CREATE TRIGGER fail_tracking BEFORE UPDATE ON library_messages BEGIN SELECT RAISE(ABORT,'storage failed'); END");
  const api=vi.mocked(fetch).mockResolvedValue(Response.json({id:'200',channel_id:channel}));
  await expect(executeJob(db.env,getJob(`send:${event}`))).rejects.toThrow('storage failed');
  expect(getDelivery(event)).toMatchObject({state:'sending',message_id:null});expect(tracking()!.message_id).toBe('100');expect(cleanupJobs()).toEqual([]);
  await executeJob(db.env,getJob(`send:${event}`));expect(api).toHaveBeenCalledOnce();
 });
 it('leaves generic nonlibrary deliveries on their existing path without library adoption',async()=>{
  await sent('previous','100');const id='notice:new';delivery(id,'pending');
  const job={id:'send:notice:new',kind:'deliver',payload:JSON.stringify({deliveryId:id})} as Job;
  vi.mocked(fetch).mockResolvedValue(Response.json({id:'300',channel_id:channel}));await executeJob(db.env,job);
  expect(getDelivery(id)).toMatchObject({state:'sent',message_id:'300'});expect(tracking()!.message_id).toBe('100');expect(cleanupJobs()).toEqual([]);
 });
});
