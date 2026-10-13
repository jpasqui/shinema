import {test} from 'node:test';
import assert from 'node:assert/strict';
import {empty,recover,NavigationGuard,Queue,synchronize,progressValue,resumeAt,initializeSilentVideo,loadPlaybackProgress} from '../src/model.ts';
import type {Cache} from '../src/model.ts';
import {parseCatalog} from '../../../packages/contracts/index.ts';
const id='a'.repeat(64);const progress={positionSeconds:12,durationSeconds:60};
test('optional thumbnails retain old catalogs and accept only the matching relative media endpoint',()=>{
 const item={id,title:'Generated sample',container:'mp4',sizeBytes:20,streamPath:`/api/media/${id}/stream`};
 assert.equal(parseCatalog({apiVersion:1,items:[item]}).items[0].posterPath,undefined);
 assert.equal(parseCatalog({apiVersion:1,items:[{...item,posterPath:`/api/media/${id}/poster`}]}).items[0].posterPath,`/api/media/${id}/poster`);
 for(const posterPath of ['https://example.invalid/poster','/api/media/'+'b'.repeat(64)+'/poster',null])assert.throws(()=>parseCatalog({apiVersion:1,items:[{...item,posterPath}]}));
});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
test('12 to 22 to 12 retains the newest request until its own acknowledgement and skips obsolete queued writes',async()=>{
 let cache:Cache=empty();let persisted='';let serverPosition=0;const sent:number[]=[];const queue=new Queue();
 const firstStarted=deferred<void>();const firstAck=deferred<void>();const lastStarted=deferred<void>();const lastAck=deferred<void>();
 const persist=()=>{persisted=JSON.stringify(cache);};
 const io={read:()=>cache,write:(next:Cache)=>{cache=next;},persist,send:async(_id:string,value:typeof progress)=>{
   sent.push(value.positionSeconds);serverPosition=value.positionSeconds;
   if(sent.length===1){firstStarted.resolve();await firstAck.promise;}
   else if(value.positionSeconds===12){lastStarted.resolve();await lastAck.promise;}
 }};
 const enqueue=(positionSeconds:number)=>{const value={positionSeconds,durationSeconds:60};cache={...cache,progress:{[id]:value},pending:{[id]:value}};persist();return {value,job:queue.run(()=>synchronize(id,value,io))};};
 const first=enqueue(12);await firstStarted.promise;const middle=enqueue(22);const latest=enqueue(12);
 firstAck.resolve();await first.job;await middle.job;await lastStarted.promise;
 assert.equal(cache.pending[id],latest.value);assert.deepEqual(recover(persisted).pending[id],latest.value);assert.deepEqual(sent,[12,12]);assert.equal(serverPosition,12);
 lastAck.resolve();await latest.job;assert.equal(cache.pending[id],undefined);assert.equal(recover(persisted).pending[id],undefined);
});
test('a delayed old GET cannot supersede a pending position acknowledged during that GET',async()=>{
 const latest={positionSeconds:28,durationSeconds:60};let cache:Cache={...empty(),progress:{[id]:latest},pending:{[id]:latest}};
 const get=deferred<unknown>();const put=deferred<void>();
 const loaded=loadPlaybackProgress(id,{read:()=>cache,revision:()=>0,load:()=>get.promise});
 const synchronized=synchronize(id,latest,{read:()=>cache,write:next=>{cache=next;},persist:()=>{},send:()=>put.promise});
 put.resolve();await synchronized;assert.equal(cache.pending[id],undefined);
 get.resolve({positionSeconds:4,durationSeconds:60});assert.deepEqual(await loaded,latest);
});
test('a local write created and acknowledged while GET is delayed wins over the old remote response',async()=>{
 let cache:Cache={...empty(),progress:{[id]:progress}};let revision=0;const get=deferred<unknown>();
 const loaded=loadPlaybackProgress(id,{read:()=>cache,revision:()=>revision,load:()=>get.promise});
 const latest={positionSeconds:35,durationSeconds:60};revision++;cache={...cache,progress:{[id]:latest},pending:{[id]:latest}};
 await synchronize(id,latest,{read:()=>cache,write:next=>{cache=next;},persist:()=>{},send:async()=>{}});
 get.resolve(progress);assert.deepEqual(await loaded,latest);
});
test('corrupt browser cache recovers and pending progress survives a restart',()=>{
 assert.deepEqual(recover('invalid'),empty());assert.deepEqual(recover(JSON.stringify({...empty(),progress:{[id]:progress},pending:{[id]:progress}})).pending[id],progress);
});
test('navigation invalidates delayed detail/resume work',()=>{
 const guard=new NavigationGuard();const detail=guard.next();guard.next();assert.equal(guard.current(detail),false);
});
test('old sync acknowledgement cannot remove a newer pending position',async()=>{
 let cache:Cache={...empty(),pending:{[id]:{positionSeconds:22,durationSeconds:60}}};let saved=0;
 await synchronize(id,progress,{read:()=>cache,write:value=>{cache=value;},persist:()=>{saved++;},send:async()=>{}});
 assert.equal(cache.pending[id].positionSeconds,22);assert.equal(saved,0);
});
test('failed progress sync retains local data and the queue recovers for retry',async()=>{
 let cache:Cache={...empty(),pending:{[id]:progress}};const queue=new Queue();let saved=0;
 const io={read:()=>cache,write:(value:typeof cache)=>{cache=value;},persist:()=>{saved++;},send:async()=>{throw new Error('offline');}};
 await assert.rejects(queue.run(()=>synchronize(id,progress,io)));assert.deepEqual(cache.pending[id],progress);
 await queue.run(()=>synchronize(id,progress,{...io,send:async()=>{}}));assert.equal(cache.pending[id],undefined);assert.equal(saved,1);
});
test('resume restarts completed clips and seek progress stays within finite duration',()=>{
 assert.equal(resumeAt(progress,60),12);assert.equal(resumeAt({positionSeconds:59,durationSeconds:60},60),0);
 assert.deepEqual(progressValue(80,60),{positionSeconds:60,durationSeconds:60});assert.equal(progressValue(NaN,60),null);
});
test('video is silent before its source is assigned',()=>{
 const log:Array<string>=[];const node={_muted:false,_default:false,_volume:1,_src:'',get muted(){return this._muted;},set muted(value:boolean){this._muted=value;log.push('muted');},get defaultMuted(){return this._default;},set defaultMuted(value:boolean){this._default=value;log.push('defaultMuted');},get volume(){return this._volume;},set volume(value:number){this._volume=value;log.push('volume');},get src(){return this._src;},set src(value:string){assert(this.muted && this.defaultMuted && this.volume===0);this._src=value;log.push('source');}};
 initializeSilentVideo(node,'/api/media/'+id+'/stream');assert.deepEqual(log,['defaultMuted','muted','volume','source']);
});
