import type { Env } from './types';
import type { DiscordMessageInput } from './discord';
import { todayKst } from './time';
import {NOTICE_CHANNEL_COLUMNS} from './notice-channels';

/** Reviews annotate history, never rewrite execution outcomes or authorize retries. */
export async function operationalStatus(env: Env, guildId: string): Promise<DiscordMessageInput> {
 const guild=await env.DB.prepare(`SELECT notices_channel,meals_channel,schedule_channel,library_channel,${Object.values(NOTICE_CHANNEL_COLUMNS).join(',')} FROM guilds WHERE id=?`).bind(guildId).first();
 const sources=await env.DB.prepare('SELECT id,last_success,last_attempt,error FROM sources ORDER BY id').all();
 const health=await env.DB.prepare('SELECT id,last_attempt,last_success,error FROM health ORDER BY id').all();
 const jobs=await env.DB.prepare(`SELECT j.kind,j.state,
 CASE WHEN r.job_state=j.state AND r.attempts=j.attempts THEN r.disposition ELSE 'unreviewed' END AS review,
 COUNT(*) AS count,MAX(j.created_at) AS latest
 FROM jobs j LEFT JOIN job_reviews r ON r.job_id=j.id
 WHERE j.kind!='interaction' GROUP BY j.kind,j.state,review ORDER BY j.kind,j.state,review`).all();
 const issues=await env.DB.prepare(`SELECT j.kind,j.state,COUNT(*) AS count,MAX(j.created_at) AS latest
 FROM jobs j LEFT JOIN job_reviews r ON r.job_id=j.id AND r.job_state=j.state AND r.attempts=j.attempts
 WHERE j.state IN ('failed','needs_review') AND j.kind!='interaction' AND (r.disposition IS NULL OR r.disposition='deferred')
 GROUP BY j.kind,j.state ORDER BY j.kind,j.state`).all();
 const interactions=await env.DB.prepare(`SELECT state,COUNT(*) AS count FROM jobs WHERE kind='interaction' AND state IN ('failed','needs_review')
 AND json_extract(payload,'$.interaction.guild_id')=? GROUP BY state`).bind(guildId).all();
 const deliveries=await env.DB.prepare('SELECT state,COUNT(*) AS count FROM deliveries WHERE guild_id=? GROUP BY state').bind(guildId).all();
 const summary=await env.DB.prepare(`SELECT m.state,m.updated_date,m.message_id,m.retry_at,m.error FROM schedule_messages m
 JOIN guilds g ON g.id=m.guild_id AND g.schedule_channel=m.channel_id WHERE m.guild_id=?`).bind(guildId).first();
 const library=await env.DB.prepare(`SELECT b.channel_id,b.post_state,b.retry_at,b.display_key,b.error FROM library_board_state b
 JOIN guilds g ON g.id=b.guild_id AND g.library_channel=b.channel_id WHERE b.guild_id=?`).bind(guildId).first();
 const usage=await env.DB.prepare("SELECT COUNT(*) runs,SUM(reserved_usd) reserved,SUM(actual_usd) actual FROM llm_usage WHERE day=? AND state!='confirmed_rejected'").bind(todayKst()).first();
 const content=`서버 설정: ${JSON.stringify(guild)}\n수집: ${JSON.stringify(sources.results)}\n식단·도서관·Cron: ${JSON.stringify(health.results)}\n학사일정 게시물: ${JSON.stringify(summary)}\n도서관 게시물: ${JSON.stringify(library)}\n공유 미해결·보류: ${JSON.stringify(issues.results)}\n공유 작업 이력: ${JSON.stringify(jobs.results)}\n이 서버 명령 오류(서버 식별 가능 기록만): ${JSON.stringify(interactions.results)}\n이 서버 발송: ${JSON.stringify(deliveries.results)}\n과거 LLM 예약(오늘 KST): ${JSON.stringify(usage)}\nclosed=검토 종료(성공 아님), deferred=보류, unreviewed=미검토. 상태·시도 수가 바뀌면 기존 검토는 무효입니다.\n오래된 만료 명령은 서버 식별정보가 이미 제거되어 집계하지 않습니다.\nreserved=보수적 예약액, actual=응답 비용(청구서 아님). needs_review/uncertain은 자동 재발송하지 않습니다. 작업 done은 게시 성공을 보장하지 않으며 게시물·발송 상태를 확인하세요.`;
 if(content.length<=2000)return content;
 const issueCount=issues.results.reduce((sum,row)=>sum+Number(row.count),0);
 return {content:`서버 설정: ${JSON.stringify(guild)}\n공유 미해결·보류: ${issueCount}건\n학사일정 게시물: ${JSON.stringify(summary)}\n상세 상태는 첨부 파일을 확인하세요. closed는 성공이 아닌 검토 종료입니다. 불확실한 결과는 자동 재실행하지 않습니다.`,file:{filename:`status-${todayKst()}.txt`,bytes:new TextEncoder().encode(content),mime:'text/plain; charset=utf-8'}};
}
