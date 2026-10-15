import type {Notice} from './types';
import {SOURCES} from './sources';
import {display,truncate,noticeBatches,type DiscordCardComponent,type DiscordMessageInput} from './discord';

export interface NoticeCard {version:1;components:DiscordCardComponent[]}
const colors:Record<string,number>={university:0xed4245,universityStudent:0xed4245,universityScholarship:0xed4245,universityGeneral:0xed4245,universityEvent:0xed4245,universityOnestop:0xed4245,academicNotice:0x5865f2,graduateNotice:0x9b59b6,externalInfo:0x3498db,news:0x57f287,career:0xfee75c,sweduNotice:0xe67e22,sweduNews:0x1abc9c,sweduPress:0xf1c40f,conveduNotice:0x2ecc71,conveduNews:0x2ecc71,bdataNotice:0x11806a,bdataNews:0x11806a};

/** Retain legacy batch membership/IDs; only the displayed layout changes. */
export function batchNoticeCards(notices:Notice[]):{content:string;noticeCard:NoticeCard}[]{
 const named=notices.map(notice=>({...notice,source:SOURCES.find(source=>source.id===notice.source)?.name??notice.source}));
 return noticeBatches(named).map(batch=>{
  const groups=new Map<string,Notice[]>();
  for(const notice of batch.notices){const rows=groups.get(notice.source)??[];rows.push(notice);groups.set(notice.source,rows);}
  const components:DiscordCardComponent[]=[...groups].map(([source,rows])=>({type:17,accent_color:colors[SOURCES.find(s=>s.name===source)?.id??'']??0x5865f2,
   components:[{type:10,content:[`### ${display(truncate(source,50))}`,...rows.map(notice=>`**${display(truncate(notice.title,500))}**\n게시일 ${display(notice.published)} · [공식 원문](<${notice.url}>)`)].join('\n\n')}]}));
  const card:NoticeCard={version:1,components};noticeCardMessage(card);
  return {content:batch.content,noticeCard:card};
 });
}

/** Render only this bounded persisted format; old deliveries remain plain text. */
export function noticeCardMessage(card:NoticeCard):DiscordMessageInput{
 if(card.version!==1||!Array.isArray(card.components)||!card.components.length)throw new Error('Invalid notice card');
 let count=0,length=0;
 for(const container of card.components){
  if(container.type!==17||!Number.isInteger(container.accent_color)||container.accent_color<0||container.accent_color>0xffffff||!Array.isArray(container.components)||container.components.length!==1)throw new Error('Invalid notice card container');
  const text=container.components[0];if(text.type!==10||typeof text.content!=='string'||!text.content.length)throw new Error('Invalid notice card text');
  count+=2;length+=text.content.length;
 }
 if(count>40||length>4000)throw new Error('Notice card exceeds Discord limits');
 return {content:'',components:card.components};
}
