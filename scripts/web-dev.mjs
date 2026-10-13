// Start a generated-media demo only. This is deliberately host-loopback bound.
import {spawn} from 'node:child_process';
import {access,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from '../clients/web/node_modules/vite/dist/node/index.js';
const root=resolve('.');const media=join(root,'.local','media');
for(const name of ['Orbit','Horizon','Pulse'])await access(join(media,`Generated_${name}.mp4`));
const state=join(root,'.local','web-demo-state');await mkdir(state,{recursive:true});
process.env.VITE_DEMO_MODE='true';process.env.SHINEMA_API_ORIGIN='http://127.0.0.1:8787';
const server=spawn(join(root,'target','debug','shinema-server'+(process.platform==='win32'?'.exe':'')),[],{env:{...process.env,SHINEMA_MEDIA_ROOT:media,SHINEMA_STATE_DIR:state,SHINEMA_BIND:'127.0.0.1:8787'},stdio:['ignore','ignore','pipe']});
let error='';server.stderr.on('data',data=>{error+=data;});let vite;
try{
 let ready=false;
 for(let n=0;n<60;n++){
  if(server.exitCode!==null)throw new Error('Demo server exited; check that port 8787 is free.');
  if(error.includes('Shinema listening on loopback')){try{if((await fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!ready)throw new Error('Demo server startup timed out.');
 const catalog=await(await fetch('http://127.0.0.1:8787/api/catalog')).json();
 if(JSON.stringify(catalog.items.map(item=>item.title).sort())!==JSON.stringify(['Generated Horizon','Generated Orbit','Generated Pulse']))throw new Error('Demo fixture directory must contain only the three generated clips.');
 vite=await createServer({configFile:join(root,'clients','web','vite.config.ts'),root:join(root,'clients','web')});await vite.listen();
 console.log('Generated Shinema demo: http://127.0.0.1:5173 (host only). Press Ctrl+C to stop both servers. Playback starts muted.');
 await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);server.once('exit',resolve);});
}finally{
 await vite?.close();if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}
}
