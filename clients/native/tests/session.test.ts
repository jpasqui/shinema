import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fresh} from '../src/domain.ts';
import type {Stored} from '../src/domain.ts';
import {SessionGuard,ProgressQueue,connectValidated,persistThenSync,syncProgress,resolveResume,backDestination} from '../src/session.ts';

const first='https://first.example';const second='https://second.example';const id='a'.repeat(64);
const catalog={apiVersion:1 as const,items:[{id,title:'Generated sample',container:'mp4',sizeBytes:10,streamPath:`/api/media/${id}/stream`}]};
const progress={positionSeconds:12,durationSeconds:60};
function deferred<T>() {
  let resolve!:(value:T|PromiseLike<T>)=>void;let reject!:(error:unknown)=>void;
  const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};
}
function fixture() {
  let current:Stored={...fresh(),origin:first,catalog,progress:{[id]:progress},pending:{[id]:progress}};
  const disk:string[]=[];
  const io={read:()=>current,write:(next:Stored)=>{current=next;},persist:async()=>{disk.push(JSON.stringify(current));}};
  return {io,disk};
}

test('failed and malformed server trials preserve the working cache and queued progress, including Back persistence',async()=>{
  for(const load of [async()=>{throw new Error('mistyped host');},async()=>({apiVersion:99,items:[]})]) {
    const {io,disk}=fixture();const before=JSON.stringify(io.read());const guard=new SessionGuard();
    await assert.rejects(connectValidated(guard,guard.beginConnection(),second,load,io));
    assert.equal(JSON.stringify(io.read()),before);assert.equal(disk.length,0);
    assert.equal(backDestination('setup',Boolean(io.read().catalog)),'library');
    await io.persist();assert.equal(disk[0],before);
  }
});

test('Back cancels an unfinished candidate without changing the working server',async()=>{
  const {io}=fixture();const guard=new SessionGuard();const response=deferred<unknown>();
  const attempt=guard.beginConnection();const connecting=connectValidated(guard,attempt,second,()=>response.promise,io);
  guard.cancelConnection();response.resolve(catalog);
  assert.equal(await connecting,null);assert.equal(io.read().origin,first);assert.deepEqual(io.read().pending[id],progress);
});

test('an older connection response cannot replace a newer validated server',async()=>{
  const {io}=fixture();const guard=new SessionGuard();const old=deferred<unknown>();
  const pending=connectValidated(guard,guard.beginConnection(),first,()=>old.promise,io);
  const accepted=await connectValidated(guard,guard.beginConnection(),second,async()=>catalog,io);
  assert(accepted?.switched);old.resolve(catalog);assert.equal(await pending,null);assert.equal(io.read().origin,second);
});

test('delayed disk write cannot send old progress to a newly confirmed origin',async()=>{
  const {io}=fixture();const guard=new SessionGuard();guard.confirm(first);const disk=deferred<void>();const sent:string[]=[];
  const saving=persistThenSync(guard,guard.capture(first),()=>disk.promise,()=>io.read().origin,async destination=>{sent.push(destination.origin);});
  await connectValidated(guard,guard.beginConnection(),second,async()=>catalog,io);
  disk.resolve();assert.equal(await saving,false);assert.deepEqual(sent,[]);
});

test('a failed server trial leaves an old save eligible only for its captured original destination',async()=>{
  const {io}=fixture();const guard=new SessionGuard();guard.confirm(first);const disk=deferred<void>();const sent:string[]=[];
  const saving=persistThenSync(guard,guard.capture(first),()=>disk.promise,()=>io.read().origin,async destination=>{sent.push(destination.origin);});
  await assert.rejects(connectValidated(guard,guard.beginConnection(),second,async()=>{throw new Error('unavailable');},io));
  disk.resolve();assert.equal(await saving,true);assert.deepEqual(sent,[first]);
});

