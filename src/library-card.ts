import type {DiscordMessageInput} from './discord.ts';
import {LIBRARY_URL} from './library-source.ts';

/** Keep the durable text readable while presenting the same information as a notice-style card. */
export function libraryCard(content:string) {
 const [title,...lines]=content.split('\n');
 const text=`### ${title}\n\n${lines.join('\n')}`.replace(`<${LIBRARY_URL}>`,`[공식 좌석 현황](<${LIBRARY_URL}>)`);
 return {content:'',components:[{type:17,accent_color:0x5865f2,components:[{type:10,content:text}]}]} satisfies DiscordMessageInput;
}
