// Make display JPEG + face boxes for the newest generated PNGs: npx tsx scripts/backfill-display.ts [count]
import fs from 'node:fs';import path from 'node:path';import {makeDerivatives,setDisplayCapturesDir} from '../server/displayDerivatives';
const dir=path.resolve('captures');setDisplayCapturesDir(dir);const n=Number(process.argv[2])||100;
const files=fs.readdirSync(dir).filter(f=>/^Gen_[a-z]_.*\.png$/i.test(f)).sort().slice(-n);
(async()=>{const t=Date.now();for(const f of files)await makeDerivatives(path.join(dir,f));console.log(files.length,'files',Date.now()-t,'ms');})();
