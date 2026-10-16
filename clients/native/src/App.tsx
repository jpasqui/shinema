import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AccessibilityInfo,Animated,AppState,BackHandler,NativeEventEmitter,NativeModules,Pressable,ScrollView,StyleSheet,Text,TextInput,View,useWindowDimensions} from 'react-native';
import Video from 'react-native-video';
import type {VideoRef} from 'react-native-video';
import {resumeAt,serverOrigin} from '../../../packages/contracts/index.ts';
import type {Media,Progress,LibraryDescriptor} from '../../../packages/contracts/index.ts';
import {fresh,recover,move} from './domain.ts';
import type {Stored} from './domain.ts';
import {SessionGuard,StorageQueue,ProgressQueue,connectValidated,persistThenSync,syncProgress,resolveResume,backDestination} from './session.ts';
import type {ConnectionStamp} from './session.ts';
import {archiveTheme,defaultTheme,exportTheme,importTheme,MAX_THEME_BYTES,midnightTheme,parseTheme,THEME_DESIGN_VALUES} from '../../../packages/design-tokens/theme.ts';
import type {Theme,ThemeDesign} from '../../../packages/design-tokens/theme.ts';
import {AppearancePersistence,defaultPreferences,focusScrollOffset,prefersReducedMotion} from './preferences.ts';
import type {AppearancePreferences} from './preferences.ts';
import {NativeDetail,NativeHeader,NativeLibrary,NativePlayerChrome} from './skins.tsx';
import {nativeSkinLayout} from './skin-layout.ts';
import {FEED_BATCH_SIZE,NativeFeed,clampFeedAnchor,feedItemTop,feedScrollAnchor,parseFeedBatch,parseFeedCatalog,restoreFeedAnchor} from './feed.ts';
import {HttpStatusError,loadLibrarySnapshot,visibleLibraries as visibleLibraryDescriptors} from './libraries.ts';
import {NativeActivity,StartupHydration} from './lifecycle.ts';
import type {FeedScope} from './feed.ts';

const Host=NativeModules.ShinemaHost as {readState:()=>Promise<string>;stageState:(value:string)=>Promise<void>;writeState:(value:string)=>Promise<void>;readPreferences:()=>Promise<string>;writePreferences:(value:string)=>Promise<void>;finish:()=>void};
type Route='setup'|'library'|'detail'|'player'|'appearance';
type Key={code:number;action:number;repeat:number};

async function request(origin:string,path:string,method='GET',value?:Progress,signal?:AbortSignal):Promise<unknown>{
  const controller=new AbortController();const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,5000);
  try{
    const response=await fetch(origin+path,{method,signal:controller.signal,headers:value?{'Content-Type':'application/json'}:undefined,body:value?JSON.stringify(value):undefined});
    if(signal?.aborted)throw new Error('Canceled library request');
    if(!response.ok)throw new HttpStatusError(response.status);
    return response.status===204?null:await response.json();
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}

function scopeFor(value:Pick<Stored,'origin'|'libraries'|'selectedLibraryId'>):FeedScope{
  const library=value.libraries?.libraries.find(item=>item.id===value.selectedLibraryId&&item.visible);
  return {origin:value.origin,libraryId:library?.id??null,...(library&&value.libraries?{revision:value.libraries.revision}:{}),collection:library?.mediaType==='mixed'?'all':library?.mediaType??'all'};
}