test('failed persistence sends nothing and a reconnect replays the retained pending value to the same origin',async()=>{
  const {io}=fixture();const guard=new SessionGuard();const sent:Array<{origin:string;value:unknown}>=[];
  await assert.rejects(persistThenSync(guard,guard.capture(first),async()=>{throw new Error('disk');},()=>io.read().origin,async destination=>{sent.push({origin:destination.origin,value:progress});}));
  assert.deepEqual(sent,[]);assert.deepEqual(io.read().pending[id],progress);
  const accepted=await connectValidated(guard,guard.beginConnection(),first,async()=>catalog,io);assert(accepted);
  assert.deepEqual(io.read().pending[id],progress);
  await syncProgress(guard,accepted.stamp,id,progress,io,async(origin,_key,value)=>{sent.push({origin,value});});
  assert.deepEqual(sent,[{origin:first,value:progress}]);assert.equal(io.read().pending[id],undefined);
});

test('progress queue serializes writes and an older acknowledgement cannot discard a newer position',async()=>{
  const {io}=fixture();const guard=new SessionGuard();const queue=new ProgressQueue();const slow=deferred<void>();const began=deferred<void>();const sent:number[]=[];
  const old=queue.enqueue(()=>syncProgress(guard,guard.capture(first),id,progress,io,async(_origin,_id,value)=>{sent.push(value.positionSeconds);began.resolve();await slow.promise;}));
  await began.promise;const newer={positionSeconds:22,durationSeconds:60};io.write({...io.read(),pending:{[id]:newer},progress:{[id]:newer}});
  const next=queue.enqueue(()=>syncProgress(guard,guard.capture(first),id,newer,io,async(_origin,_id,value)=>{sent.push(value.positionSeconds);}));
  assert.deepEqual(sent,[12]);slow.resolve();await old;await next;
  assert.deepEqual(sent,[12,22]);assert.equal(io.read().pending[id],undefined);assert.equal(io.read().progress[id].positionSeconds,22);
});

test('old acknowledgement cannot clear same-ID pending data on a new server',async()=>{
  const {io}=fixture();const guard=new SessionGuard();const reply=deferred<void>();const started=deferred<void>();const sent:string[]=[];
  const saving=syncProgress(guard,guard.capture(first),id,progress,io,async origin=>{sent.push(origin);started.resolve();await reply.promise;});
  await started.promise;guard.confirm(second);const newer={positionSeconds:25,durationSeconds:60};io.write({...fresh(),origin:second,catalog,pending:{[id]:newer},progress:{[id]:newer}});
  reply.resolve();await saving;assert.deepEqual(sent,[first]);assert.deepEqual(io.read().pending[id],newer);
});

test('Select then Menu cancels a delayed resume GET instead of opening player over setup',async()=>{
  const {io}=fixture();io.write({...io.read(),pending:{}});const guard=new SessionGuard();const reply=deferred<unknown>();
  let route='detail';const ticket=guard.beginPlayback(first);
  const opening=resolveResume(guard,ticket,id,io.read,()=>reply.promise).then(value=>{if(value)route='player';return value;});
  guard.cancelConnection();route='setup';reply.resolve(progress);
  assert.equal(await opening,null);assert.equal(route,'setup');
});

test('Back, a confirmed server switch and a newer play request invalidate older resume completions',async()=>{
  for(const change of ['back','server','play']){
    const {io}=fixture();io.write({...io.read(),pending:{}});const guard=new SessionGuard();const reply=deferred<unknown>();
    const opening=resolveResume(guard,guard.beginPlayback(first),id,io.read,()=>reply.promise);
    if(change==='back')guard.invalidatePlayback();
    else if(change==='server'){guard.confirm(second);io.write({...fresh(),origin:second,catalog});}
    else guard.beginPlayback(first);
    reply.resolve(progress);assert.equal(await opening,null,change);
  }
});

test('native Back fallback routes setup with cached data to library; empty setup exits',()=>{
  assert.equal(backDestination('setup',true),'library');assert.equal(backDestination('setup',false),'exit');
  assert.equal(backDestination('player',true),'detail');assert.equal(backDestination('detail',true),'library');assert.equal(backDestination('library',true),'exit');
});
