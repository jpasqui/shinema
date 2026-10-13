import test from 'node:test';
import assert from 'node:assert/strict';
import {browsePath,initialBrowse,recoverPages,rememberPage} from '../src/browse.ts';
import {parseCatalog,parsePlayback,parseSeasons,parseSeriesPage} from '../../../packages/contracts/index.ts';
const id='a'.repeat(64);const media={id,title:'Generated movie',container:'mkv',sizeBytes:10,streamPath:`/api/media/${id}/stream`,collection:'movies'};
const page={apiVersion:1,items:[media],total:1001,offset:0,limit:60,nextOffset:1};
test('all titles are represented by totals while each validated catalog remains bounded',()=>{
  assert.equal(parseCatalog(page).total,1001);
  for(const value of [{...page,nextOffset:0},{...page,nextOffset:1001},{...page,limit:0},{...page,items:[],nextOffset:1}])assert.throws(()=>parseCatalog(value));
  assert.equal(parseCatalog({...page,items:[{...media,container:'avi'}]}).items[0].container,'avi');
  assert.throws(()=>parseCatalog({...page,items:[{...media,seriesId:'private-path'}]}));
});
test('paged browse cache retains twelve validated pages and isolates one corrupt page',()=>{
  let cache={};for(let index=0;index<15;index++)cache=rememberPage(cache,`/api/catalog?offset=${index}&limit=60`,{...page,offset:index,nextOffset:index+1});
  assert.equal(Object.keys(cache).length,12);assert.equal(Object.keys(cache)[0],'/api/catalog?offset=3&limit=60');
  const recovered=recoverPages(JSON.stringify({...cache,'/api/catalog?bad':{apiVersion:1,items:['wrong']}}));assert.equal(Object.keys(recovered).length,11);
});
test('TV series and seasons build opaque paged routes without filesystem paths',()=>{
  const series={id,title:'Generated series',episodes:90,seasons:3};
  assert.equal(parseSeriesPage({items:[series],total:601,offset:0,limit:60,nextOffset:1}).total,601);
  assert.deepEqual(parseSeasons({items:[{season:0,episodes:2},{season:null,episodes:1}]}).items[0],{season:0,episodes:2});
  assert.throws(()=>parseSeasons({items:[{season:1,episodes:2},{season:1,episodes:1}]}));
  const path=browsePath({...initialBrowse(),collection:'tv',series,season:0,search:'spaces & Unicode 星',offset:60});
  const url=new URL(path,'http://127.0.0.1');assert.equal(url.searchParams.get('series'),id);assert.equal(url.searchParams.get('season'),'0');assert.equal(url.searchParams.get('search'),'spaces & Unicode 星');
});
test('playback descriptor covers a full source duration and accepts only its own stream',()=>{
  const playback={durationSeconds:7200.25,mode:'transcode',streamPath:`/api/media/${id}/hls/index.m3u8`};assert.equal(parsePlayback(playback,id).durationSeconds,7200.25);
  assert.throws(()=>parsePlayback({...playback,streamPath:'https://unapproved.example/movie'},id));
});
