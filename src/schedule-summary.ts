import type {Env,Schedule} from './types';
import {scheduleCard} from './schedule-card';
import {boardHash,BoardRetry,updateBoard} from './message-board';
import {validDate} from './time';
export {scheduleCard as scheduleSummary} from './schedule-card';
export {BoardRetry as ScheduleSummaryRetry};
/** Existing message identity/uncertainty is retained; hashes permit same-day changes. */
export async function updateScheduleSummary(env:Env,guild:string,channel:string,date:string,items:Schedule[],allowCreate=true):Promise<void>{
 if(!validDate(date))throw new Error('Invalid summary date');
 const input=scheduleCard(items,date);
 const hash=await boardHash(input);
 await updateBoard(env,guild,channel,{table:'schedule_messages',field:'schedule_channel',date,key:date,hash,allowCreate,valid:()=>true,render:async()=>input});
}
