import type { Env, Job } from './types';
import { allowedGuild, authorized, batchNotices, message, validateChannel, verifyRequest } from './discord';
import { SOURCES } from './sources';
import { todayKst, validDate } from './time';
import { upcomingSchedules } from './schedule';
import { consume, getSchedules, mealResponse, planCron } from './jobs';
import { enqueue, nowIso } from './storage';
import {handleNoticeIngest} from './notice-ingest';
import {handleNoticeArchive} from './notice-archive';
interface Interaction {id:string;application_id:string;token:string;type:number;guild_id?:string;member?:{permissions?:string};data?:{name:string;options?:{name:string;value:string}[]}}
function reply(content:string,ephemeral=true) {return Response.json({type:4,data:{...message(content),...(ephemeral?{flags:64}:{})}});}
export async function handleRequest(request:Request,env:Env):Promise<Response> {
 if(new URL(request.url).pathname==='/internal/notices'&&request.method==='POST')return handleNoticeIngest(request,env);
 if(new URL(request.url).pathname==='/internal/notice-archive'&&request.method==='POST')return handleNoticeArchive(request,env);
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
async function commandContent(env:Env,i:Interaction):Promise<string> {
 const options=Object.fromEntries((i.data!.options??[]).map(o=>[o.name,o.value]));
 switch(i.data!.name) {
 case 'meal': return mealResponse(env,options.date??todayKst());
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
 if(!Object.keys(options).length) return '채널 옵션 notices, meals, schedule 중 하나 이상을 지정하세요.';
 for(const [key,value] of Object.entries(options)){
 if(!['notices','meals','schedule'].includes(key)) return '잘못된 채널 설정입니다.';
 try{await validateChannel(env,i.guild_id!,value);}catch(error){return error instanceof Error?error.message:'채널 권한 확인 실패';}
 }
 await env.DB.prepare('INSERT OR IGNORE INTO guilds(id,updated_at) VALUES(?,?)').bind(i.guild_id!,nowIso()).run();
 const statements=Object.entries(options).map(([key,value])=>env.DB.prepare(`UPDATE guilds SET ${key==='notices'?'notices':key==='meals'?'meals':'schedule'}_channel=?,updated_at=? WHERE id=?`).bind(value,nowIso(),i.guild_id!));
 await env.DB.batch(statements);
 return '채널을 연결했습니다. 공지 첫 수집은 과거 글을 발송하지 않습니다. 식단·학사 일정 알림은 지정한 일일 시간대에만 발송합니다.';
 }
 case 'status': {
 if(!authorized(i,env)) return '서버 관리 권한이 필요합니다.';
 const guild=await env.DB.prepare('SELECT notices_channel,meals_channel,schedule_channel FROM guilds WHERE id=?').bind(i.guild_id!).first();
 const sources=await env.DB.prepare('SELECT id,last_success,last_attempt,error FROM sources').all();
 const health=await env.DB.prepare('SELECT id,last_attempt,last_success,error FROM health').all();
 const jobs=await env.DB.prepare('SELECT state,COUNT(*) count FROM jobs WHERE kind!=\'interaction\' GROUP BY state').all();
 const deliveries=await env.DB.prepare('SELECT state,COUNT(*) count FROM deliveries WHERE guild_id=? GROUP BY state').bind(i.guild_id!).all();
 const usage=await env.DB.prepare('SELECT COUNT(*) calls,SUM(reserved_usd) reserved,SUM(actual_usd) actual FROM llm_usage WHERE day=?').bind(todayKst()).first();
 return `서버 설정: ${JSON.stringify(guild)}\n수집: ${JSON.stringify(sources.results)}\n식단·Cron: ${JSON.stringify(health.results)}\n공유 작업: ${JSON.stringify(jobs.results)}\n이 서버 발송: ${JSON.stringify(deliveries.results)}\nLLM 오늘: ${JSON.stringify(usage)} (reserved=보수적 예약액, actual=응답 비용; 청구서 아님)\nneeds_review/uncertain은 자동 재발송하지 않습니다.`;
 }
 default: return '지원하지 않는 명령입니다.';
 }
}
export async function completeInteraction(env:Env,job:Job) {
 const {interaction:i,expires}=JSON.parse(job.payload) as {interaction:Interaction;expires:number};
 if(!i||Date.now()>expires) return;
 if(!allowedGuild(i.guild_id,env)) return;
 let content:string;
 try{content=await commandContent(env,i);}catch{content='처리하지 못했습니다. 관리자는 /status에서 상태를 확인하세요.';}
 // Idempotent edit rather than a second public POST; never expose REST response bodies.
 const response=await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(message(content)),signal:AbortSignal.timeout(10_000)});
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
