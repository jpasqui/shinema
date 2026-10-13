// Synthetic media only. Actual Rust/SQLite API, React navigation and browser
// decoding; desktop integration checks, not TV frame-time measurements.
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,link,rm,readFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '../clients/web/node_modules/playwright/index.mjs';
import {expect} from '../clients/web/node_modules/@playwright/test/index.mjs';
import {createServer} from '../clients/web/node_modules/vite/dist/node/index.js';

const root=resolve('.');const local=join(root,'.local');await mkdir(local,{recursive:true});
const run=await mkdtemp(join(local,'full-library-smoke-'));const media=join(run,'media');const state=join(run,'state');
const origin='http://127.0.0.1:29878';const web='http://127.0.0.1:29873';
const ffmpeg=process.env.FFMPEG??'ffmpeg';
function generate(args){const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n',...args],{stdio:['ignore','ignore','pipe'],windowsHide:true});assert.equal(result.status,0,result.stderr?.toString());}
let server,vite,browser;
const result={methodology:'Fresh full Chromium; original generated full-duration sources; 601 recursive media entries; loopback only.',checks:[],seeks:[]};
async function wait(predicate,seconds=90){const end=Date.now()+seconds*1000;while(Date.now()<end){if(await predicate())return;await new Promise(done=>setTimeout(done,50));}throw new Error('Integration condition timed out');}
try {
  const fixture=join(run,'generated-full-source.mkv');
  generate(['-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','90','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','32','-pix_fmt','yuv420p','-c:a','pcm_s16le',fixture]);
  for(let series=0;series<30;series++){
    const directory=join(media,'tv',`Generated series ${String(series).padStart(2,'0')}`,'Season 1');await mkdir(directory,{recursive:true});
    for(let episode=1;episode<=20;episode++)await link(fixture,join(directory,`Generated S01E${String(episode).padStart(2,'0')}.mkv`));
  }
  const movieDirectory=join(media,'movies','Generated film (2026)');await mkdir(movieDirectory,{recursive:true});
  generate(['-i',fixture,'-c:v','copy','-c:a','aac','-movflags','+faststart',join(movieDirectory,'Generated film.mp4')]);
  const environment={...process.env,SHINEMA_MEDIA_ROOT:media,SHINEMA_STATE_DIR:state,SHINEMA_BIND:'127.0.0.1:29878'};delete environment.SHINEMA_SSH_CONFIG;
  server=spawn(join(root,'target','debug','shinema-server'+(process.platform==='win32'?'.exe':'')),[],{env:environment,stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';server.stderr.on('data',bytes=>error+=bytes);
  await wait(async()=>{if(server.exitCode!==null)throw new Error('Synthetic server startup failed: '+error);try{return(await fetch(origin+'/health')).ok;}catch{return false;}});
  const summary=await(await fetch(origin+'/api/library')).json();assert.deepEqual(summary,{movies:1,series:30,total:601,tv:600});
  const ids=new Set();let offset=0;do {const page=await(await fetch(origin+`/api/catalog?limit=60&offset=${offset}`)).json();for(const item of page.items){assert(!ids.has(item.id));ids.add(item.id);}offset=page.nextOffset;}while(offset!==null);assert.equal(ids.size,601);result.checks.push('Complete recursive index, SQLite totals, all pages without duplicate or missing IDs');
  process.env.VITE_DEMO_MODE='false';process.env.SHINEMA_DEMO_DELAY_MS='0';process.env.SHINEMA_API_ORIGIN=origin;
  vite=await createServer({configFile:join(root,'clients','web','vite.config.ts'),root:join(root,'clients','web'),server:{port:29873,host:'127.0.0.1',strictPort:true}});await vite.listen();
  browser=await chromium.launch({headless:true,channel:'chromium',args:['--mute-audio']});result.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(web);await expect(page.getByRole('heading',{name:'Movies',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'TV shows',exact:true}).click();await page.getByRole('button',{name:'Open Generated series 00',exact:true}).click();await page.getByLabel('Season',{exact:true}).selectOption('1');
  await page.getByRole('button',{name:'Open Generated S01E01',exact:true}).click();await page.getByRole('button',{name:/Play/}).click();
  const video=page.locator('video');await expect.poll(()=>video.evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames),{timeout:90000}).toBeGreaterThan(3);
  const full=await video.evaluate(v=>({duration:v.duration,muted:v.muted,defaultMuted:v.defaultMuted,volume:v.volume}));assert(full.duration>=90&&full.duration<91);assert(full.muted&&full.defaultMuted&&full.volume===0);
  for(const target of [5,45,80]) {const frames=await video.evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames);const start=performance.now();await video.evaluate((v,time)=>{v.currentTime=time;},target);await page.waitForFunction(({target,frames})=>{const v=document.querySelector('video');return v&&!v.seeking&&!v.paused&&v.readyState>=2&&v.currentTime>target+0.2&&v.currentTime<target+10&&v.getVideoPlaybackQuality().totalVideoFrames>frames+3;},{target,frames},{timeout:90000});result.seeks.push({target,elapsedMs:Math.round(performance.now()-start)});}
  await video.evaluate(v=>{v.currentTime=30;});await expect.poll(()=>video.evaluate(v=>v.currentTime),{timeout:90000}).toBeGreaterThan(30.2);await page.getByRole('button',{name:'Pause video'}).click();const saved=await video.evaluate(v=>v.currentTime);
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Library',exact:true}).click();await expect(page.getByRole('button',{name:'Open Generated S01E01',exact:true})).toBeFocused();await page.getByRole('button',{name:'Open Generated S01E01',exact:true}).click();await page.getByRole('button',{name:/Resume/}).click();await page.waitForFunction(saved=>{const v=document.querySelector('video');return v&&!v.paused&&v.readyState>=2&&v.currentTime>=saved&&v.currentTime<saved+10&&v.getVideoPlaybackQuality().totalVideoFrames>3;},saved,{timeout:90000});
  result.checks.push('Decoded full-duration HLS, beginning/middle/end seeks, stable timeline and resume after header exit');
  await page.getByRole('button',{name:'Back to details'}).click();await page.getByRole('button',{name:'Back to library'}).click();await page.getByRole('button',{name:'Movies',exact:true}).click();await page.getByRole('button',{name:'Open Generated film',exact:true}).click();await page.getByRole('button',{name:/Play/}).click();await expect.poll(()=>video.evaluate(v=>v.currentTime),{timeout:90000}).toBeGreaterThan(1);assert((await video.evaluate(v=>v.duration))>=90);
  await page.getByRole('button',{name:'Back to details'}).click();await page.getByRole('button',{name:'Back to library'}).click();
  await context.route('**/api/**',route=>route.abort());await page.reload();await expect(page.getByRole('button',{name:'Open Generated film',exact:true})).toBeVisible();await expect(page.getByText('The server is unavailable. This saved page is still here.',{exact:true})).toBeVisible();result.checks.push('Direct full-duration MP4 and cached browsing after API outage/reload');
  assert.deepEqual(errors,[]);await context.close();
  await wait(async()=>{const health=await(await fetch(origin+'/health')).json();return health.playback.activeCodecJobs===0;});
  const health=await(await fetch(origin+'/health')).json();assert(health.playback.cachedBytes<=health.playback.cacheLimitBytes);result.checks.push('No abandoned codec jobs; compatibility cache remains bounded');
  console.log(JSON.stringify(result,null,2));
} finally {
  if(browser)await browser.close();if(vite)await vite.close();
  if(server&&server.exitCode===null){const stopped=new Promise(done=>server.once('exit',done));server.kill();await stopped;}
  assert(run.startsWith(local+sep));await rm(run,{recursive:true,force:true});
}
