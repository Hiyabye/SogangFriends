export const NOTICE_GROUPS = [
 {id:'university',name:'서강대학교',sources:['university','universityStudent','universityScholarship','universityGeneral','universityEvent','universityOnestop']},
 {id:'computing',name:'소프트웨어융합대학',sources:['academicNotice','graduateNotice','externalInfo','news','career']},
 {id:'swedu',name:'SW중심대학사업단',sources:['sweduNotice','sweduNews','sweduPress']},
 {id:'convedu',name:'융합교육원',sources:['conveduNotice','conveduNews']},
 {id:'bdata',name:'빅데이터 융복합 인재양성사업단',sources:['bdataNotice','bdataNews']},
 {id:'engineering',name:'공과대학',sources:['engineeringNotice','engineeringRecruit','engineeringAcademic','engineeringResearch']},
 {id:'psychology',name:'심리학과',sources:['psychologyNotice']},
 {id:'business',name:'경영학과',sources:['businessNotice']},
] as const;
export const NOTICE_CHANNEL_COLUMNS = {
 university:'university_channel',computing:'computing_channel',swedu:'swedu_channel',
 convedu:'convedu_channel',bdata:'bdata_channel',engineering:'engineering_channel',
 psychology:'psychology_channel',business:'business_channel',
} as const;
export function noticeChannelColumn(source:string) {
 const group=NOTICE_GROUPS.find(group=>(group.sources as readonly string[]).includes(source));
 return group?NOTICE_CHANNEL_COLUMNS[group.id]:undefined;
}
