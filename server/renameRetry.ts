import fs from 'node:fs/promises';

/** Windows: rename over a file another process (browser poll, antivirus, indexer) has open fails with EPERM/EBUSY/EACCES for a moment. Retry briefly. */
export async function renameRetry(from:string,to:string,attempts=12,delayMs=25){
  for(let i=0;;i++){
    try{await fs.rename(from,to);return;}
    catch(error){const code=(error as NodeJS.ErrnoException).code;if(i>=attempts-1||!(code==='EPERM'||code==='EBUSY'||code==='EACCES'))throw error;await new Promise(r=>setTimeout(r,delayMs*(i+1)));}
  }
}
