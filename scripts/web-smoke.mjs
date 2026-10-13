// Runs only original generated media, on host loopback, in a fresh Chromium context.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm,access,lstat} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {chromium} from '../clients/web/node_modules/playwright/index.mjs';
import {expect} from '../clients/web/node_modules/@playwright/test/index.mjs';
import {createServer} from '../clients/web/node_modules/vite/dist/node/index.js';

const root=resolve('.');const local=join(root,'.local');await mkdir(local,{recursive:true});
const run=await mkdtemp(join(local,'web-smoke-'));const screenshots=join(local,'web-screenshots');await mkdir(screenshots,{recursive:true});
for(const name of ['Orbit','Horizon','Pulse'])await access(join(local,'media',`Generated_${name}.mp4`));
process.env.VITE_DEMO_MODE='true';process.env.SHINEMA_DEMO_DELAY_MS='700';process.env.SHINEMA_API_ORIGIN='http://127.0.0.1:28887';
const processServer=spawn(join(root,'target','debug','shinema-server'+(process.platform==='win32'?'.exe':'')),[],{
  env:{...process.env,SHINEMA_MEDIA_ROOT:join(local,'media'),SHINEMA_STATE_DIR:join(run,'state'),SHINEMA_BIND:'127.0.0.1:28887'},stdio:['ignore','ignore','pipe'],
});
let serverError='';processServer.stderr.on('data',data=>{serverError+=data;});
let vite,browser;const results={methodology:'Official Chromium in a fresh isolated context; actual Rust API and generated H.264/AAC media on loopback. 700ms deliberate catalog delay exercises loading, not a speed measurement.',checks:[],screenshots:[]};
async function waitForServer(){
 for(let n=0;n<60;n++){
  if(processServer.exitCode!==null)throw new Error('Test server exited during startup: '+serverError);
  if(serverError.includes('Shinema listening on loopback')){try{if((await fetch('http://127.0.0.1:28887/health',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}}
  await new Promise(resolve=>setTimeout(resolve,100));
 }throw new Error('Test server startup timed out');
}
async function stopServer(){if(processServer.exitCode!==null || processServer.signalCode!==null)return;const stopped=new Promise(resolve=>processServer.once('exit',resolve));processServer.kill();await stopped;}
async function screenshot(page,name){await page.screenshot({path:join(screenshots,name+'.png'),fullPage:true,animations:'disabled'});results.screenshots.push(name+'.png');}
try{
 await waitForServer();const fixtureCatalog=await(await fetch('http://127.0.0.1:28887/api/catalog')).json();assert.deepEqual(fixtureCatalog.items.map(item=>item.title).sort(),['Generated Horizon','Generated Orbit','Generated Pulse']);vite=await createServer({configFile:join(root,'clients','web','vite.config.ts'),root:join(root,'clients','web'),server:{port:28883,host:'127.0.0.1',strictPort:true}});await vite.listen();
 browser=await chromium.launch({headless:true,channel:'chromium',args:['--mute-audio']});results.browser=browser.version();
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin==='http://127.0.0.1:28883'?route.continue():route.abort();});
 await context.addInitScript(()=>{
  window.__mediaEvents=[];
  for(const type of ['loadstart','loadedmetadata','play','volumechange'])document.addEventListener(type,event=>{
   if(event.target instanceof HTMLVideoElement){const node=event.target;window.__mediaEvents.push({type,hasSource:!!node.getAttribute('src'),muted:node.muted,defaultMuted:node.defaultMuted,volume:node.volume});}
  },true);
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const start=performance.now();await page.goto('http://127.0.0.1:28883');
 await expect(page.getByLabel('Loading library')).toBeVisible();await screenshot(page,'loading');
 await expect(page.getByRole('button',{name:'Open Orbit',exact:true})).toBeVisible();results.catalogToVisibleMs=Math.round(performance.now()-start);
 results.checks.push('Actual catalog, deliberate loading state and library render');await screenshot(page,'library-desktop');
 const longTitles=['Orbit'+'x'.repeat(195),('Orbit '+('long spaced catalog title '.repeat(9))).slice(0,200)];
 const titleContext=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});let testTitle=longTitles[0];
 const titleItem=fixtureCatalog.items.find(item=>item.title==='Generated Orbit');
 await titleContext.route('**/api/catalog',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({apiVersion:1,items:[{...titleItem,title:testTitle}]})}));
 const titlePage=await titleContext.newPage();results.longTitleChecks=[];
 for(const width of [1280,390])for(const value of longTitles){
  testTitle=value;await titlePage.setViewportSize({width,height:900});await titlePage.goto('http://127.0.0.1:28883');await expect(titlePage.locator('.feature h2')).toHaveText(value);await expect(titlePage.getByRole('button',{name:'View details',exact:false})).toBeVisible();
  const geometry=await titlePage.locator('.feature').evaluate(node=>{const heading=node.querySelector('h2');const copy=node.querySelector('.feature-copy');const button=node.querySelector('button');const frame=node.getBoundingClientRect();const text=heading.getBoundingClientRect();const controls=copy.getBoundingClientRect();const action=button.getBoundingClientRect();return {frameTop:frame.top,frameBottom:frame.bottom,copyTop:controls.top,copyBottom:controls.bottom,titleWidth:heading.clientWidth,titleScrollWidth:heading.scrollWidth,titleHeight:heading.clientHeight,lineHeight:parseFloat(getComputedStyle(heading).lineHeight),actionBottom:action.bottom,textLeft:text.left,textRight:text.right,frameLeft:frame.left,frameRight:frame.right};});
  results.longTitleChecks.push({width,kind:value.includes(' ')?'spaced':'unbroken',...geometry});
  await writeFile(join(local,'redesign-long-title-evidence.json'),JSON.stringify(results.longTitleChecks,null,2),'utf8');
  await screenshot(titlePage,'long-title-'+width+'-'+(value.includes(' ')?'spaced':'unbroken'));
  assert(await titlePage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await titlePage.getByRole('button',{name:'View details',exact:false}).click();await expect(titlePage.getByRole('heading',{level:1,name:value,exact:true})).toBeVisible();
  assert(await titlePage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 }
 await titleContext.close();
 assert(results.longTitleChecks.every(value=>value.titleScrollWidth<=value.titleWidth+1),'Featured title must not overflow horizontally');
 assert(results.longTitleChecks.every(value=>value.copyTop>=value.frameTop && value.copyBottom<=value.frameBottom),'Featured text and controls must stay inside the banner');
 assert(results.longTitleChecks.every(value=>value.titleHeight<=value.lineHeight*2+1),'Featured title must be bounded to two lines');
 results.checks.push('200-character unbroken/spaced catalog titles stay bounded in the featured banner at 1280px/390px; full title remains available in details without horizontal overflow');
 const orbit=page.getByRole('button',{name:'Open Orbit',exact:true});await orbit.focus();await orbit.press('ArrowRight');await expect(page.getByRole('button',{name:'Open Pulse',exact:true})).toBeFocused();
 await page.keyboard.press('ArrowLeft');await expect(orbit).toBeFocused();const scroll=await page.evaluate(()=>window.scrollY);
 await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Orbit',exact:true})).toBeVisible();await screenshot(page,'detail-desktop');
 await page.keyboard.press('Escape');await expect(orbit).toBeFocused();assert.equal(await page.evaluate(()=>window.scrollY),scroll);
 results.checks.push('Keyboard arrows/Enter/Escape, restored library focus and scroll');
 await orbit.click();await page.getByRole('button',{name:'Play',exact:false}).click();
 const video=page.locator('video');await expect(video).toHaveJSProperty('paused',false);await expect.poll(()=>video.evaluate(node=>node.currentTime)).toBeGreaterThan(2);
 const initial=await video.evaluate(node=>({muted:node.muted,defaultMuted:node.defaultMuted,volume:node.volume,currentTime:node.currentTime,duration:node.duration,videoWidth:node.videoWidth,videoHeight:node.videoHeight}));
 assert(initial.muted && initial.defaultMuted && initial.volume===0 && initial.videoWidth===1280 && initial.videoHeight===720);results.initialPlayback=initial;
 const exitAt=await video.evaluate(node=>node.currentTime);await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Library',exact:true}).click();
 const exitItem=fixtureCatalog.items.find(item=>item.title==='Generated Orbit');
 await expect.poll(async()=>{const progress=await(await fetch(`http://127.0.0.1:28887/api/media/${exitItem.id}/progress`)).json();return progress?.positionSeconds??0;}).toBeGreaterThan(exitAt-.5);
 const localExit=await page.evaluate(id=>JSON.parse(localStorage.getItem('shinema.web.cache.v1')).progress[id].positionSeconds,exitItem.id);assert(localExit>exitAt-.5);
 const serverExit=await(await fetch(`http://127.0.0.1:28887/api/media/${exitItem.id}/progress`)).json();results.headerExitProgress={exitAt,localPosition:localExit,serverPosition:serverExit.positionSeconds};
 await orbit.click();await page.getByRole('button',{name:'Resume',exact:false}).click();await expect.poll(()=>page.locator('video').evaluate(node=>node.currentTime)).toBeGreaterThan(exitAt-.5);
 results.checks.push('Header Library navigation during unpaused playback saves final local/server progress and reopens at that position');
 await page.getByRole('button',{name:'Pause video',exact:true}).click();await expect(video).toHaveJSProperty('paused',true);
 const paused=await video.evaluate(node=>node.currentTime);await page.waitForTimeout(300);assert(Math.abs((await video.evaluate(node=>node.currentTime))-paused)<.05);
 await page.getByRole('button',{name:'Forward ten seconds'}).click();await expect.poll(()=>video.evaluate(node=>node.currentTime)).toBeGreaterThan(paused+9.5);
 const seeked=await video.evaluate(node=>node.currentTime);await expect(video).toHaveJSProperty('seeking',false);await expect.poll(()=>page.getByLabel('Playback position').inputValue().then(Number)).toBeGreaterThan(seeked-.5);await expect(page.getByRole('alert')).toHaveCount(0);await screenshot(page,'player-desktop');
 const catalog=await (await fetch('http://127.0.0.1:28887/api/catalog')).json();const item=catalog.items.find(item=>item.title==='Generated Orbit');
 await expect.poll(async()=>{const progress=await(await fetch(`http://127.0.0.1:28887/api/media/${item.id}/progress`)).json();return progress?.positionSeconds??0;}).toBeGreaterThan(seeked-.5);
 await page.getByRole('button',{name:'Back to details',exact:false}).click();await page.getByRole('button',{name:'Resume',exact:false}).click();
 await expect(page.locator('video')).toHaveJSProperty('paused',false);await expect.poll(()=>page.locator('video').evaluate(node=>node.currentTime)).toBeGreaterThan(seeked-.5);
 await page.getByRole('button',{name:'Pause video',exact:true}).click();const resumed=await page.locator('video').evaluate(node=>node.currentTime);results.pauseSeekResume={paused,seeked,resumed};
 await page.getByRole('button',{name:'Back to details',exact:false}).click();await page.getByRole('button',{name:'Back to library',exact:false}).click();
 await page.reload();await expect(orbit).toBeVisible();await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();await orbit.click();await page.getByRole('button',{name:'Resume',exact:false}).click();
 await expect.poll(()=>page.locator('video').evaluate(node=>node.currentTime)).toBeGreaterThan(resumed-.5);await page.getByRole('button',{name:'Pause video',exact:true}).click();
 await page.getByRole('button',{name:'Back to details',exact:false}).click();await page.getByRole('button',{name:'Back to library',exact:false}).click();
 const events=await page.evaluate(()=>window.__mediaEvents);await writeFile(join(local,'web-media-events.json'),JSON.stringify(events,null,2),'utf8');assert(events.some(event=>event.type==='play'));assert(events.every(event=>event.muted && (!event.hasSource || (event.defaultMuted && event.volume===0))));results.muteEvents=events;
 results.checks.push('Actual 1280x720 video decode, advancing playback, pause, seek, server progress PUT, resume and browser reload persistence; every observed media event muted, source-loaded/play events at volume zero');
 await page.setViewportSize({width:390,height:844});await orbit.focus();await orbit.press('ArrowDown');await expect(page.getByRole('button',{name:'Open Pulse',exact:true})).toBeFocused();await page.keyboard.press('ArrowUp');await expect(page.getByRole('button',{name:'Open Horizon',exact:true})).toBeFocused();await screenshot(page,'library-mobile');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await orbit.click();await screenshot(page,'detail-mobile');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.getByRole('button',{name:'Resume',exact:false}).click();await expect(page.locator('video')).toHaveJSProperty('paused',false);await page.getByRole('button',{name:'Pause video',exact:true}).click();
 await page.getByRole('button',{name:'Forward ten seconds'}).click();await expect(page.locator('video')).toHaveJSProperty('seeking',false);await expect(page.getByRole('alert')).toHaveCount(0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await screenshot(page,'player-mobile');
 await page.getByRole('button',{name:'Back to details',exact:false}).click();await page.getByRole('button',{name:'Back to library',exact:false}).click();
 results.checks.push('390px responsive library/details/player render without horizontal overflow, phone-sized playback/pause/seek work, vertical keyboard navigation follows the responsive grid');
 await page.setViewportSize({width:1280,height:900});
 // Vite must not expose repository state or private development files.
 const gitFile=(await lstat(join(root,'.git'))).isFile()?join(root,'.git'):join(root,'.git','config');
 for(const path of ['/@fs/'+gitFile.replaceAll('\\','/'),'/@fs/'+join(root,'.local','media','Generated_Orbit.mp4').replaceAll('\\','/')])assert((await page.request.get('http://127.0.0.1:28883'+path)).status()>=400);
 results.checks.push('Development file serving denies .git and .local');
 await stopServer();await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('The server is unavailable.',{exact:false})).toBeVisible();await expect(orbit).toBeVisible();await screenshot(page,'cached-disconnected');
 await orbit.click();await page.getByRole('button',{name:'Resume',exact:false}).click();await expect(page.getByRole('alert')).toContainText('could not play');await screenshot(page,'playback-connection-error');
 results.checks.push('Actual server shutdown: cached library still browsable and playback connection error displayed');
 const fresh=await browser.newContext({viewport:{width:1280,height:900}});const emptyPage=await fresh.newPage();await emptyPage.goto('http://127.0.0.1:28883');await expect(emptyPage.getByRole('heading',{name:'Waiting for your server'})).toBeVisible();await screenshot(emptyPage,'uncached-disconnected');await fresh.close();
 assert.deepEqual(errors,[]);results.checks.push('Fresh profile failed connection state; no browser JavaScript errors');
 results.status='passed';
}finally{
 await browser?.close();await vite?.close();await stopServer();
 assert(run.startsWith(local+sep) && run.split(sep).at(-1).startsWith('web-smoke-'));await rm(run,{recursive:true,force:true});
}
results.cleanup='Temporary Chromium context, Vite server, Rust server and test state closed/removed.';
await writeFile(join(local,'web-smoke-results.json'),JSON.stringify(results,null,2),'utf8');console.log(JSON.stringify(results,null,2));