export default function App(){
  const feed=useRef(new NativeFeed(scopeFor(fresh())));
  const [feedSnapshot,setFeedSnapshot]=useState(()=>feed.current.snapshot());const [renderAnchor,setRenderAnchor]=useState(0);const [headerCursor,setHeaderCursor]=useState(0);
  const {width,height}=useWindowDimensions();const [stored,setStored]=useState<Stored>(fresh());const store=useRef(stored);
  const visibleLibraries=useMemo(()=>visibleLibraryDescriptors(stored.libraries),[stored.libraries]);
  const selectedLibrary=visibleLibraries.find(library=>library.id===stored.selectedLibraryId);
  const [route,setRoute]=useState<Route>('setup');const [cursor,setCursor]=useState(0);const [originText,setOriginText]=useState(fresh().origin);
  const cursorPosition=useRef(cursor);cursorPosition.current=cursor;
  const [message,setMessage]=useState('Enter your server address.');const [busy,setBusy]=useState(false);const [paused,setPaused]=useState(false);
  const [clock,setClock]=useState(0);const [duration,setDuration]=useState(0);const [loading,setLoading]=useState(true);
  const video=useRef<VideoRef>(null);const input=useRef<React.ComponentRef<typeof TextInput>>(null);const position=useRef(0);const total=useRef(0);
  const resume=useRef<Progress|null>(null);const waitingSeek=useRef(false);const backHeld=useRef(false);const lastSave=useRef(0);
  const activeItem=useRef<Media|null>(null);
  const activeDestination=useRef<ConnectionStamp|null>(null);
  const session=useRef(new SessionGuard());const handler=useRef<(key:Key)=>void>(()=>{});
  const activity=useRef(new NativeActivity());const mounted=useRef(true);
  const startupStorage=useRef<StartupHydration<Stored>|null>(null);
  const saveCurrent=useRef<()=>Promise<void>>(async()=>{});const persistQueue=useRef(new StorageQueue());
  const syncQueue=useRef(new ProgressQueue());
  const [preferences,setPreferences]=useState<AppearancePreferences>(defaultPreferences);
  const currentPreferences=useRef(preferences);
  const appearance=useRef(new AppearancePersistence());const appearanceReturn=useRef<'setup'|'library'|'detail'>('setup');
  const preferenceRevision=useRef(0);const [appearanceMessage,setAppearanceMessage]=useState('');
  const [themeText,setThemeText]=useState('');const themeInput=useRef<React.ComponentRef<typeof TextInput>>(null);
  const [appearanceCursor,setAppearanceCursor]=useState(0);const [headerFocused,setHeaderFocused]=useState(false);
  const sceneScroll=useRef<React.ComponentRef<typeof ScrollView>>(null);const sceneOffset=useRef(0);const libraryScroll=useRef(0);const navigationMode=useRef<'remote'|'touch'>('remote');const withinLibraryRow=useRef(0);const [viewportHeight,setViewportHeight]=useState(0);
  const appearanceTop=useRef(0);const appearanceEditorTop=useRef(0);const appearanceBounds=useRef<{y:number;height:number}[]>([]);const libraryTop=useRef(0);const detailPlay=useRef({y:0,height:0});
  const [systemReduced,setSystemReduced]=useState(true);const reduced=prefersReducedMotion(preferences.motion,systemReduced,preferences.theme.design.motion);
  const {compact,columns,cardHeight,gap}=nativeSkinLayout(preferences.theme,width,height);
  const styles=useMemo(()=>makeStyles(preferences.theme,compact),[preferences.theme,compact]);
  const sceneOpacity=useRef(new Animated.Value(1)).current;
  feed.current.focus(cursor);const totalItems=feedSnapshot.total;const selected=route==='player'?activeItem.current??undefined:feed.current.itemAt(cursor);
  const playbackOrigin=route==='player'?activeDestination.current?.origin:stored.origin;
  const source=useMemo(()=>({uri:(playbackOrigin??stored.origin)+(selected?.streamPath??'')}),[playbackOrigin,stored.origin,selected?.streamPath]);

  useEffect(()=>{
    let alive=true;let motionRevision=0;
    const motion=AccessibilityInfo.addEventListener('reduceMotionChanged',value=>{++motionRevision;if(alive)setSystemReduced(value);});
    const started=motionRevision;
    void AccessibilityInfo.isReduceMotionEnabled().then(value=>{if(alive && started===motionRevision)setSystemReduced(value);}).catch(()=>{if(alive && started===motionRevision)setSystemReduced(true);});
    void appearance.current.load(()=>Host.readPreferences()).then(result=>{if(alive && result){currentPreferences.current=result.preferences;setPreferences(result.preferences);setAppearanceMessage(result.warning);}});
    return()=>{alive=false;motion.remove();};
  },[]);

  useEffect(()=>{const y=route==='library'?libraryScroll.current:0;sceneOffset.current=y;sceneScroll.current?.scrollTo({y,animated:false});},[route]);

  function focusCursor(index:number){cursorPosition.current=index;feed.current.focus(index);setCursor(index);}
  function cancelConnection(){activity.current.cancelConnection();session.current.cancelConnection();}

  function loadFeed(index:number,retry=false){
    if(activity.current.connecting())return;
    if(store.current.libraries&&store.current.selectedLibraryId===null)return;
    const destination=session.current.capture(store.current.origin);const work=feed.current.load(index,(origin,path,signal)=>request(origin,path,'GET',undefined,signal),cursorPosition.current,retry);setFeedSnapshot(feed.current.snapshot());
    void work.then(applied=>{if(!mounted.current)return;setFeedSnapshot(feed.current.snapshot());if(!applied||!session.current.current(destination,store.current.origin))return;const start=Math.floor(index/FEED_BATCH_SIZE)*FEED_BATCH_SIZE;for(let slot=start;slot<start+FEED_BATCH_SIZE;slot++){const item=feed.current.itemAt(slot);const pending=item?store.current.pending[item.id]:undefined;if(item&&pending)void flush(item.id,pending,destination);}});
  }
  useEffect(()=>{
    if(route!=='library'||busy||(stored.libraries&&stored.selectedLibraryId===null)||(feedSnapshot.known&&totalItems===0))return;
    if(!feed.current.isCached(renderAnchor)&&!feed.current.isLoading(renderAnchor)&&!feed.current.errorAt(renderAnchor)){loadFeed(renderAnchor);return;}
    if(!feed.current.isCached(cursor)&&!feed.current.isLoading(cursor)&&!feed.current.errorAt(cursor)){loadFeed(cursor);return;}
    const edge=Math.min(totalItems-1,Math.max(cursor,renderAnchor+Math.ceil(viewportHeight/(cardHeight+gap))*columns-1));
    if(edge>=0&&!feed.current.isCached(edge)&&!feed.current.isLoading(edge)&&!feed.current.errorAt(edge)){loadFeed(edge);return;}
    const next=(Math.floor(edge/FEED_BATCH_SIZE)+1)*FEED_BATCH_SIZE;
    if(next-edge<=columns*3&&next<totalItems&&!feed.current.isCached(next)&&!feed.current.isLoading(next)&&!feed.current.errorAt(next))loadFeed(next);
  },[route,busy,cursor,renderAnchor,feedSnapshot.revision,feedSnapshot.known,columns,totalItems,viewportHeight,cardHeight,gap,stored.libraries,stored.selectedLibraryId]);

  function chooseLibrary(library:LibraryDescriptor){
    if(route==='player')return;
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    setHeaderFocused(false);
    if(library.id===store.current.selectedLibraryId&&feed.current.snapshot().known){cancelConnection();setBusy(false);setRoute('library');return;}
    void connect(store.current.origin,true,library.id);
  }
  useEffect(()=>{setHeaderCursor(current=>Math.min(current,visibleLibraries.length));},[visibleLibraries.length]);
  useEffect(()=>{setRenderAnchor(current=>clampFeedAnchor(current,feedSnapshot.known,totalItems));},[feedSnapshot.known,totalItems]);

  function revealFocus(top:number,focusHeight:number){
    const y=focusScrollOffset(sceneOffset.current,top,focusHeight,viewportHeight);
    sceneOffset.current=y;sceneScroll.current?.scrollTo({y,animated:false});
  }

  useEffect(()=>{
    sceneOpacity.stopAnimation();
    if(reduced || route==='player'){sceneOpacity.setValue(1);return;}
    sceneOpacity.setValue(0);
    const animation=Animated.timing(sceneOpacity,{toValue:1,duration:180,useNativeDriver:true});animation.start();
    return()=>animation.stop();
  },[route,reduced,sceneOpacity]);

  useEffect(()=>{
    if(route==='appearance'){
      if(themeInput.current?.isFocused())return;
      const bounds=appearanceBounds.current[appearanceCursor];if(bounds)revealFocus(appearanceTop.current+bounds.y,bounds.height);
    }else if(route==='library'){
      if(navigationMode.current==='touch'&&!headerFocused)return;
      if(headerFocused){sceneOffset.current=0;sceneScroll.current?.scrollTo({y:0,animated:false});}
      else revealFocus(libraryTop.current+feedItemTop(cursor,columns,cardHeight+gap),cardHeight);
    }else if(route==='detail'){
      if(headerFocused){sceneOffset.current=0;sceneScroll.current?.scrollTo({y:0,animated:false});}
      else if(detailPlay.current.height)revealFocus(detailPlay.current.y,detailPlay.current.height);
    }
  },[appearanceCursor,cursor,headerFocused,route,columns,cardHeight,gap,viewportHeight]);

  function changeAppearance(next:AppearancePreferences){
    const revision=++preferenceRevision.current;
    currentPreferences.current=next;setPreferences(next);setAppearanceMessage('Saving appearance on this device...');
    void appearance.current.save(next,raw=>Host.writePreferences(raw)).then(()=>{
      if(preferenceRevision.current===revision)setAppearanceMessage('Appearance saved on this device.');
    }).catch(()=>{if(preferenceRevision.current===revision)setAppearanceMessage('Appearance is active for this session, but could not be saved. Apply again to retry.');});
  }
  function openAppearance(){
    if(route==='player' || route==='appearance')return;
    appearanceReturn.current=route==='library'?'library':route==='detail'?'detail':'setup';
    cancelConnection();setBusy(false);setHeaderFocused(false);setAppearanceCursor(0);setRoute('appearance');
  }
  function closeAppearance(){themeInput.current?.blur();setRoute(appearanceReturn.current);setHeaderFocused(false);}
  function importAppearance(){
    try{changeAppearance({...currentPreferences.current,theme:importTheme(themeText)});}
    catch(error){setAppearanceMessage(error instanceof Error?`Theme not applied: ${error.message}`:'Theme not applied. Use valid theme JSON.');}
  }
  function cycleDesign(key:keyof ThemeDesign){
    const current=currentPreferences.current;
    const values:readonly string[]=THEME_DESIGN_VALUES[key];
    const next=values[(values.indexOf(current.theme.design[key])+1)%values.length];
    changeAppearance({...current,theme:parseTheme({...current.theme,design:{...current.theme.design,[key]:next}})});
  }
  function focusThemeInput(){
    const y=appearanceTop.current+appearanceEditorTop.current;sceneOffset.current=y;sceneScroll.current?.scrollTo({y,animated:false});themeInput.current?.focus();
  }
  function appearanceAction(index:number){appearanceActions[index]?.run();}

  function update(value:Stored){store.current=value;if(mounted.current)setStored(value);}
  function hydrateStartup(restored:Stored){
    const scope=scopeFor(restored);
    try{feed.current.reset(scope,restored.catalog??undefined);}catch{restored={...restored,catalog:null};feed.current.reset(scope);if(mounted.current)setMessage('Saved library data was invalid. Reconnect to refresh.');}
    update(restored);if(mounted.current)setFeedSnapshot(feed.current.snapshot());
  }
  function startupState():StartupHydration<Stored>{
    if(!startupStorage.current)startupStorage.current=new StartupHydration(()=>Host.readState().then(recover),hydrateStartup);
    return startupStorage.current;
  }
  function acceptCatalog(value:Stored,refresh:boolean){
    const scope=scopeFor(value);const oldScope=scopeFor(store.current);const changed=JSON.stringify(scope)!==JSON.stringify(oldScope);const selectedId=feed.current.itemAt(cursorPosition.current)?.id;
    const preserved=!changed&&!refresh&&Boolean(value.catalog)&&!(value.libraries&&value.selectedLibraryId===null);
    if(preserved&&value.catalog)feed.current.refresh(value.catalog);else feed.current.reset(scope,value.catalog??undefined);
    update(value);setFeedSnapshot(feed.current.snapshot());
    const restored=selectedId&&!changed?value.catalog?.items.findIndex(item=>item.id===selectedId):-1;
    focusCursor(preserved?cursorPosition.current:changed?0:typeof restored==='number'&&restored>=0?restored:Math.min(cursorPosition.current,Math.max(0,feed.current.snapshot().total-1)));
    if(changed){setRenderAnchor(0);libraryScroll.current=0;sceneOffset.current=0;withinLibraryRow.current=0;navigationMode.current='remote';sceneScroll.current?.scrollTo({y:0,animated:false});}
  }
  function openDetails(){
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    cancelConnection();setBusy(false);setHeaderFocused(false);setRoute('detail');
  }
  function persist():Promise<void>{
    // Sample when this queue slot executes, so an old snapshot cannot overwrite
    // a newer successfully activated server after a delayed connection write.
    return startupState().run(()=>persistQueue.current.run(()=>Host.writeState(JSON.stringify(store.current))));
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

  async function connect(raw:string,refresh=true,selection?:string){
    activity.current.interact();
    let origin:string;try{origin=serverOrigin(raw);}catch{cancelConnection();setBusy(false);setMessage('Enter an HTTPS address without a path or credentials.');return;}
    feed.current.cancelPending();setFeedSnapshot(feed.current.snapshot());const signal=activity.current.beginConnection();const attempt=session.current.beginConnection();setBusy(true);setMessage('Loading library...');
    setOriginText(origin);
    try{
      await startupState().ready();
      if(!mounted.current||signal.aborted||!session.current.currentAttempt(attempt))return;
      const current=store.current;const sameOrigin=origin===current.origin;
      const snapshot=await loadLibrarySnapshot(origin,selection??(sameOrigin?current.selectedLibraryId:null),sameOrigin?current.libraries:null,(destination,path)=>activity.current.read(signal,()=>request(destination,path,'GET',undefined,signal)),FEED_BATCH_SIZE);
      const loadedScope=scopeFor({origin,libraries:snapshot.libraries,selectedLibraryId:snapshot.selectedLibraryId});
      const emptySelection=Boolean(snapshot.libraries&&snapshot.selectedLibraryId===null);
      const catalog=emptySelection?parseFeedCatalog(snapshot.catalog,loadedScope):parseFeedBatch(snapshot.catalog,loadedScope,0);
      if(!refresh&&!emptySelection&&JSON.stringify(loadedScope)===JSON.stringify(scopeFor(store.current))&&!feed.current.canRefresh(catalog))throw new Error('Library changed. Reconnect to refresh this view.');
      const result=await connectValidated(session.current,attempt,origin,async()=>catalog,{
        read:()=>store.current,write:value=>acceptCatalog(value,refresh),persist,queue:persistQueue.current,
        stageDisk:value=>Host.stageState(JSON.stringify(value)),
        writeDisk:value=>Host.writeState(JSON.stringify(value)),
      },snapshot);
      if(!result)return;
      const {stamp}=result;
      setRoute('library');setHeaderFocused(false);setMessage(feed.current.errorAt(0)??(catalog.items.length?'Library ready.':snapshot.libraries&&snapshot.selectedLibraryId===null?'No libraries are visible. Update visibility in the server library settings.':'This library is empty.'));
      for(const [id,pending] of Object.entries(store.current.pending))if(catalog.items.some(item=>item.id===id))void flush(id,pending,stamp);
    }catch(error){
      if(!session.current.currentAttempt(attempt))return;
      if(store.current.catalog){setRoute('library');setMessage(error instanceof Error&&error.message.startsWith('Library changed.')?error.message:origin===store.current.origin?'Browsing cached library. Server is unavailable.':'Could not switch server. Your current library and progress are retained.');}
      else setMessage('Could not connect. Check the address and trusted HTTPS setup.');
    }finally{activity.current.finishConnection(signal);if(session.current.currentAttempt(attempt))setBusy(false);}
  }

  async function play(){
    if(!selected || busy)return;
    if(session.current.isSwitchCommitting()){setMessage('Finishing server switch. Try Play again in a moment.');return;}
    activity.current.cancelConnection();const item=selected;const ticket=session.current.beginPlayback(store.current.origin);
    setBusy(true);setMessage('Checking resume position...');
    const result=await resolveResume(session.current,ticket,item.id,()=>store.current,(origin,id)=>request(origin,`/api/media/${id}/progress`));
    if(!result)return;
    activeItem.current=item;activeDestination.current=ticket;resume.current=result.progress;position.current=0;total.current=0;waitingSeek.current=false;lastSave.current=Date.now();
    setClock(0);setDuration(0);setPaused(false);setLoading(true);setRoute('player');setBusy(false);setMessage('');
  }

  useEffect(()=>{
    let alive=true;mounted.current=true;const startup=activity.current.capture();
    void startupState().ready().then(restored=>{if(!alive||!activity.current.current(startup))return;setOriginText(restored.origin);if(store.current.catalog)setRoute('library');void connect(restored.origin,false);}).catch(()=>{if(alive&&activity.current.current(startup))setMessage('Could not read the saved library. Enter your server address to reconnect.');});
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
    return()=>{alive=false;mounted.current=false;keys.remove();lifecycle.remove();nativeBack.remove();cancelConnection();feed.current.reset(scopeFor(store.current));};
  },[]);

  handler.current=(key:Key)=>{
    const back=key.code===4 || key.code===111;
    if(key.action===1){if(back)backHeld.current=false;return;}
    activity.current.interact();
    if([19,20,21,22,23,66].includes(key.code))navigationMode.current='remote';
    if(route==='appearance'){
      if(back){if(!backHeld.current){backHeld.current=true;closeAppearance();}return;}
      if(key.code===82 && key.repeat===0){closeAppearance();return;}
      if([19,20,21,22].includes(key.code))setAppearanceCursor(current=>Math.max(0,Math.min(appearanceActions.length-1,current+([19,21].includes(key.code)?-1:1))));
      else if([23,66].includes(key.code) && key.repeat===0)appearanceAction(appearanceCursor);
      return;
    }
    if(back){
      if(backHeld.current)return;backHeld.current=true;cancelConnection();setBusy(false);
      const destination=backDestination(route,Boolean(store.current.catalog));
      if(route==='player'){setPaused(true);void save();activeItem.current=null;activeDestination.current=null;setLoading(false);}
      if(destination==='exit')void persist().catch(()=>{}).then(()=>Host.finish());
      else {setRoute(destination);setHeaderFocused(false);setBusy(false);}
      return;
    }
    if(route==='setup'){
      if(key.code===82 && key.repeat===0)openAppearance();
      else if(key.code===19)input.current?.focus();
      else if((key.code===23 || key.code===66) && !busy)void connect(originText);
      return;
    }
    if(key.code===82 && route!=='player'){cancelConnection();setBusy(false);setHeaderFocused(false);setRoute('setup');setMessage('Edit server address, then connect.');return;}
    if(route==='library'){
      if(headerFocused){
        if(key.code===20)setHeaderFocused(false);
        else if(key.code===21)setHeaderCursor(current=>Math.max(0,current-1));
        else if(key.code===22)setHeaderCursor(current=>Math.min(visibleLibraries.length,current+1));
        else if([23,66].includes(key.code) && key.repeat===0){const library=visibleLibraries[headerCursor];if(library)chooseLibrary(library);else openAppearance();}
        return;
      }
      navigationMode.current='remote';const direction=({21:-1,22:1,19:-columns,20:columns} as Record<number,number>)[key.code];
      if(key.code===19 && cursor<columns){setHeaderFocused(true);setHeaderCursor(Math.max(0,visibleLibraries.findIndex(library=>library.id===selectedLibrary?.id)));}
      else if(direction!==undefined){const next=move(cursorPosition.current,direction,totalItems);focusCursor(next);setRenderAnchor(next);}
      else if((key.code===23 || key.code===66) && key.repeat===0){if(feed.current.itemAt(cursorPosition.current))openDetails();else loadFeed(cursorPosition.current,true);}
    }else if(route==='detail'){
      if(key.code===19){setHeaderFocused(true);setHeaderCursor(visibleLibraries.length);}
      else if(key.code===20)setHeaderFocused(false);
      else if((key.code===23 || key.code===66) && key.repeat===0){if(headerFocused)openAppearance();else void play();}
    }else if(route==='player'){
      if([23,66,85].includes(key.code) && key.repeat===0)setPaused(value=>!value);
      else if([21,22].includes(key.code) && total.current>0)video.current?.seek(Math.max(0,Math.min(total.current,position.current+(key.code===21?-10:10))));
    }
  };

  const button=(label:string,action:()=>void)=><Pressable accessibilityRole="button" style={styles.button} onPress={action}><Text numberOfLines={1} style={styles.buttonText}>{label}</Text></Pressable>;
  const remembered=selected?stored.progress[selected.id]:undefined;
  const appearanceActions=[
    {id:'marquee',label:'Marquee preset',active:exportTheme(preferences.theme)===exportTheme(defaultTheme),run:()=>changeAppearance({...currentPreferences.current,theme:defaultTheme})},
    {id:'archive',label:'Archive preset',active:exportTheme(preferences.theme)===exportTheme(archiveTheme),run:()=>changeAppearance({...currentPreferences.current,theme:archiveTheme})},
    {id:'midnight',label:'Midnight palette',active:JSON.stringify(preferences.theme.colors)===JSON.stringify(midnightTheme.colors),run:()=>changeAppearance({...currentPreferences.current,theme:parseTheme({...currentPreferences.current.theme,name:'Midnight',colors:midnightTheme.colors})})},
    ...(['typography','density','cards','motion'] as const).map(key=>({id:key,label:`${key==='motion'?'Theme motion':key[0].toUpperCase()+key.slice(1)} / ${preferences.theme.design[key]}`,active:false,run:()=>cycleDesign(key)})),
    {id:'system',label:'Accessibility motion / follow system',active:preferences.motion==='system',run:()=>changeAppearance({...currentPreferences.current,motion:'system'})},
    {id:'reduced',label:'Accessibility motion / reduced',active:preferences.motion==='reduced',run:()=>changeAppearance({...currentPreferences.current,motion:'reduced'})},
    {id:'edit',label:'Edit theme JSON',active:false,run:focusThemeInput},
    {id:'import',label:'Apply imported theme',active:false,run:importAppearance},
    {id:'reset',label:'Reset appearance',active:false,run:()=>{setThemeText('');changeAppearance(defaultPreferences());}},
    {id:'done',label:'Done',active:false,run:closeAppearance},
  ];
  return <View style={styles.shell}>
    {route==='player' && selected?<>
      <Video ref={video} style={StyleSheet.absoluteFill} source={source} paused={paused} resizeMode="contain" playInBackground={false} playWhenInactive={false} progressUpdateInterval={1000}
        onLoad={event=>{
          total.current=event.duration;setDuration(event.duration);setLoading(false);
          const target=resumeAt(resume.current,event.duration);waitingSeek.current=target>0;
          if(target>0){position.current=target;setClock(target);video.current?.seek(target);}
        }}
        onSeek={event=>{waitingSeek.current=false;position.current=event.currentTime;setClock(event.currentTime);}}
        onProgress={event=>{
          if(waitingSeek.current)return;position.current=event.currentTime;setClock(event.currentTime);
          if(Date.now()-lastSave.current>=5000){lastSave.current=Date.now();void save(selected);}
        }}
        onBuffer={event=>setLoading(event.isBuffering)}
        onEnd={()=>{position.current=total.current;void save(selected);setPaused(true);setMessage('Finished. Press Back to return.');}}
        onError={()=>{setLoading(false);setPaused(true);setMessage('Playback failed. This slice directly plays device-supported files only. Press Back.');}}
      />
      <NativePlayerChrome theme={preferences.theme} title={selected.title} loading={loading} paused={paused} clock={clock} duration={duration} message={message} />
    </>:<>
      <NativeHeader theme={preferences.theme} width={width} focused={headerFocused} headerCursor={route==='detail'?visibleLibraries.length:headerCursor} libraries={visibleLibraries} selectedLibraryId={selectedLibrary?.id} onLibrary={chooseLibrary} onAppearance={openAppearance} />
      {route==='appearance'?<Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.notice,{height:40,marginTop:0,marginBottom:12}]}>{appearanceMessage||'System motion respects device accessibility. A still theme always disables animation.'}</Text>:null}
      <ScrollView ref={sceneScroll} style={styles.scroller} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" onLayout={event=>setViewportHeight(event.nativeEvent.layout.height)} onScrollBeginDrag={()=>{activity.current.interact();navigationMode.current='touch';}} onScroll={event=>{const y=event.nativeEvent.contentOffset.y;sceneOffset.current=y;if(route==='library'){libraryScroll.current=y;withinLibraryRow.current=Math.max(0,y-libraryTop.current)%(cardHeight+gap);setRenderAnchor(feedScrollAnchor(y,libraryTop.current,columns,cardHeight+gap,feedSnapshot.known,totalItems));}}} scrollEventThrottle={16}>
      <Animated.View style={{opacity:sceneOpacity}}>
      {route==='appearance'?<View key="appearance" style={styles.appearance}>
        <Text style={styles.eyebrow}>MAKE IT YOURS</Text><Text style={styles.title}>Appearance</Text>
        <Text style={styles.text}>{preferences.theme.name}  /  {reduced?'Reduced motion':'System motion'}  /  this device</Text>
        <View style={styles.preferenceColumns} onLayout={event=>{appearanceTop.current=event.nativeEvent.layout.y;const bounds=appearanceBounds.current[appearanceCursor];if(bounds&&!themeInput.current?.isFocused())revealFocus(appearanceTop.current+bounds.y,bounds.height);}}>
          <View style={styles.preferenceActions}>
            {appearanceActions.map((action,index)=><Pressable key={action.id} accessibilityRole="button" accessibilityState={{selected:action.active}} onLayout={event=>{const bounds=event.nativeEvent.layout;appearanceBounds.current[index]=bounds;if(index===appearanceCursor&&!themeInput.current?.isFocused())revealFocus(appearanceTop.current+bounds.y,bounds.height);}} style={[styles.preferenceButton,appearanceCursor===index&&styles.headerFocus]} onPress={()=>{setAppearanceCursor(index);appearanceAction(index);}}><Text style={styles.preferenceText}>{action.label}{action.active?' [active]':''}</Text></Pressable>)}

          </View>
          <View style={styles.preferenceEditor} onLayout={event=>{appearanceEditorTop.current=event.nativeEvent.layout.y;}}>
            <Text style={styles.sectionTitle}>Custom theme</Text><Text style={styles.small}>Paste version 1 JSON. Choose authored layouts, type, spacing, cards and motion. Named colors are contrast checked. No CSS, scripts or remote assets.</Text>
            <TextInput ref={themeInput} accessibilityLabel="Custom theme JSON" value={themeText} onChangeText={setThemeText} style={styles.jsonInput} placeholder="Paste theme JSON here" placeholderTextColor={preferences.theme.colors.muted} multiline maxLength={MAX_THEME_BYTES} autoCapitalize="none" autoCorrect={false} submitBehavior="blurAndSubmit" onSubmitEditing={()=>{themeInput.current?.blur();setAppearanceCursor(appearanceActions.findIndex(action=>action.id==='import'));importAppearance();}} />
            <Text style={styles.small}>Current theme  /  select this read-only JSON to copy</Text><ScrollView style={styles.exportScroll} nestedScrollEnabled><Text selectable style={styles.export}>{exportTheme(preferences.theme)}</Text></ScrollView>
          </View>
        </View>
        <Text style={styles.footer}>Up / Down: choose   Select: apply   Back / Menu: return</Text>
      </View>:route==='setup'?<View key="setup" style={styles.detail}>
        <Text style={styles.eyebrow}>YOUR COLLECTION, BEAUTIFULLY CLOSE</Text>
        <Text style={styles.title}>Connect your library</Text><Text style={styles.text}>HTTPS server address</Text>
        <TextInput ref={input} style={styles.input} value={originText} onChangeText={value=>{activity.current.interact();setOriginText(value);}} autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={()=>{input.current?.blur();void connect(originText);}} returnKeyType="done" />
        {button(busy?'Connecting...':'Connect',()=>{input.current?.blur();if(!busy)void connect(originText);})}
        <Text style={styles.small}>Up: edit address   Select: connect   Back: return   Menu: appearance</Text>
      </View>:route==='detail' && selected?<NativeDetail theme={preferences.theme} width={width} height={height} reduced={reduced} origin={stored.origin} item={selected} progress={remembered} busy={busy} focused={!headerFocused} onPlay={()=>void play()} onPlayLayout={bounds=>{detailPlay.current=bounds;if(!headerFocused)revealFocus(bounds.y,bounds.height);}} />:<NativeLibrary theme={preferences.theme} width={width} height={height} reduced={reduced} origin={stored.origin} itemAt={index=>feed.current.itemAt(index)} total={totalItems} known={feedSnapshot.known} anchor={renderAnchor} viewport={viewportHeight} cursor={cursor} headerFocused={headerFocused} busy={busy} libraryName={selectedLibrary?.name??'Your collection'} errorAt={index=>feed.current.errorAt(index)} isLoading={index=>feed.current.isLoading(index)} onRetry={index=>loadFeed(index,true)} progress={stored.progress} onSelect={index=>{focusCursor(index);openDetails();}} onGridLayout={bounds=>{libraryTop.current=bounds.y;if(headerFocused)return;if(navigationMode.current==='touch'){const y=restoreFeedAnchor(clampFeedAnchor(renderAnchor,feedSnapshot.known,totalItems),withinLibraryRow.current,bounds.y,columns,cardHeight+gap);sceneOffset.current=y;libraryScroll.current=y;sceneScroll.current?.scrollTo({y,animated:false});}else revealFocus(bounds.y+feedItemTop(cursor,columns,cardHeight+gap),cardHeight);}} />}
      {route!=='appearance'&&route!=='library'?<Text accessibilityLiveRegion="polite" style={[styles.notice,{height:40}]} numberOfLines={2}>{message}</Text>:null}

      </Animated.View></ScrollView>
      {route==='library'?<View style={{height:68,paddingTop:8}}><Text numberOfLines={1} style={[styles.footer,{height:18,lineHeight:18,marginTop:0}]}>{totalItems?'Title '+(cursor+1)+' of '+totalItems+'  ':''}Arrows: browse   Select: details / retry   Up from top: libraries   Back: exit   Menu: server</Text><Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.notice,{height:40,marginTop:2}]}>{message||' '}</Text></View>:null}
    </>}
  </View>;
}

