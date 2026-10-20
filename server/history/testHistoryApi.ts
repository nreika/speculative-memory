import type {SourceObservationIndex} from './sourceObservationIndex';
import {captureHistoryContext,ScopedTestHistory} from './historyDisplay';

/** Cache-only test playback update. Callers cannot submit observation text or generated captions. */
export function updateTestHistory(index:Pick<SourceObservationIndex,'lookupSha256'>|null,history:ScopedTestHistory,request:unknown,at=new Date().toISOString()) {
 if(!request||typeof request!=='object'||Array.isArray(request))throw new Error('JSON object required');
 const body=request as Record<string,unknown>;
 const allowed=new Set(['sourceImageSha256','testSceneId','testFrameId','testRunId','testLoop','testSourceStartedAt']);
 if(Object.keys(body).some(key=>!allowed.has(key)))throw new Error('Unknown test history field');
 if(typeof body.sourceImageSha256!=='string'||!/^[a-f0-9]{64}$/i.test(body.sourceImageSha256))throw new Error('Original source SHA256 required');
 const context=captureHistoryContext({captureId:'test-observation',isTest:true,useLiveHistory:false,request:body});
 if(context.scope.kind!=='test'||!context.echo.testFrameId)throw new Error('Valid test scene, frame, run UUID and positive loop are required');
 const lookup=index?.lookupSha256(body.sourceImageSha256,{sceneId:context.echo.testSceneId,frameId:context.echo.testFrameId})??{status:'unavailable' as const};
 const update=lookup.status==='hit'?history.observe(context.scope,lookup.record,at):{updated:false,snapshot:history.snapshot(context.scope)};
 return {ok:lookup.status==='hit',sourceStatus:lookup.status,updated:update.updated,...context.echo,nowText:lookup.status==='hit'?lookup.record.observation:'',historySummary:update.snapshot.summary,observationCount:update.snapshot.observationCount,sourceObservedAt:lookup.status==='hit'?lookup.record.sourceObservedAt:null,replayedAt:at};
}
