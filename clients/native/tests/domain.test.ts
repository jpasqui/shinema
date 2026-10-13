import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCatalog,parseProgress,resumeAt,serverOrigin} from '../../../packages/contracts/index.ts';
import {fresh,recover,move,pageFor} from '../src/domain.ts';
const id='a'.repeat(64);
const catalog={apiVersion:1,items:[{id,title:'Generated sample',container:'mp4',sizeBytes:100,streamPath:`/api/media/${id}/stream`}]};
test('API refuses arbitrary stream paths and duplicate IDs',()=>{
 assert.equal(parseCatalog(catalog).items.length,1);
 assert.throws(()=>parseCatalog({...catalog,items:[{...catalog.items[0],streamPath:'file:///private.mp4'}]}));
 assert.throws(()=>parseCatalog({...catalog,items:[catalog.items[0],catalog.items[0]]}));
});
test('resume restarts completed titles and rejects invalid positions',()=>{
 assert.equal(resumeAt({positionSeconds:12,durationSeconds:60},60),12);
 assert.equal(resumeAt({positionSeconds:59,durationSeconds:60},60),0);
 assert.throws(()=>parseProgress({positionSeconds:-1,durationSeconds:60}));
 assert.throws(()=>parseProgress({positionSeconds:NaN,durationSeconds:60}));
});
test('cached browsing and pending progress survive restart; bad cache recovers',()=>{
 const state={...fresh(),catalog,progress:{[id]:{positionSeconds:12,durationSeconds:60}},pending:{[id]:{positionSeconds:12,durationSeconds:60}}};
 const restored=recover(JSON.stringify(state));assert.equal(restored.catalog?.items.length,1);assert.equal(restored.pending[id].positionSeconds,12);
 assert.deepEqual(recover('broken'),fresh());
});
test('focus page survives detail/back and boundaries clamp',()=>{
 const cursor=move(7,4,20);assert.equal(cursor,11);assert.equal(pageFor(cursor),1);
 assert.equal(move(0,-4,20),0);assert.equal(move(19,1,20),19);assert.equal(move(0,1,0),0);
});
test('server origin requires HTTPS and refuses credentials or unrelated URL parts',()=>{
 assert.equal(serverOrigin('https://localhost:8787/'),'https://localhost:8787');
 for(const value of ['http://localhost:8787','file:///media','https://user:password@localhost','https://localhost/api','https://localhost?x=1'])assert.throws(()=>serverOrigin(value));
});
