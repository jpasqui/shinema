import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AppState,BackHandler,NativeEventEmitter,NativeModules,Pressable,StyleSheet,Text,TextInput,View,useWindowDimensions} from 'react-native';
import Video,{SelectedTrackType} from 'react-native-video';
import type {VideoRef} from 'react-native-video';
import {resumeAt,serverOrigin} from '../../../packages/contracts/index.ts';
import type {Media,Progress} from '../../../packages/contracts/index.ts';
import {fresh,recover,move,pageFor} from './domain.ts';
import type {Stored} from './domain.ts';
import {SessionGuard,StorageQueue,ProgressQueue,connectValidated,persistThenSync,syncProgress,resolvePlayableResume,backDestination} from './session.ts';
import type {ConnectionStamp} from './session.ts';
import {HttpStatusError,loadLibrarySnapshot,visibleLibraries,navigationContentSupport,nativeMediaContentSupport} from './libraries.ts';
import LibrariesNavigation from './LibrariesNavigation.tsx';
import {Requests} from './Requests.tsx';
import {SubtitleController,SubtitleClock,SUBTITLE_SEEK_RECOVERY_MS,emptySubtitles,subtitleAt} from './subtitles.ts';

const Host=NativeModules.ShinemaHost as {readState:()=>Promise<string>;stageState:(value:string)=>Promise<void>;writeState:(value:string)=>Promise<void>;finish:()=>void;setRequestNavigation:(enabled:boolean)=>void};
type Route='setup'|'library'|'detail'|'player'|'requests';
type Key={code:number;action:number;repeat:number};
const disabledTextTrack={type:SelectedTrackType.DISABLED};
const deviceLanguages=()=>{try{return [Intl.DateTimeFormat().resolvedOptions().locale];}catch{return [];}};

async function request(origin:string,path:string,method='GET',value?:Progress):Promise<unknown>{
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);
  try{
    const response=await fetch(origin+path,{method,signal:controller.signal,headers:value?{'Content-Type':'application/json'}:undefined,body:value?JSON.stringify(value):undefined});
    if(!response.ok)throw new HttpStatusError(response.status);
    return response.status===204?null:await response.json();
  }finally{clearTimeout(timeout);}
}

