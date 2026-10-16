import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AppState,BackHandler,NativeEventEmitter,NativeModules,Pressable,StyleSheet,Text,TextInput,View,useWindowDimensions} from 'react-native';
import Video from 'react-native-video';
import type {VideoRef} from 'react-native-video';
import {resumeAt,serverOrigin} from '../../../packages/contracts/index.ts';
import type {Media,Progress} from '../../../packages/contracts/index.ts';
import {fresh,recover,move,pageFor} from './domain.ts';
import type {Stored} from './domain.ts';
import {SessionGuard,StorageQueue,ProgressQueue,connectValidated,persistThenSync,syncProgress,resolveResume,backDestination} from './session.ts';
import type {ConnectionStamp} from './session.ts';
import {HttpStatusError,loadLibrarySnapshot,visibleLibraries} from './libraries.ts';
import LibrariesNavigation from './LibrariesNavigation.tsx';

const Host=NativeModules.ShinemaHost as {readState:()=>Promise<string>;stageState:(value:string)=>Promise<void>;writeState:(value:string)=>Promise<void>;finish:()=>void};
type Route='setup'|'library'|'detail'|'player';
type Key={code:number;action:number;repeat:number};

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
  const video=useRef<VideoRef>(null);const input=useRef<React.ComponentRef<typeof TextInput>>(null);const position=useRef(0);const total=useRef(0);
  const resume=useRef<Progress|null>(null);const waitingSeek=useRef(false);const backHeld=useRef(false);const lastSave=useRef(0);
  const activeItem=useRef<Media|null>(null);
  const activeDestination=useRef<ConnectionStamp|null>(null);
  const session=useRef(new SessionGuard());const handler=useRef<(key:Key)=>void>(()=>{});
  const saveCurrent=useRef<()=>Promise<void>>(async()=>{});const persistQueue=useRef(new StorageQueue());
  const syncQueue=useRef(new ProgressQueue());
  const items=stored.catalog?.items??[];const selected=items[cursor];
  const libraries=visibleLibraries(stored.libraries);
  const playbackItem=route==='player'?activeItem.current:null;
  const playbackOrigin=activeDestination.current?.origin;
  const source=useMemo(()=>({uri:(playbackOrigin??stored.origin)+(playbackItem?.streamPath??'')}),[playbackOrigin,stored.origin,playbackItem?.streamPath]);

  function update(value:Stored){store.current=value;setStored(value);}
  function acceptCatalog(value:Stored){
    const switched=value.origin!==store.current.origin || value.selectedLibraryId!==store.current.selectedLibraryId;
    update(value);
    setCursor(current=>switched?0:Math.min(current,Math.max(0,(value.catalog?.items.length??0)-1)));
  }
  function openDetails(){
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    session.current.cancelConnection();setBusy(false);setRoute('detail');
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
      setRoute('library');setNavigationFocus(null);
      setMessage(catalog.items.length?'Library ready.':snapshot.libraries && snapshot.selectedLibraryId===null?'No libraries are visible. Update visibility in the server library settings.':'This library is empty.');
      for(const [id,pending] of Object.entries(store.current.pending))if(catalog.items.some(item=>item.id===id))void flush(id,pending,stamp);
    }catch{
      if(!session.current.currentAttempt(attempt))return;
      if(store.current.catalog){setRoute('library');setMessage(origin===store.current.origin?'Browsing cached library. Server is unavailable.':'Could not switch server. Your current library and progress are retained.');}
      else setMessage('Could not connect. Check the address and trusted HTTPS setup.');
    }finally{if(session.current.currentAttempt(attempt))setBusy(false);}
  }

  function chooseLibrary(id:string){
    if(id===store.current.selectedLibraryId && !busy){session.current.cancelConnection();setNavigationFocus(null);return;}
    void connect(store.current.origin,id);
  }

  async function play(){
    if(!selected || busy)return;
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try Play again in a moment.');return;}
    const item=selected;const ticket=session.current.beginPlayback(store.current.origin);
    setBusy(true);setMessage('Checking resume position...');
    const result=await resolveResume(session.current,ticket,item.id,()=>store.current,(origin,id)=>request(origin,`/api/media/${id}/progress`));
    if(!result)return;
    activeItem.current=item;activeDestination.current=ticket;resume.current=result.progress;position.current=0;total.current=0;waitingSeek.current=false;lastSave.current=Date.now();
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
    return()=>{alive=false;keys.remove();lifecycle.remove();nativeBack.remove();session.current.cancelConnection();};
  },[]);

  handler.current=(key:Key)=>{
    const back=key.code===4 || key.code===111;
    if(key.action===1){if(back)backHeld.current=false;return;}
    if(back){
      if(backHeld.current)return;backHeld.current=true;session.current.invalidatePlayback();
      if(route==='setup'){session.current.cancelConnection();setBusy(false);}
      const destination=backDestination(route,Boolean(store.current.catalog));
      if(route==='player'){setPaused(true);void save();activeItem.current=null;activeDestination.current=null;setLoading(false);}
      if(destination==='exit')void persist().catch(()=>{}).then(()=>Host.finish());
      else {setRoute(destination);setBusy(false);}
      return;
    }
    if(route==='setup'){
      if(key.code===19)input.current?.focus();
      else if((key.code===23 || key.code===66) && !busy)void connect(originText);
      return;
    }
    if(key.code===82 && route!=='player'){session.current.cancelConnection();setBusy(false);setRoute('setup');setMessage('Edit server address, then connect.');return;}
    if(route==='library'){
      if(navigationFocus!==null){
        if(key.code===21 || key.code===22)setNavigationFocus(current=>move(current??0,key.code===21?-1:1,libraries.length));
        else if(key.code===20)setNavigationFocus(null);
        else if((key.code===23 || key.code===66) && key.repeat===0){const library=libraries[navigationFocus];if(library)chooseLibrary(library.id);}
        return;
      }
      if(key.code===19 && cursor<4 && libraries.length){setNavigationFocus(Math.max(0,libraries.findIndex(library=>library.id===stored.selectedLibraryId)));return;}
      const direction=({21:-1,22:1,19:-4,20:4} as Record<number,number>)[key.code];
      if(direction!==undefined)setCursor(current=>move(current,direction,items.length));
      else if((key.code===23 || key.code===66) && key.repeat===0 && selected)openDetails();
    }else if(route==='detail'){
      if((key.code===23 || key.code===66) && key.repeat===0)void play();
    }else if(route==='player'){
      if([23,66,85].includes(key.code) && key.repeat===0)setPaused(value=>!value);
      else if([21,22].includes(key.code) && total.current>0)video.current?.seek(Math.max(0,Math.min(total.current,position.current+(key.code===21?-10:10))));
    }
  };

  const button=(label:string,action:()=>void)=><Pressable style={styles.button} onPress={action}><Text style={styles.buttonText}>{label}</Text></Pressable>;
  const remembered=selected?stored.progress[selected.id]:undefined;
  return <View style={styles.shell}>
    {route==='player' && playbackItem?<>
      <Video ref={video} style={StyleSheet.absoluteFill} source={source} paused={paused} resizeMode="contain" playInBackground={false} playWhenInactive={false} progressUpdateInterval={1000}
        onLoad={event=>{
          total.current=event.duration;setDuration(event.duration);setLoading(false);
          const target=resumeAt(resume.current,event.duration);waitingSeek.current=target>0;
          if(target>0){position.current=target;setClock(target);video.current?.seek(target);}
        }}
        onSeek={event=>{waitingSeek.current=false;position.current=event.currentTime;setClock(event.currentTime);}}
        onProgress={event=>{
          if(waitingSeek.current)return;position.current=event.currentTime;setClock(event.currentTime);
          if(Date.now()-lastSave.current>=5000){lastSave.current=Date.now();void save(playbackItem);}
        }}
        onBuffer={event=>setLoading(event.isBuffering)}
        onEnd={()=>{position.current=total.current;void save(playbackItem);setPaused(true);setMessage('Finished. Press Back to return.');}}
        onError={()=>{setLoading(false);setPaused(true);setMessage('Playback failed. This slice directly plays device-supported files only. Press Back.');}}
      />
      <View style={styles.overlay}><Text style={styles.title}>{playbackItem.title}</Text><Text style={styles.text}>{loading?'Loading...':paused?'Paused':'Playing'}  {Math.floor(clock)} / {Math.floor(duration)} s</Text><Text style={styles.text}>Select: pause / play   Left / Right: seek   Back: details</Text>{message?<Text style={styles.notice}>{message}</Text>:null}</View>
    </>:<>
      <Text style={styles.brand}>Shinema</Text>
      {route==='library'?<LibrariesNavigation libraries={libraries} selectedId={stored.selectedLibraryId} focusedIndex={navigationFocus} onSelect={chooseLibrary}/>:null}
      {route==='setup'?<View key="setup" style={styles.detail}>
        <Text style={styles.title}>Connect your library</Text><Text style={styles.text}>HTTPS server address</Text>
        <TextInput ref={input} style={styles.input} value={originText} onChangeText={setOriginText} autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={()=>{input.current?.blur();void connect(originText);}} returnKeyType="done" />
        {button(busy?'Connecting...':'Connect',()=>{input.current?.blur();if(!busy)void connect(originText);})}
        <Text style={styles.text}>Up: edit address   Select: connect   Back: return</Text>
      </View>:route==='detail' && selected?<View key="detail" style={styles.detail}>
        <Text style={styles.title}>{selected.title}</Text><Text style={styles.text}>{selected.container.toUpperCase()}  /  {Math.round(selected.sizeBytes/1048576)} MiB</Text>
        <Text style={styles.text}>{remembered && remembered.positionSeconds<remembered.durationSeconds-3?`Resume from ${Math.floor(remembered.positionSeconds)} seconds`:'Ready to play'}</Text>
        {button(busy?'Checking resume...':'Play',()=>void play())}<Text style={styles.text}>Select: play   Back: library</Text>
      </View>:<View key="library" style={styles.grid}>
        {Array.from({length:8},(_,slot)=>{
          const index=pageFor(cursor)*8+slot;const item=items[index];
          return <Pressable key={slot} style={[styles.card,{width:(width-94)/4},cursor===index&&navigationFocus===null&&styles.focus]} onPress={()=>{if(item){setCursor(index);setNavigationFocus(null);openDetails();}}}>
            {item?<><View style={[styles.cover,{backgroundColor:`hsl(${parseInt(item.id.slice(0,4),16)%360},35%,25%)`}]}><Text style={styles.initials}>{item.title.slice(0,2).toUpperCase()}</Text></View><Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.small}>{item.container.toUpperCase()}{stored.progress[item.id]?`  ${Math.floor(stored.progress[item.id].positionSeconds)} s`:''}</Text></>:null}
          </Pressable>;
        })}
      </View>}
      <Text style={styles.notice}>{message}</Text>
      {route==='library'?<Text style={styles.footer}>{items.length?`${cursor+1} / ${items.length}${stored.catalog?.nextOffset!==null && stored.catalog?.nextOffset!==undefined?` of ${stored.catalog.total}`:''}  `:''}{libraries.length?'Up: libraries   ':''}Arrows: browse   Select: open   Back: exit   Menu: server</Text>:null}
    </>}
  </View>;
}

