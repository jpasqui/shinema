import {useCallback,useEffect,useRef,useState} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent} from 'react';
import {parseCatalog,parseProgress} from '../../../packages/contracts/index.ts';
import type {Media,Progress} from '../../../packages/contracts/index.ts';
import {clock,empty,initializeSilentVideo,NavigationGuard,progressValue,Queue,recover,resumeAt,synchronize} from './model.ts';
import type {Cache} from './model.ts';

const storageKey='shinema.web.cache.v1';
const demo=import.meta.env.VITE_DEMO_MODE==='true';
const descriptions=[
  'A quiet expedition through shape, light and motion. An original generated test clip for the Shinema preview.',
  'Follow the horizon into a new palette. An original generated test clip for the Shinema preview.',
  'An exploration of rhythm and color. An original generated test clip for the Shinema preview.',
];
const artwork=(item:Media)=>demo ? ['Orbit','Horizon','Pulse'].findIndex(name=>item.title.includes(name)) : parseInt(item.id.slice(0,2),16)%3;
const title=(item:Media)=>demo ? item.title.replace(/^Generated /,'') : item.title;
async function json(path:string,init?:RequestInit):Promise<unknown>{
  const response=await fetch(path,{...init,signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error('Server request failed');return response.json();
}
function Poster({item,large=false}:{item:Media;large?:boolean}){
  return <div aria-hidden="true" className={`poster art-${Math.max(0,artwork(item))}${large?' large':''}`}>
    <div className="poster-grain"/><div className="orbital"><i/><i/><i/></div>
    <span className="poster-kicker">{demo?'SHINEMA ORIGINAL FIXTURE':item.container.toUpperCase()}</span>
    <strong>{title(item)}</strong><span className="poster-bottom">{demo?'GENERATED DEMO / 2026':'YOUR LIBRARY'}</span>
  </div>;
}

export default function App(){
  const cache=useRef<Cache>(empty());
  const [version,render]=useState(0);
  const [route,setRoute]=useState<'library'|'detail'|'player'>('library');
  const [selected,setSelected]=useState<Media|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [storageError,setStorageError]=useState(false);
  const [opening,setOpening]=useState(false);
  const [resume,setResume]=useState<Progress|null>(null);
  const [focus,setFocus]=useState(0);
  const cards=useRef<Array<HTMLButtonElement|null>>([]);
  const libraryScroll=useRef(0);
  const back=useRef<HTMLButtonElement|null>(null);
  const guard=useRef(new NavigationGuard());
  const catalogRequest=useRef(0);
  const queue=useRef(new Queue());
  const persist=useCallback(()=>{
    try{localStorage.setItem(storageKey,JSON.stringify(cache.current));setStorageError(false);}catch{setStorageError(true);}
    render(value=>value+1);
  },[]);
  const sync=useCallback((id:string,value:Progress)=>queue.current.run(()=>synchronize(id,value,{
    read:()=>cache.current,write:next=>{cache.current=next;},persist,
    send:async(key,progress)=>{const response=await fetch(`/api/media/${key}/progress`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(progress),signal:AbortSignal.timeout(6000)});if(!response.ok)throw new Error('Progress sync failed');},
  })).catch(()=>{}),[persist]);
  const refresh=useCallback(async()=>{
    const generation=++catalogRequest.current;setLoading(true);setError('');
    try{
      const catalog=parseCatalog(await json('/api/catalog'));
      if(generation!==catalogRequest.current)return;
      cache.current={...cache.current,catalog};persist();
      for(const [id,progress] of Object.entries(cache.current.pending))void sync(id,progress);
    }catch{if(generation===catalogRequest.current)setError(cache.current.catalog?'The server is unavailable. Your saved library is still here.':'The server is unavailable. Start the local demo server and retry.');}
    finally{if(generation===catalogRequest.current)setLoading(false);}
  },[persist,sync]);
  useEffect(()=>{
    try{cache.current=recover(localStorage.getItem(storageKey));}catch{setStorageError(true);}
    render(value=>value+1);void refresh();
    const online=()=>{void refresh();};window.addEventListener('online',online);
    return()=>{catalogRequest.current++;guard.current.next();window.removeEventListener('online',online);};
  },[refresh]);
  const save=useCallback((id:string,position:number,duration:number)=>{
    const value=progressValue(position,duration);if(!value)return;
    cache.current={...cache.current,progress:{...cache.current.progress,[id]:value},pending:{...cache.current.pending,[id]:value}};
    persist();void sync(id,value);
  },[persist,sync]);
  const showDetail=(item:Media,index:number)=>{
    guard.current.next();setOpening(false);libraryScroll.current=window.scrollY;setFocus(index);setSelected(item);setRoute('detail');window.scrollTo(0,0);
  };
  const showLibrary=useCallback(()=>{
    guard.current.next();setOpening(false);setRoute('library');
    requestAnimationFrame(()=>{cards.current[focus]?.focus({preventScroll:true});window.scrollTo(0,libraryScroll.current);});
  },[focus]);
  const play=async()=>{
    if(!selected || opening)return;const item=selected;const ticket=guard.current.next();setOpening(true);
    let value=cache.current.pending[item.id]??cache.current.progress[item.id]??null;
    try{const remote=parseProgress(await json(`/api/media/${item.id}/progress`));value=cache.current.pending[item.id]??remote??value;}
    catch{/* Local progress remains available when the server is disconnected. */}
    if(!guard.current.current(ticket))return;
    setOpening(false);setResume(value);setRoute('player');
  };
  useEffect(()=>{if(route==='detail')back.current?.focus({preventScroll:true});},[route]);
  useEffect(()=>{
    const key=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape' && route==='detail'){event.preventDefault();showLibrary();}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[route,showLibrary]);
  const navigateCard=(event:ReactKeyboardEvent<HTMLButtonElement>,index:number)=>{
    const items=cache.current.catalog?.items??[];let next=index;
    if(event.key==='ArrowRight')next=Math.min(index+1,items.length-1);
    else if(event.key==='ArrowLeft')next=Math.max(index-1,0);
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=items.length-1;
    else if(event.key==='ArrowDown' || event.key==='ArrowUp'){
      const rect=cards.current[index]?.getBoundingClientRect();if(!rect)return;
      const center=rect.x+rect.width/2;const direction=event.key==='ArrowDown'?1:-1;
      const candidates=cards.current.map((node,i)=>({i,rect:node?.getBoundingClientRect()})).filter(value=>value.rect && (value.rect.y-rect.y)*direction>10);
      candidates.sort((a,b)=>Math.abs(a.rect!.y-rect.y)-Math.abs(b.rect!.y-rect.y) || Math.abs(a.rect!.x+a.rect!.width/2-center)-Math.abs(b.rect!.x+b.rect!.width/2-center));
      next=candidates[0]?.i??index;
    }else return;
    event.preventDefault();setFocus(next);cards.current[next]?.focus();
  };
  const items=cache.current.catalog?.items??[];
  const featured=items.find(item=>item.title.includes('Orbit'))??items[0];
  return <div className="app" data-cache-version={version}>
    <header className="header"><button className="brand" onClick={showLibrary} aria-label="Shinema library"><span className="brand-mark">S</span>shinema<span className="brand-dot">.</span></button>
      <nav aria-label="Main navigation"><button className={route==='library'?'nav-link active':'nav-link'} onClick={showLibrary}>Library</button><span className="nav-disabled">Your cinema, everywhere</span></nav>
      <span className="demo-badge">{demo?'GENERATED DEMO':'LOCAL PREVIEW'}</span></header>
    {storageError && <div className="notice" role="alert">Browser storage is unavailable. Resume changes will last for this session only.</div>}
    {route==='player' && selected ? <Player item={selected} progress={resume} save={save} back={()=>{guard.current.next();setRoute('detail');}}/> :
    route==='detail' && selected ? <main className="detail"><button ref={back} className="back-button" onClick={showLibrary}>&larr; Back to library</button>
      <div className="detail-layout"><Poster item={selected} large/><section className="detail-copy"><p className="eyebrow">{demo?'GENERATED DEMO FIXTURE':'FROM YOUR LIBRARY'}</p><h1>{title(selected)}</h1>
        <div className="metadata"><span>{selected.container.toUpperCase()}</span><span>{demo?'1 minute':`${(selected.sizeBytes/1048576).toFixed(1)} MB`}</span><span>Direct playback</span></div>
        <p className="description">{demo?descriptions[Math.max(0,artwork(selected))]:'Play this item directly from your connected server. Your position is saved locally and synchronized when the server is available.'}</p>
        <button className="primary" onClick={()=>{void play();}} disabled={opening}>{opening?'Preparing playback...':(cache.current.progress[selected.id]?.positionSeconds??0)>0?'\u25b6 Resume':'\u25b6 Play'}</button>
        <p className="quiet">Silent preview. Audio stays muted from initialization.</p><div className="detail-note"><span className="small-label">READY WHEN YOU ARE</span><p>Pick up where you left off.<br/>Your place stays with you.</p></div>
      </section></div></main> : <main>
      <section className="hero"><div className="hero-art" aria-hidden="true"><div className="planet"/><div className="hero-ring"/><span className="star star-one"/><span className="star star-two"/></div>
        <div className="hero-copy"><p className="eyebrow">A LITTLE SPACE FOR YOUR STORIES</p><h1>Your next<br/>great escape.</h1><p>A familiar library. A fresh perspective.<br/>Everything you love, ready to play.</p>
          {featured && <button className="primary" onClick={()=>showDetail(featured,items.indexOf(featured))}>&#9654; Explore {title(featured)}</button>}
          <span className="hero-caption">{demo?'Original artwork / generated test media':'Browse from your local cache'}</span></div>
        <div className="hero-number" aria-hidden="true">01 <span>/ SHINEMA</span></div></section>
      <section className="library-section"><div className="section-heading"><div><p className="eyebrow">MAKE YOURSELF AT HOME</p><h2>Your library</h2></div><div className="connection"><span className={error?'status-dot offline':'status-dot'}/>{loading?'Connecting...':error?'Cached browsing':`${items.length} titles`}<button className="text-button" onClick={()=>{void refresh();}} disabled={loading}>{loading?'Refreshing...':'Refresh'}</button></div></div>
        {error && <div className="notice" role="status">{error} <button className="text-button" onClick={()=>{void refresh();}}>Retry connection</button></div>}
        {loading && !items.length ? <div className="poster-grid" aria-label="Loading library" aria-busy="true">{[0,1,2].map(i=><div key={i} className="skeleton"/>)}</div> : items.length ? <div className="poster-grid">{items.map((item,index)=>{
          const progress=cache.current.progress[item.id];return <button key={item.id} ref={node=>{cards.current[index]=node;}} className="media-card" tabIndex={index===focus?0:-1} onFocus={()=>setFocus(index)} onKeyDown={event=>navigateCard(event,index)} onClick={()=>showDetail(item,index)} aria-label={`Open ${title(item)}`}>
            <Poster item={item}/><div className="card-copy"><h3>{title(item)}</h3><span>{demo?'Generated clip':item.container.toUpperCase()} <i/> {progress?`Resume at ${clock(progress.positionSeconds)}`:demo?'1 min':'Direct play'}</span></div>
            {progress && <div className="watch-progress" aria-label={`${Math.round(progress.positionSeconds/progress.durationSeconds*100)} percent watched`}><div style={{width:`${progress.positionSeconds/progress.durationSeconds*100}%`}}/></div>}
          </button>;})}</div> : <div className="empty-state"><h3>{error?'Waiting for your server':'A new beginning'}</h3><p>{error?'Connect the local Rust server and retry.':'Add supported media to the server fixture directory, then refresh your library.'}</p></div>}
      </section><footer><span>SHINEMA / YOUR OWN LITTLE CINEMA</span><span>{demo?'Demo fixtures only. No private library data.':'Local browser preview'}</span></footer>
    </main>}
  </div>;
}

function Player({item,progress,save,back}:{item:Media;progress:Progress|null;save:(id:string,position:number,duration:number)=>void;back:()=>void}){
  const video=useRef<HTMLVideoElement|null>(null);
  const container=useRef<HTMLElement|null>(null);
  const [paused,setPaused]=useState(true);const [position,setPosition]=useState(0);const [duration,setDuration]=useState(0);const [error,setError]=useState('');const [ready,setReady]=useState(false);
  const lastSave=useRef(0);const started=useRef(false);
  const snapshot=useCallback(()=>{const node=video.current;if(node)save(item.id,node.currentTime,node.duration);},[item.id,save]);
  useEffect(()=>{
    const node=video.current;if(!node)return;
    initializeSilentVideo(node,item.streamPath);container.current?.focus();
    const hide=()=>snapshot();document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',hide);
    return()=>{snapshot();node.pause();node.removeAttribute('src');node.load();document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',hide);};
  },[item.streamPath,snapshot]);
  const toggle=()=>{const node=video.current;if(!node)return;if(node.paused)void node.play().catch(()=>setError('Playback could not start. Check the connection or media format.'));else node.pause();};
  const seek=(value:number)=>{const node=video.current;if(node && Number.isFinite(node.duration))node.currentTime=Math.max(0,Math.min(value,node.duration));};
  const key=(event:ReactKeyboardEvent<HTMLElement>)=>{
    if(event.key==='Escape'){event.preventDefault();snapshot();back();}
    else if(event.target instanceof HTMLInputElement)return;
    else if(event.key==='ArrowRight' || event.key==='ArrowLeft'){event.preventDefault();seek((video.current?.currentTime??0)+(event.key==='ArrowRight'?10:-10));}
    else if(event.key===' ' && !(event.target instanceof HTMLButtonElement)){event.preventDefault();toggle();}
  };
  return <main className="player-page" ref={container} tabIndex={-1} onKeyDown={key} aria-label="Video player">
    <div className="player-heading"><button className="back-button" onClick={()=>{snapshot();back();}}>&larr; Back to details</button><span className="demo-badge">SILENT PREVIEW</span></div>
    <div className="video-stage"><video ref={video} playsInline muted preload="metadata" aria-label={`Playing ${title(item)}`}
      onLoadedMetadata={()=>{const node=video.current!;setDuration(node.duration);node.currentTime=resumeAt(progress,node.duration);setPosition(node.currentTime);}}
      onCanPlay={()=>{setReady(true);if(!started.current){started.current=true;void video.current?.play().catch(()=>setError('Press Play to start playback.'));}}}
      onPlay={()=>{setPaused(false);setError('');}} onPause={()=>{setPaused(true);snapshot();}} onSeeked={()=>{setPosition(video.current?.currentTime??0);snapshot();}} onEnded={snapshot}
      onTimeUpdate={()=>{const node=video.current!;setPosition(node.currentTime);if(Math.abs(node.currentTime-lastSave.current)>=5){lastSave.current=node.currentTime;snapshot();}}}
      onError={()=>setError('This item could not play. Check your server connection and browser codec support.')}/>
      {!ready && !error && <div className="video-message" role="status">Loading your escape...</div>}
      {error && <div className="video-message" role="alert">{error}</div>}
    </div>
    <div className="player-controls"><button className="primary" onClick={toggle} aria-label={paused?'Play video':'Pause video'}>{paused?'\u25b6 Play':'\u2161 Pause'}</button><button className="control-button" onClick={()=>seek(position-10)} aria-label="Back ten seconds">-10s</button><button className="control-button" onClick={()=>seek(position+10)} aria-label="Forward ten seconds">+10s</button><input aria-label="Playback position" type="range" min="0" max={duration||1} step="0.1" value={position} onChange={event=>seek(Number(event.target.value))}/><span className="time">{clock(position)} / {clock(duration)}</span><span className="muted-label">Audio muted</span></div>
    <div className="now-playing"><p className="eyebrow">NOW PLAYING / {demo?'GENERATED DEMO':'DIRECT STREAM'}</p><h1>{title(item)}</h1><p className="quiet">Space to pause. Arrow keys to seek. Escape to return.</p></div>
  </main>;
}