export default function App(){
  const {width}=useWindowDimensions();const [stored,setStored]=useState<Stored>(fresh());const store=useRef(stored);
  const [route,setRoute]=useState<Route>('setup');const [cursor,setCursor]=useState(0);const [originText,setOriginText]=useState(fresh().origin);
  const [navigationFocus,setNavigationFocus]=useState<number|null>(null);
  const [message,setMessage]=useState('Enter your server address.');const [busy,setBusy]=useState(false);const [paused,setPaused]=useState(false);
  const [clock,setClock]=useState(0);const [duration,setDuration]=useState(0);const [loading,setLoading]=useState(true);
  const [subtitles,setSubtitles]=useState(emptySubtitles);const [subtitleMenu,setSubtitleMenu]=useState(false);const [subtitleCursor,setSubtitleCursor]=useState(0);
  const subtitleController=useRef(new SubtitleController(setSubtitles));
  const [caption,setCaption]=useState('');const subtitleTime=useRef(new SubtitleClock());
  const subtitleRecovery=useRef<ReturnType<typeof setTimeout>|null>(null);
  const video=useRef<VideoRef>(null);const input=useRef<React.ComponentRef<typeof TextInput>>(null);const position=useRef(0);const total=useRef(0);
  const resume=useRef<Progress|null>(null);const waitingSeek=useRef(false);const backHeld=useRef(false);const lastSave=useRef(0);
  const activeItem=useRef<Media|null>(null);
  const activeDestination=useRef<ConnectionStamp|null>(null);
  const session=useRef(new SessionGuard());const handler=useRef<(key:Key)=>void>(()=>{});
  const saveCurrent=useRef<()=>Promise<void>>(async()=>{});const persistQueue=useRef(new StorageQueue());
  const syncQueue=useRef(new ProgressQueue());
  const requestsBack=useRef<()=>void>(()=>{});
  const [requestsFocused,setRequestsFocused]=useState(false);
  const items=stored.catalog?.items??[];const selected=items[cursor];
  const libraries=visibleLibraries(stored.libraries);
  const librarySupport=navigationContentSupport(stored);
  const selectedLibraryDescriptor=stored.libraries?.libraries.find(library=>library.id===stored.selectedLibraryId);
  const playbackItem=route==='player'?activeItem.current:null;
  const playbackOrigin=activeDestination.current?.origin;
  const source=useMemo(()=>({uri:(playbackOrigin??stored.origin)+(playbackItem?.streamPath??'')}),[playbackOrigin,stored.origin,playbackItem?.streamPath]);
  useEffect(()=>{setCaption(subtitleAt(subtitles.cues,subtitleTime.current.current()));},[subtitles.cues]);

  function captionAt(seconds:number,acknowledgedTarget?:number){const current=subtitleTime.current.update(seconds,acknowledgedTarget);setCaption(subtitleAt(subtitleController.current.snapshot().cues,current));}
  function clearSubtitleRecovery(){if(subtitleRecovery.current!==null){clearTimeout(subtitleRecovery.current);subtitleRecovery.current=null;}}
  function hideCaptionForSeek(target:number){clearSubtitleRecovery();const generation=subtitleTime.current.seek(target);setCaption('');subtitleRecovery.current=setTimeout(()=>{const current=subtitleTime.current.recover(generation);setCaption(subtitleAt(subtitleController.current.snapshot().cues,current));},SUBTITLE_SEEK_RECOVERY_MS);}
  function stopCaption(){clearSubtitleRecovery();subtitleTime.current.stop();setCaption('');}
  function openSubtitles(){setSubtitleCursor(0);setSubtitleMenu(value=>!value);}
  function chooseSubtitle(key:string){
    if(key==='retry'){void subtitleController.current.retry();return;}
    setCaption('');
    if(key==='automatic')void subtitleController.current.automatic();
    else if(key==='off')void subtitleController.current.select('');
    else {
      const track=subtitles.tracks.find(track=>`track-${track.id}`===key && track.contentPath);
      if(!track)return;
      void subtitleController.current.select(track.id);
    }
    setSubtitleMenu(false);
  }
  const subtitleChoices=[
    {key:'automatic',label:'Auto: default / device language',active:subtitles.automatic,disabled:false},
    {key:'off',label:'Off',active:!subtitles.automatic && !subtitles.selected,disabled:false},
    ...(subtitles.status==='error' || subtitles.content==='error'?[{key:'retry',label:'Retry subtitles',active:false,disabled:false}]:[]),
    ...subtitles.tracks.map(track=>({key:`track-${track.id}`,label:`${track.label}${track.language?` (${track.language})`:''}${track.unsupportedReason?` — ${track.unsupportedReason}`:''}`,active:track.id===subtitles.selected,disabled:!track.contentPath})),
  ];
  const subtitleStatus=subtitles.status==='loading'?'Loading subtitle tracks…':subtitles.status==='error'?'Subtitles unavailable. Open Subtitles to retry.':subtitles.content==='loading'?'Loading subtitle text…':subtitles.content==='error'?'Subtitle text failed. Open Subtitles to retry or choose Off.':subtitles.selected?`Subtitles: ${subtitles.tracks.find(track=>track.id===subtitles.selected)?.label??'selected'}`:subtitles.tracks.length?'Subtitles: Off':'No subtitle tracks';

  useEffect(()=>{
    Host.setRequestNavigation(route==='requests');
    return()=>Host.setRequestNavigation(false);
  },[route]);

  function update(value:Stored){store.current=value;setStored(value);}
  function acceptCatalog(value:Stored){
    const switched=value.origin!==store.current.origin || value.selectedLibraryId!==store.current.selectedLibraryId;
    update(value);
    setCursor(current=>switched?0:Math.min(current,Math.max(0,(value.catalog?.items.length??0)-1)));
  }
  function openDetails(item=selected){
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    if(!item)return;
    const support=nativeMediaContentSupport(item,store.current);
    if(!support.supported){setMessage(support.reason??'This content is not supported on this device.');return;}
    setNavigationFocus(null);setRequestsFocused(false);
    session.current.cancelConnection();setBusy(false);setRoute('detail');
  }
  function openRequests(){
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    setNavigationFocus(null);setRequestsFocused(true);session.current.cancelConnection();session.current.invalidatePlayback();setBusy(false);setRoute('requests');
  }
  function persist():Promise<void>{
    // Sample when this queue slot executes, so an old snapshot cannot overwrite
    // a newer successfully activated server after a delayed connection write.
    return persistQueue.current.run(()=>Host.writeState(JSON.stringify(store.current)));
  }
  async function syncOne(id:string,value:Progress,destination:ConnectionStamp){
    try{
      await syncProgress(session.current,destination,id,value,{read:()=>store.current,write:update,persist},async(origin,key,progress)=>{await request(origin,`/api/media/${key}/progress`,'PUT',progress);});
    }catch{if(session.current.current(destination,store.current.origin))setMessage('Progress saved on this device; sync will retry.');}
  }
  function flush(id:string,value:Progress,destination:ConnectionStamp):Promise<void>{
    return syncQueue.current.enqueue(()=>syncOne(id,value,destination));
  }
  async function save(item=activeItem.current){
    const destination=activeDestination.current;
    if(!item || activeItem.current?.id!==item.id || !destination || !session.current.current(destination,store.current.origin) || total.current<=0 || waitingSeek.current)return;
    const value={positionSeconds:Math.min(Math.max(0,position.current),total.current),durationSeconds:total.current};
    update({...store.current,progress:{...store.current.progress,[item.id]:value},pending:{...store.current.pending,[item.id]:value}});
    try{await persistThenSync(session.current,destination,persist,()=>store.current.origin,stamp=>flush(item.id,value,stamp));}
    catch{if(session.current.current(destination,store.current.origin))setMessage('Device progress storage failed.');}
  }
  saveCurrent.current=()=>save();

  async function connect(raw:string,selection?:string){
    let origin:string;try{origin=serverOrigin(raw);}catch{setMessage('Enter an HTTPS address without a path or credentials.');return;}
    const attempt=session.current.beginConnection();setBusy(true);setMessage('Loading library...');
    setOriginText(origin);
    try{
      const current=store.current;
      const sameOrigin=origin===current.origin;
      const snapshot=await loadLibrarySnapshot(origin,selection??(sameOrigin?current.selectedLibraryId:null),sameOrigin?current.libraries:null,request);
      const result=await connectValidated(session.current,attempt,origin,async()=>snapshot.catalog,{
        read:()=>store.current,write:acceptCatalog,persist,queue:persistQueue.current,
        stageDisk:value=>Host.stageState(JSON.stringify(value)),
        writeDisk:value=>Host.writeState(JSON.stringify(value)),
      },{libraries:snapshot.libraries,selectedLibraryId:snapshot.selectedLibraryId});
      if(!result)return;
      const {catalog,stamp}=result;
      setRoute('library');setNavigationFocus(null);setRequestsFocused(false);
      setMessage(!navigationContentSupport(snapshot).supported?'':catalog.items.length?'Library ready.':snapshot.libraries && snapshot.selectedLibraryId===null?'No libraries are visible. Update visibility in the server library settings.':'This library is empty.');
      for(const [id,pending] of Object.entries(store.current.pending))if(catalog.items.some(item=>item.id===id))void flush(id,pending,stamp);
    }catch{
      if(!session.current.currentAttempt(attempt))return;
      if(store.current.catalog){setRoute('library');setMessage(origin===store.current.origin?'Browsing cached library. Server is unavailable.':'Could not switch server. Your current library and progress are retained.');}
      else setMessage('Could not connect. Check the address and trusted HTTPS setup.');
    }finally{if(session.current.currentAttempt(attempt))setBusy(false);}
  }

  function chooseLibrary(id:string){
    setRequestsFocused(false);
    if(id===store.current.selectedLibraryId && !busy){session.current.cancelConnection();setNavigationFocus(null);return;}
    void connect(store.current.origin,id);
  }

  async function play(){
    if(!selected || busy)return;
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try Play again in a moment.');return;}
    const item=selected;const ticket=session.current.beginPlayback(store.current.origin);
    setBusy(true);setMessage('Checking resume position...');
    const result=await resolvePlayableResume(session.current,ticket,item,()=>store.current,(origin,id)=>request(origin,`/api/media/${id}/progress`));
    if(!result)return;
    if(!result.supported){setBusy(false);setMessage(result.reason??'This content is not supported on this device.');return;}
    activeItem.current=item;activeDestination.current=ticket;resume.current=result.progress;position.current=0;total.current=0;waitingSeek.current=false;lastSave.current=Date.now();
    clearSubtitleRecovery();subtitleTime.current.reset();setCaption('');setSubtitleMenu(false);setSubtitleCursor(0);
    void subtitleController.current.start(ticket.origin,item.id,deviceLanguages());
    setClock(0);setDuration(0);setPaused(false);setLoading(true);setRoute('player');setBusy(false);setMessage('');
  }

  useEffect(()=>{
    let alive=true;
    void Host.readState().then(raw=>{if(!alive)return;const restored=recover(raw);update(restored);setOriginText(restored.origin);if(restored.catalog)setRoute('library');void connect(restored.origin);});
    const keys=new NativeEventEmitter(NativeModules.ShinemaHost).addListener('ShinemaKey',event=>{
      const key=event as Partial<Key>;
      if(typeof key.code==='number' && typeof key.action==='number' && typeof key.repeat==='number')handler.current({code:key.code,action:key.action,repeat:key.repeat});
    });
    const lifecycle=AppState.addEventListener('change',state=>{if(state!=='active'){setPaused(true);void saveCurrent.current();}});
    // ReactActivity can emit this fallback when an address EditText owns native
    // focus. Keep the route behavior consistent; IME/device behavior is separate.
    const nativeBack=BackHandler.addEventListener('hardwareBackPress',()=>{
      handler.current({code:4,action:0,repeat:0});handler.current({code:4,action:1,repeat:0});return true;
    });
    return()=>{alive=false;keys.remove();lifecycle.remove();nativeBack.remove();clearSubtitleRecovery();subtitleTime.current.stop();subtitleController.current.cancel();session.current.cancelConnection();};
  },[]);

  handler.current=(key:Key)=>{
    const back=key.code===4 || key.code===111;
    if(key.action===1){if(back)backHeld.current=false;return;}
    if(back){
      if(route==='player' && subtitleMenu){if(!backHeld.current){backHeld.current=true;setSubtitleMenu(false);}return;}
      if(backHeld.current)return;backHeld.current=true;session.current.invalidatePlayback();
      if(route==='requests'){requestsBack.current();return;}
      if(route==='setup'){session.current.cancelConnection();setBusy(false);}
      const destination=backDestination(route,Boolean(store.current.catalog));
      if(route==='player'){subtitleController.current.cancel();stopCaption();setPaused(true);void save();activeItem.current=null;activeDestination.current=null;setLoading(false);}
      if(destination==='exit')void persist().catch(()=>{}).then(()=>Host.finish());
      else {setRoute(destination);setBusy(false);}
      return;
    }
    // Request controls use native focus/Pressable handling. Never let their
    // Select/Menu keys fall through to the library, server or player actions.
    if(route==='requests')return;
    if(route==='setup'){
      if(key.code===19)input.current?.focus();
      else if((key.code===23 || key.code===66) && !busy)void connect(originText);
      return;
    }
    if(key.code===82 && route!=='player'){session.current.cancelConnection();setBusy(false);setRoute('setup');setMessage('Edit server address, then connect.');return;}
    if(route==='library'){
      if(navigationFocus!==null){
        if(key.code===21 || key.code===22)setNavigationFocus(current=>move(current??0,key.code===21?-1:1,libraries.length));
        else if(key.code===20){setNavigationFocus(null);setRequestsFocused(true);}
        else if((key.code===23 || key.code===66) && key.repeat===0){const library=libraries[navigationFocus];if(library)chooseLibrary(library.id);}
        return;
      }
      if(requestsFocused){
        if(key.code===19 && libraries.length){setRequestsFocused(false);setNavigationFocus(Math.max(0,libraries.findIndex(library=>library.id===stored.selectedLibraryId)));}
        else if(key.code===20 && librarySupport.supported && items.length)setRequestsFocused(false);
        else if((key.code===23 || key.code===66) && key.repeat===0)openRequests();
        return;
      }
      if(key.code===19 && cursor%8<4){setRequestsFocused(true);return;}
      const direction=({21:-1,22:1,19:-4,20:4} as Record<number,number>)[key.code];
      if(direction!==undefined)setCursor(current=>move(current,direction,items.length));
      else if((key.code===23 || key.code===66) && key.repeat===0 && selected)openDetails();
    }else if(route==='detail'){
      if((key.code===23 || key.code===66) && key.repeat===0)void play();
    }else if(route==='player'){
      if(key.code===82 && key.repeat===0){openSubtitles();return;}
      if(subtitleMenu){
        if([19,20].includes(key.code))setSubtitleCursor(current=>move(current,key.code===19?-1:1,subtitleChoices.length));
        else if([23,66].includes(key.code) && key.repeat===0){const choice=subtitleChoices[Math.min(subtitleCursor,subtitleChoices.length-1)];if(choice && !choice.disabled)chooseSubtitle(choice.key);}
        else if(key.code===85 && key.repeat===0)setPaused(value=>!value);
        return;
      }
      if([23,66,85].includes(key.code) && key.repeat===0)setPaused(value=>!value);
      else if([21,22].includes(key.code) && total.current>0){const target=Math.max(0,Math.min(total.current,position.current+(key.code===21?-10:10)));hideCaptionForSeek(target);video.current?.seek(target);}
    }
  };

  const button=(label:string,action:()=>void)=><Pressable style={styles.button} onPress={action}><Text style={styles.buttonText}>{label}</Text></Pressable>;
  const remembered=selected?stored.progress[selected.id]:undefined;
  return <View style={styles.shell}>
    {route==='player' && playbackItem?<>
      <Video ref={video} style={StyleSheet.absoluteFill} source={source} selectedTextTrack={disabledTextTrack} paused={paused} resizeMode="contain" playInBackground={false} playWhenInactive={false} progressUpdateInterval={subtitles.cues.length?100:1000}
        onLoad={event=>{
          total.current=event.duration;setDuration(event.duration);setLoading(false);
          const target=resumeAt(resume.current,event.duration);waitingSeek.current=target>0;
          if(target>0)hideCaptionForSeek(target);else captionAt(0);
          if(target>0){position.current=target;setClock(target);video.current?.seek(target);}
        }}
        onSeek={event=>{if(!subtitleTime.current.acceptsSeek(event.seekTime))return;waitingSeek.current=false;position.current=event.currentTime;setClock(event.currentTime);captionAt(event.currentTime,event.seekTime);}}
        onProgress={event=>{
          captionAt(event.currentTime);if(waitingSeek.current)return;position.current=event.currentTime;setClock(current=>Math.floor(current)===Math.floor(event.currentTime)?current:event.currentTime);
          if(Date.now()-lastSave.current>=5000){lastSave.current=Date.now();void save(playbackItem);}
        }}
        onBuffer={event=>setLoading(event.isBuffering)}
        onEnd={()=>{stopCaption();position.current=total.current;void save(playbackItem);setPaused(true);setMessage('Finished. Press Back to return.');}}
        onError={()=>{stopCaption();setLoading(false);setPaused(true);setMessage('Playback failed. This slice directly plays device-supported files only. Press Back.');}}
      />
      {caption?<View pointerEvents="none" style={styles.captions}><Text style={styles.captionText} numberOfLines={4}>{caption}</Text></View>:null}
      <View style={styles.overlay}><Text style={styles.title}>{playbackItem.title}</Text><Text style={styles.text}>{loading?'Loading...':paused?'Paused':'Playing'}  {Math.floor(clock)} / {Math.floor(duration)} s</Text><Text style={styles.text}>Select: pause / play   Left / Right: seek   Menu: subtitles   Back: details</Text><Pressable accessibilityRole="button" onPress={openSubtitles}><Text style={styles.notice}>{subtitleStatus}</Text></Pressable>{message?<Text style={styles.notice}>{message}</Text>:null}</View>
      {subtitleMenu?<View style={styles.subtitleMenu}>
        <Text style={styles.title}>Subtitles</Text><Text style={styles.small}>Plain text | Auto uses the default track, then device language.</Text>
        <Text style={styles.notice}>{subtitleStatus}</Text>
        {subtitleChoices.slice(Math.floor(Math.min(subtitleCursor,subtitleChoices.length-1)/5)*5,Math.floor(Math.min(subtitleCursor,subtitleChoices.length-1)/5)*5+5).map(choice=><Pressable key={choice.key} accessibilityRole="button" accessibilityState={{selected:choice.active,disabled:choice.disabled}} disabled={choice.disabled} style={[styles.subtitleChoice,subtitleChoices[Math.min(subtitleCursor,subtitleChoices.length-1)]?.key===choice.key&&styles.focus,choice.disabled&&styles.unsupported]} onPress={()=>chooseSubtitle(choice.key)}><Text style={styles.text} numberOfLines={2}>{choice.active?'✓ ':''}{choice.label}</Text></Pressable>)}
        {subtitles.warnings.length?<Text style={styles.small}>{subtitles.warnings.join(' ')}</Text>:null}
        <Text style={styles.small}>Up / Down: browse | Select: choose | Back: close{subtitleChoices.length>5?` | ${Math.min(subtitleCursor+1,subtitleChoices.length)} / ${subtitleChoices.length}`:''}</Text>
      </View>:null}
    </>:<>
      <Text style={styles.brand}>Shinema</Text>
      {route==='library'?<LibrariesNavigation libraries={libraries} selectedId={stored.selectedLibraryId} focusedIndex={navigationFocus} onSelect={chooseLibrary}/>:null}
      {route==='library'?<View style={styles.toolbar}><Pressable accessibilityRole="button" accessibilityState={{selected:requestsFocused}} style={[styles.button,styles.toolbarButton,requestsFocused&&styles.focus]} onFocus={()=>{setNavigationFocus(null);setRequestsFocused(true);}} onPress={openRequests}><Text style={styles.buttonText}>Requests</Text></Pressable></View>:null}
      {route==='requests'?<Requests key={stored.origin} origin={stored.origin} backHandler={requestsBack} onBack={()=>setRoute('library')} />:route==='setup'?<View key="setup" style={styles.detail}>
        <Text style={styles.title}>Connect your library</Text><Text style={styles.text}>HTTPS server address</Text>
        <TextInput ref={input} style={styles.input} value={originText} onChangeText={setOriginText} autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={()=>{input.current?.blur();void connect(originText);}} returnKeyType="done" />
        {button(busy?'Connecting...':'Connect',()=>{input.current?.blur();if(!busy)void connect(originText);})}
        <Text style={styles.text}>Up: edit address   Select: connect   Back: return</Text>
      </View>:route==='library' && !librarySupport.supported?<View key="unsupported" style={styles.detail}>
        <Text style={styles.title}>{selectedLibraryDescriptor?.name??'Library'}</Text>
        <Text style={styles.text}>Content unavailable on this device</Text>
        <Text style={styles.text}>{librarySupport.reason??'This content type is not supported on this device.'}</Text>
        <Text style={styles.text}>This library stays in your navigation. Choose another library above.</Text>
      </View>:route==='detail' && selected?<View key="detail" style={styles.detail}>
        <Text style={styles.title}>{selected.title}</Text><Text style={styles.text}>{selected.container.toUpperCase()}  /  {Math.round(selected.sizeBytes/1048576)} MiB</Text>
        <Text style={styles.text}>{remembered && remembered.positionSeconds<remembered.durationSeconds-3?`Resume from ${Math.floor(remembered.positionSeconds)} seconds`:'Ready to play'}</Text>
        {button(busy?'Checking resume...':'Play',()=>void play())}<Text style={styles.text}>Select: play   Back: library</Text>
      </View>:<View key="library">
        <View style={styles.grid}>
        {Array.from({length:8},(_,slot)=>{
          const index=pageFor(cursor)*8+slot;const item=items[index];
          return <Pressable key={slot} style={[styles.card,{width:(width-94)/4},cursor===index&&navigationFocus===null&&!requestsFocused&&styles.focus]} onPress={()=>{if(item){setCursor(index);setNavigationFocus(null);openDetails(item);}}}>
            {item?<><View style={[styles.cover,{backgroundColor:`hsl(${parseInt(item.id.slice(0,4),16)%360},35%,25%)`}]}><Text style={styles.initials}>{item.title.slice(0,2).toUpperCase()}</Text></View><Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.small}>{nativeMediaContentSupport(item,stored).supported?item.container.toUpperCase():'Unsupported'}{stored.progress[item.id]?`  ${Math.floor(stored.progress[item.id].positionSeconds)} s`:''}</Text></>:null}
          </Pressable>;
        })}
        </View>
      </View>}
      {route!=='requests'?<Text style={styles.notice}>{message}</Text>:null}
      {route==='library'?<Text style={styles.footer}>{items.length?`${cursor+1} / ${items.length}${stored.catalog?.nextOffset!==null && stored.catalog?.nextOffset!==undefined?` of ${stored.catalog.total}`:''}  `:''}Up from first row: Requests{libraries.length?' / Up again: libraries':''}   Arrows: browse   Select: open   Back: exit   Menu: server</Text>:null}
    </>}
  </View>;
}