const styles=StyleSheet.create({
  shell:{flex:1,backgroundColor:'#101621',padding:28},brand:{color:'#7ce8cb',fontSize:28,fontWeight:'700',marginBottom:14},
  grid:{flexDirection:'row',flexWrap:'wrap',gap:10},card:{height:177,padding:6,borderWidth:3,borderColor:'transparent',backgroundColor:'#1c2739',borderRadius:8},focus:{borderColor:'#7ce8cb'},
  cover:{height:115,alignItems:'center',justifyContent:'center',borderRadius:4},initials:{fontSize:38,color:'#e6f6f2',fontWeight:'600'},cardTitle:{fontSize:17,color:'#fff',marginTop:6},small:{fontSize:12,color:'#b9c9df'},
  detail:{gap:18,paddingTop:20,maxWidth:780},title:{fontSize:30,fontWeight:'600',color:'#fff'},text:{fontSize:18,color:'#c9d5e5'},notice:{color:'#9fe6d8',fontSize:15,marginTop:12},footer:{color:'#afbdd0',fontSize:14,marginTop:10},
  button:{backgroundColor:'#7ce8cb',padding:14,borderRadius:6,alignSelf:'flex-start'},buttonText:{fontSize:20,fontWeight:'600',color:'#101621'},input:{backgroundColor:'#24334b',color:'#fff',fontSize:20,padding:14,borderRadius:6},
  overlay:{position:'absolute',bottom:24,left:28,right:28,padding:18,gap:10,backgroundColor:'#101621dd',borderRadius:8},
});