const makeStyles=(theme:Theme,compact:boolean)=>{
  const colors=theme.colors;const archive=theme.design.skin==='archive';const dense=theme.design.density==='compact';const radius=archive?0:6;
  const fontFamily=theme.design.typography==='editorial'?'serif':theme.design.typography==='cinema'?'sans-serif-light':'sans-serif';
  return StyleSheet.create({
    shell:{flex:1,backgroundColor:colors.background,padding:dense?16:compact?20:28},scroller:{flex:1},scrollContent:{paddingBottom:12},
    detail:{gap:dense?12:16,paddingTop:12,maxWidth:960},eyebrow:{fontFamily,color:colors.muted,fontSize:11,fontWeight:'600',letterSpacing:2},title:{fontFamily,fontSize:compact?30:36,color:colors.text},text:{fontFamily,fontSize:17,color:colors.text,lineHeight:25},small:{fontFamily,fontSize:13,color:colors.muted,lineHeight:19},notice:{fontFamily,color:colors.text,fontSize:14,marginTop:12,lineHeight:20},footer:{fontFamily,color:colors.muted,fontSize:12,marginTop:10,lineHeight:18},sectionTitle:{fontFamily,fontSize:19,color:colors.text},
    button:{height:54,width:260,maxWidth:'100%',justifyContent:'center',backgroundColor:colors.accent,paddingVertical:0,paddingHorizontal:28,borderRadius:radius,borderWidth:2,borderColor:'transparent',alignSelf:'flex-start'},buttonText:{height:24,lineHeight:24,fontFamily,fontSize:20,color:colors.onAccent},input:{fontFamily,backgroundColor:colors.surface,color:colors.text,fontSize:20,padding:14,borderRadius:radius,borderWidth:1,borderColor:colors.muted},
    appearance:{gap:10},preferenceColumns:{flexDirection:compact?'column':'row',gap:dense?16:24,marginTop:8},preferenceActions:{width:compact?'100%':'42%',gap:dense?4:6},preferenceButton:{paddingVertical:dense?8:10,paddingHorizontal:12,borderWidth:2,borderColor:colors.muted,borderRadius:radius,backgroundColor:colors.surface},headerFocus:{borderColor:colors.focus},preferenceText:{fontFamily,color:colors.text,fontSize:14},preferenceEditor:{flex:1,gap:8},jsonInput:{height:106,padding:12,textAlignVertical:'top',color:colors.text,backgroundColor:colors.surface,borderColor:colors.muted,borderWidth:1,borderRadius:radius,fontSize:12},exportScroll:{height:130,maxHeight:130,backgroundColor:colors.surface,borderRadius:radius},export:{color:colors.text,padding:12,fontSize:11,lineHeight:14},
  });
};
