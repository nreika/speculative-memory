// Recent generation errors and fallbacks for the MAIN screen error box (in memory, newest first).
// Repeats of the same message are folded into one row with a count so a failure loop stays readable.
export type OperatorWarning={at:string;kind:string;message:string;captureId?:string;count:number};
const MAX=20;
const rows:OperatorWarning[]=[];
export const operatorWarnings={
  push(kind:string,message:string,captureId?:string){
    const text=String(message||'').slice(0,500);if(!text)return;
    const top=rows[0];
    if(top&&top.kind===kind&&top.message===text){top.count++;top.at=new Date().toISOString();if(captureId)top.captureId=captureId;return;}
    rows.unshift({at:new Date().toISOString(),kind,message:text,captureId,count:1});
    rows.length=Math.min(rows.length,MAX);
  },
  list():OperatorWarning[]{return rows.map(row=>({...row}));},
  clear(){rows.length=0;},
};
