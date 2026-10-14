import type { Env, Job } from './types';
import { allowedGuild, authorized, batchNotices, message, validateChannel, verifyRequest, type DiscordMessageInput } from './discord';
import { SOURCES } from './sources';
import { todayKst, validDate } from './time';
import { upcomingSchedules } from './schedule';
import { consume, getSchedules, mealCommandResponse, planCron } from './jobs';
import { enqueue, nowIso } from './storage';
import {handleNoticeIngest} from './notice-ingest';
import {handleNoticeArchive} from './notice-archive';
import {handleMealOcr} from './meal-ocr';
import {operationalStatus} from './status';
import {NOTICE_CHANNEL_COLUMNS} from './notice-channels';
const SETUP_CHANNEL_COLUMNS:Record<string,string>={notices:'notices_channel',meals:'meals_channel',schedule:'schedule_channel',...NOTICE_CHANNEL_COLUMNS};
interface Interaction {id:string;application_id:string;token:string;type:number;guild_id?:string;member?:{permissions?:string};data?:{name:string;options?:{name:string;value:string}[]}}
function reply(content:string,ephemeral=true) {return Response.json({type:4,data:{...message(content),...(ephemeral?{flags:64}:{})}});}
export async function handleRequest(request:Request,env:Env):Promise<Response> {
 if(new URL(request.url).pathname==='/internal/notices'&&request.method==='POST')return handleNoticeIngest(request,env);
 if(new URL(request.url).pathname==='/internal/notice-archive'&&request.method==='POST')return handleNoticeArchive(request,env);
 if(new URL(request.url).pathname==='/internal/meal-compare'&&request.method==='POST')return new Response('Meal comparison retired',{status:410});
 if(new URL(request.url).pathname==='/internal/meal-ocr'&&request.method==='POST')return handleMealOcr(request,env);
 if(new URL(request.url).pathname!=='/interactions'||request.method!=='POST') return new Response('Not found',{status:404});
 if(!env.DISCORD_PUBLIC_KEY||!await verifyRequest(request,env.DISCORD_PUBLIC_KEY)) return new Response('Unauthorized',{status:401});
 let interaction:Interaction;
 try {interaction=await request.json();}catch{return new Response('Invalid request',{status:400});}
 if(interaction.type===1) return Response.json({type:1});
 if(interaction.type!==2||!interaction.data||!/^\d+$/.test(interaction.id)||!interaction.token||interaction.application_id!==env.DISCORD_APPLICATION_ID) return new Response('Invalid interaction',{status:400});
 if(!allowedGuild(interaction.guild_id,env)) return reply('이 서버에서는 봇을 사용할 수 없습니다.');
 const admin=['setup','status'].includes(interaction.data.name);
 if(admin&&!authorized(interaction,env)) return reply('서버 관리 권한이 필요합니다.');
 if(!['meal','notices','schedule','setup','status'].includes(interaction.data.name)) return reply('지원하지 않는 명령입니다.');
 const date=interaction.data.options?.find(o=>o.name==='date')?.value;
 if(date&&!validDate(date)) return reply('날짜를 YYYY-MM-DD 형식으로 입력하세요.');
 try {
 // Tokens are transient, never logged, removed at completion; Queue carries only a job ID.
 await enqueue(env,`interaction:${interaction.id}`,'interaction',{interaction:{id:interaction.id,application_id:interaction.application_id,token:interaction.token,type:interaction.type,guild_id:interaction.guild_id,member:{permissions:interaction.member?.permissions},data:interaction.data},expires:Date.now()+12*60_000});
 await env.JOBS.send({id:`interaction:${interaction.id}`},{delaySeconds:2});
 return Response.json({type:5,data:admin?{flags:64}:{}});
 } catch {return reply('작업을 접수하지 못했습니다. 잠시 후 다시 시도하세요.');}
}
async function commandContent(env:Env,i:Interaction):Promise<DiscordMessageInput> {
 const options=Object.fromEntries((i.data!.options??[]).map(o=>[o.name,o.value]));
 switch(i.data!.name) {
 case 'meal': return mealCommandResponse(env,options.date??todayKst());
 case 'notices': {
 const source=options.source;
 if(source&&!SOURCES.some(s=>s.id===source)) return '지원하지 않는 게시판입니다.';
 const rows=await env.DB.prepare(`SELECT id,source,title,published,url FROM notices ${source?'WHERE source=?':''} ORDER BY published DESC LIMIT 8`).bind(...(source?[source]:[])).all<{id:string;source:string;title:string;published:string;url:string}>();
 const chunks=batchNotices(rows.results.map(n=>({...n,source:SOURCES.find(s=>s.id===n.source)?.name??n.source})));
 // Original interaction is one message; preserve complete units and link to boards for more.
 return chunks[0]??'수집된 공지가 없습니다. 첫 수집 상태를 /status에서 확인하세요.';
 }
 case 'schedule': {
 const rows=upcomingSchedules(await getSchedules(env),todayKst());
 if(!rows.length) return '앞으로 30일의 검토된 학사 일정이 없습니다.\nhttps://www.sogang.ac.kr/ko/academic-support/calendar';
 let text='앞으로 30일 학사 일정 (한국 시간)\n';
 for(const s of rows) {
 const line=`\n${s.title} — ${s.startDate}${s.endDate?` ~ ${s.endDate}`:''}${s.deadlineAt?` / 마감 ${s.deadlineAt}`:s.deadlineDate?` / 마감일 ${s.deadlineDate} (시각 미공지)`:''}${s.active?'':' [자동 알림 미승인]'}\n${s.sourceUrl}\n`;
 if(text.length+line.length>1900){text+='\n전체 일정: https://www.sogang.ac.kr/ko/academic-support/calendar';break;}text+=line;
 } return text;
 }
 case 'setup': {
 if(!authorized(i,env)) return '서버 관리 권한이 필요합니다.';
 if(!Object.keys(options).length) return '채널 옵션 notices, university, computing, swedu, convedu, bdata, meals, schedule 중 하나 이상을 지정하세요.';
 for(const [key,value] of Object.entries(options)){
 if(!Object.hasOwn(SETUP_CHANNEL_COLUMNS,key)) return '잘못된 채널 설정입니다.';
 try{await validateChannel(env,i.guild_id!,value);}catch(error){return error instanceof Error?error.message:'채널 권한 확인 실패';}
 }
 await env.DB.prepare('INSERT OR IGNORE INTO guilds(id,updated_at) VALUES(?,?)').bind(i.guild_id!,nowIso()).run();
 const statements=Object.entries(options).map(([key,value])=>env.DB.prepare(`UPDATE guilds SET ${SETUP_CHANNEL_COLUMNS[key]}=?,updated_at=? WHERE id=?`).bind(value,nowIso(),i.guild_id!));
 await env.DB.batch(statements);
 return '채널을 연결했습니다. 기관별 공지는 지정한 전용 채널로만 보내며, 미설정 기관은 notices 채널을 사용합니다. 과거 공지를 재발송하거나 수집 기준을 초기화하지 않습니다. 식단·학사 일정 알림은 지정한 일일 시간대에만 발송합니다.';
 }
 case 'status': {
 if(!authorized(i,env)) return '서버 관리 권한이 필요합니다.';
 return operationalStatus(env,i.guild_id!);
 }
 default: return '지원하지 않는 명령입니다.';
 }
}
export async function completeInteraction(env:Env,job:Job) {
 const {interaction:i,expires}=JSON.parse(job.payload) as {interaction:Interaction;expires:number};
 if(!i||Date.now()>expires) return;
 if(!allowedGuild(i.guild_id,env)) return;
 let content:DiscordMessageInput;
 try{content=await commandContent(env,i);}catch{content='처리하지 못했습니다. 관리자는 /status에서 상태를 확인하세요.';}
 if(Date.now()>expires){
 await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error='interaction expired before reply' WHERE id=?").bind(job.id).run();return;
 }
 let body:BodyInit=JSON.stringify({attachments:[],...message(content)}),headers:HeadersInit|undefined={'Content-Type':'application/json'};
 if(typeof content!=='string'&&(content.file||content.files?.length)){
 const form=new FormData();form.append('payload_json',body);
 for(const [id,file] of (content.files??[content.file!]).entries())form.append(`files[${id}]`,new Blob([Uint8Array.from(file.bytes).buffer],{type:file.mime}),file.filename);
 body=form;headers=undefined;
 }
 // PATCH replaces the explicit attachment set on retries; never log files, tokens or REST bodies.
 const response=await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`,{method:'PATCH',headers,body,signal:AbortSignal.timeout(10_000)});
 if(!response.ok) throw new Error('interaction reply failed');
}
export default {
 fetch:handleRequest,
 async scheduled(event:ScheduledController,env:Env){
  const at=nowIso();
  console.info('Cron planning started',event.scheduledTime);
  try {
   await env.DB.prepare("INSERT INTO health(id,last_attempt) VALUES('cron',?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt").bind(at).run();
   await planCron(env,event.scheduledTime);
   await env.DB.prepare("UPDATE health SET last_success=?,error=NULL WHERE id='cron'").bind(nowIso()).run();
  } catch(error) {
   console.error('Cron planning failed',error);
   await env.DB.prepare("UPDATE health SET error='Cron planning failed; inspect Worker logs' WHERE id='cron'").run();
   throw error;
  }
 },
 async queue(batch:MessageBatch<{id:string}>,env:Env){await consume(env,batch);}
} satisfies ExportedHandler<Env, {id:string}>;
