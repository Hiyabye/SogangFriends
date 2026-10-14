/** Original HTML may include inline images; retain it without exceeding a D1 row. */
export const ARCHIVE_MAX_BODY_BYTES=8*1024*1024;
export const ARCHIVE_MAX_REQUEST_BYTES=16*1024*1024;
export const ARCHIVE_INLINE_BODY_BYTES=1024*1024;
// A UTF-16 character takes at most three UTF-8 bytes (surrogate pairs take four).
// Keep chunks well below D1's 2,000,000-byte row ceiling, including row overhead.
export const ARCHIVE_CHUNK_CHARACTERS=256*1024;
export function archiveBodyChunks(body:string):string[] {
 const chunks:string[]=[];
 for(let start=0;start<body.length;){
  let end=Math.min(start+ARCHIVE_CHUNK_CHARACTERS,body.length);
  // Do not split an astral character across independently encoded TEXT rows.
  if(end<body.length&&body.charCodeAt(end-1)>=0xd800&&body.charCodeAt(end-1)<=0xdbff)end--;
  chunks.push(body.slice(start,end));start=end;
 }
 return chunks;
}
