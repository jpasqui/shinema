import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import assert from 'node:assert/strict';
import {parseCatalog,parseProgress} from '../packages/contracts/index.ts';

const root=await mkdtemp(join(tmpdir(),'shinema-smoke-'));const media=join(root,'media');const state=join(root,'state');
await mkdir(media);const bytes=Buffer.from('Generated fixture bytes for HTTP range testing.');
await writeFile(join(media,'Generated_sample.mp4'),bytes);
const unicode=JSON.parse(await readFile(new URL('../packages/contracts/fixtures/unicode-title.json',import.meta.url),'utf8'));
await writeFile(join(media,unicode.title+'.mp4'),bytes);
const port=28787;const origin=`http://127.0.0.1:${port}`;
// This is a host-only loopback transport test, not the Android client's HTTPS policy.
const server=spawn(resolve('target/debug/shinema-server'+(process.platform==='win32'?'.exe':'')),[],{env:{...process.env,SHINEMA_MEDIA_ROOT:media,SHINEMA_STATE_DIR:state,SHINEMA_BIND:`127.0.0.1:${port}`},stdio:['ignore','ignore','pipe']});
let error='';server.stderr.on('data',data=>{error+=data;});
async function ready(){
 for(let n=0;n<40;n++){
  if(server.exitCode!==null)throw new Error('Server exited during startup: '+error);
  if(error.includes('Shinema listening on loopback')){
   try{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}
  }
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new Error('Loopback server did not become ready');
}
try{
 await ready();const catalog=parseCatalog(await(await fetch(origin+'/api/catalog')).json());assert.equal(catalog.items.length,2);
 assert(catalog.items.some(item=>item.title===unicode.title));
 const item=catalog.items.find(item=>item.title==='Generated sample');const response=await fetch(origin+item.streamPath,{headers:{Range:'bytes=2-7'}});
 assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(2,8));
 const value={positionSeconds:12,durationSeconds:60};const path=`/api/media/${item.id}/progress`;
 assert.equal((await fetch(origin+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).status,204);
 assert.deepEqual(parseProgress(await(await fetch(origin+path)).json()),value);
 console.log('Host loopback catalog/byte-range/progress contract smoke passed. No device or private media used.');
}finally{
 const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();if(server.exitCode===null)await stopped;
 assert(root.startsWith(resolve(tmpdir())+sep) && basename(root).startsWith('shinema-smoke-'));
 await rm(root,{recursive:true,force:true});
}
