// Temporary read-only SSH preview. All credentials/configuration stay local.
import {readFile} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {createServer} from '../clients/web/node_modules/vite/dist/node/index.js';
import {validateConfig,sshReader,startPreview,createThumbnails} from './ssh-preview-core.mjs';
const path=process.env.SHINEMA_SSH_CONFIG;
if(!path||!isAbsolute(path))throw new Error('Set SHINEMA_SSH_CONFIG to an existing private absolute JSON path.');
const config=validateConfig(JSON.parse(await readFile(path,'utf8')));let reader,preview,vite;
try{
 reader=await sshReader(config);preview=await startPreview({reader,stateDirectory:config.stateDirectory});
 await createThumbnails(preview,{stateDirectory:config.stateDirectory,ffmpeg:config.ffmpeg??'ffmpeg'});
 process.env.VITE_DEMO_MODE='false';process.env.VITE_LIBRARY_LABEL=config.label??'Connected library';process.env.SHINEMA_API_ORIGIN='http://127.0.0.1:8787';
 const root=resolve('.');vite=await createServer({configFile:join(root,'clients','web','vite.config.ts'),root:join(root,'clients','web')});await vite.listen();
 console.log('Read-only SSH library preview ready: http://127.0.0.1:5173 (host loopback). Ctrl+C closes the preview.');
 await new Promise(done=>{process.once('SIGINT',done);process.once('SIGTERM',done);});
}finally{await vite?.close();if(preview)await preview.close();else await reader?.close();}
