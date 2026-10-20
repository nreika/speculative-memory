import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingFilename,recordingMetadata} from './recordingFiles';

test('recording history retains explicit acquisition time and camera identity only',()=>{
 assert.deepEqual(recordingMetadata({source:'live-camera',sourceScope:'camera:main',recordId:'rec-1',capturedAt:'2026-10-18T19:00:00+09:00'}),{source:'live-camera',sourceScope:'camera:main',recordId:'rec-1',capturedAt:'2026-10-18T10:00:00.000Z'});
 for(const capturedAt of [undefined,'2026-10-18T19:00:00','not-a-time','2026-02-30T19:00:00Z'])assert.equal(recordingMetadata({source:'live-camera',capturedAt}).capturedAt,null);
 assert.equal(recordingMetadata({capturedAt:'2026-10-18T19:00:00.123456+09:00'}).capturedAt,'2026-10-18T10:00:00.123Z');
 assert.equal(recordingMetadata({sourceScope:'camera:main'}).sourceScope,null);
 assert.equal(recordingMetadata({source:'live-camera',sourceScope:'test:scene:run'}).sourceScope,null);
});
test('live records in the same second cannot overwrite each other or generation source frames',()=>{
 const names=Array.from({length:100},()=>recordingFilename('2026-10-17_19-00-00','jpg'));
 assert.equal(new Set(names).size,100);
 for(const name of names){assert.match(name,/^live_record_2026-10-17_19-00-00_[0-9a-f-]+\.jpg$/);assert.notEqual(name,'record_2026-10-17_19-00-00.jpg');}
});
