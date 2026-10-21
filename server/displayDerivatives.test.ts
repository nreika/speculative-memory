import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {displayImageUrl,makeDerivatives,readDisplayFaces,setDisplayCapturesDir} from './displayDerivatives';
test('display url only switches once the derivative exists; foreign urls untouched',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disp-'));setDisplayCapturesDir(dir);
 assert.equal(displayImageUrl('/captures/Gen_a_x.png'),'/captures/Gen_a_x.png');
 assert.equal(displayImageUrl('/captures/record_x.jpg'),'/captures/record_x.jpg');
 assert.equal(readDisplayFaces('/captures/display/none.jpg'),null);
 assert.equal(readDisplayFaces('/captures/display/../x.jpg'),null);
});
