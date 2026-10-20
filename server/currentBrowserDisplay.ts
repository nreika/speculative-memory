/** Fixed current scene aliases, independent of saved comparisons and output-slot layout. */
import {createHash} from 'node:crypto';
import {browserOutputCurrent} from './browserOutputCurrent';
import {buildBrowserDisplaySnapshot,type BrowserDisplaySnapshot} from './browserDisplay';
import type {CaptureEvent} from './events/captureEvents';
import type {TdBrowserSnapshotOptions} from './tdBrowserFollow';

const aliases={'current-now':'now','current-a':'a','current-b':'b','current-c':'c'}as const;
export function currentBrowserSnapshot(id:string,rows:CaptureEvent[],nowMs:number,options:TdBrowserSnapshotOptions&{view?:BrowserDisplaySnapshot['view']}={}):BrowserDisplaySnapshot|undefined {
 if(!Object.hasOwn(aliases,id))return undefined;
 const key=aliases[id as keyof typeof aliases],label=key==='now'?'現在の元映像':'現在 '+key.toUpperCase();
 const current=browserOutputCurrent(rows,nowMs,options)[key];
 // A recognized alias always owns its namespace, including before the first valid image.
 // Returning undefined here would fall through to stale pinned comparison registry entries.
 const base=current??buildBrowserDisplaySnapshot({id,label,accent:'#397ad1',clock:{serverAnchorMs:0,worldAnchorMs:0,rate:1,scope:'current:waiting'},selection:{mode:'pinned',contentId:'current:waiting:'+key}},[],nowMs);
 const waiting=current?base:{...base,clock:{...base.clock,known:false},displayStatus:{requestedCaptureId:null,displayedCaptureId:null,state:'idle' as const,error:null,userMessage:'現在の画像の完成を待っています。',lastSuccessAtMs:null}};
 return {...waiting,...(options.view?{view:{...options.view}}:{}),screen:{...waiting.screen,id,label},revision:createHash('sha256').update(JSON.stringify({id,label,revision:waiting.revision,displayStatus:waiting.displayStatus,view:options.view})).digest('hex').slice(0,20)};
}
