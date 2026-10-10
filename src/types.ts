export interface Env {
 DB: D1Database; JOBS: Queue<{id:string}>;
 DISCORD_PUBLIC_KEY?: string; DISCORD_TOKEN?: string; DISCORD_APPLICATION_ID?: string;
 ALLOWED_GUILDS?: string; OPENROUTER_API_KEY?: string; MEAL_MODEL?: string; MEAL_FALLBACK_MODEL?: string;
 PROCESSING_VERSION?: string; SOURCE_INTERVAL_HOURS?: string; MEAL_TIME_KST?: string;
 NOTICE_COLLECTION_MODE?: 'worker'|'external'; NOTICE_INGEST_SECRET?: string;
 NOTICE_ARCHIVE_ENABLED?: string;
 LLM_ENABLED?: string; LLM_DAILY_CALLS?: string; LLM_DAILY_BUDGET_USD?: string; LLM_MAX_CALL_USD?: string;
}
export interface Notice {id:string; source:string; title:string; published:string; url:string}
export interface Source {id:string; name:string; url:string; kind:'university'|'computing'}
export interface Offering {status:'available'|'closed'|'unknown'; items:string[]; time:string|null; evidence:string}
export interface MealDay {date:string; weekday:number; breakfastKorean:Offering; breakfastWestern:Offering; breakfastCommon:Offering; cupRice:Offering; dinner:Offering; drinks:Offering}
export interface MealWeek {start:string; end:string; certain:boolean; days:MealDay[]}
export interface Schedule {id:string; title:string; startDate:string; endDate?:string; deadlineDate?:string; deadlineAt?:string; type:'event'|'period'|'deadline'; sourceUrl:string; lastReviewed:string; note:string; active?:boolean}
export interface Job {id:string; kind:string; payload:string; state:string; attempts:number; created_at:string; lease_until:string|null}