const styles=StyleSheet.create({
  shell:{flex:1,backgroundColor:'#101621',padding:28},brand:{color:'#7ce8cb',fontSize:28,fontWeight:'700',marginBottom:14},
  grid:{flexDirection:'row',flexWrap:'wrap',gap:10},card:{height:177,padding:6,borderWidth:3,borderColor:'transparent',backgroundColor:'#1c2739',borderRadius:8},focus:{borderColor:'#7ce8cb'},
  toolbar:{flexDirection:'row',justifyContent:'flex-end',marginBottom:12},
  toolbarButton:{borderWidth:3,borderColor:'transparent'},
  cover:{height:115,alignItems:'center',justifyContent:'center',borderRadius:4},initials:{fontSize:38,color:'#e6f6f2',fontWeight:'600'},cardTitle:{fontSize:17,color:'#fff',marginTop:6},small:{fontSize:12,color:'#b9c9df'},
  detail:{gap:18,paddingTop:20,maxWidth:780},title:{fontSize:30,fontWeight:'600',color:'#fff'},text:{fontSize:18,color:'#c9d5e5'},notice:{color:'#9fe6d8',fontSize:15,marginTop:12},footer:{color:'#afbdd0',fontSize:14,marginTop:10},
  button:{backgroundColor:'#7ce8cb',padding:14,borderRadius:6,alignSelf:'flex-start'},buttonText:{fontSize:20,fontWeight:'600',color:'#101621'},input:{backgroundColor:'#24334b',color:'#fff',fontSize:20,padding:14,borderRadius:6},
  overlay:{position:'absolute',bottom:24,left:28,right:28,padding:18,gap:10,backgroundColor:'#101621dd',borderRadius:8},
  captions:{position:'absolute',bottom:235,left:'8%',right:'8%',alignItems:'center'},captionText:{fontSize:24,color:'#fff',textAlign:'center',backgroundColor:'#000c',paddingHorizontal:12,paddingVertical:5},
  subtitleMenu:{position:'absolute',top:24,right:28,bottom:24,width:'58%',padding:20,gap:10,backgroundColor:'#101621f5',borderWidth:1,borderColor:'#516079',borderRadius:8},subtitleChoice:{padding:10,borderWidth:3,borderColor:'transparent',backgroundColor:'#24334b',borderRadius:6},unsupported:{opacity:0.55},
});
