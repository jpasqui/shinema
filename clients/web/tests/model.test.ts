import {test} from 'node:test';
import assert from 'node:assert/strict';
import {empty,recover,NavigationGuard,Queue,synchronize,progressValue,resumeAt,initializeSilentVideo} from '../src/model.ts';
import type {Cache} from '../src/model.ts';
const id='a'.repeat(64);const progress={positionSeconds:12,durationSeconds:60};
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
