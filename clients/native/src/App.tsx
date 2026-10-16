import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AccessibilityInfo,Animated,AppState,BackHandler,NativeEventEmitter,NativeModules,Pressable,ScrollView,StyleSheet,Text,TextInput,View,useWindowDimensions} from 'react-native';
import Video,{SelectedTrackType} from 'react-native-video';
import type {VideoRef} from 'react-native-video';
import {parseCatalog,serverOrigin,localHttpOrigin} from '../../../packages/contracts/index.ts';
import type {Media,Progress,LibraryDescriptor,ServerTransport} from '../../../packages/contracts/index.ts';
import {fresh,recover,move} from './domain.ts';
import type {Stored} from './domain.ts';
import {SessionGuard,StorageQueue,ProgressQueue,connectValidated,persistThenSync,syncProgress,resolvePlayableResume,backDestination} from './session.ts';
import type {ConnectionStamp} from './session.ts';
import {archiveTheme,defaultTheme,exportTheme,importTheme,MAX_THEME_BYTES,midnightTheme,parseTheme,THEME_DESIGN_VALUES} from '../../../packages/design-tokens/theme.ts';
import type {Theme,ThemeDesign} from '../../../packages/design-tokens/theme.ts';
import {AppearancePersistence,defaultPreferences,focusScrollOffset,prefersReducedMotion} from './preferences.ts';
import type {AppearancePreferences} from './preferences.ts';
import {NativeDetail,NativeHeader,NativeLibrary,NativePlayerChrome,NativeUnavailable} from './skins.tsx';
import {nativeSkinLayout} from './skin-layout.ts';
import {libraryEntryTarget,libraryFocusOffset} from './library-focus.ts';
import {FEED_BATCH_SIZE,NativeFeed,clampFeedAnchor,feedScrollAnchor,parseFeedBatch,parseFeedCatalog,restoreFeedAnchor} from './feed.ts';
import {HttpStatusError,loadLibrarySnapshot,visibleLibraries as visibleLibraryDescriptors,nativeFeedScope,navigationContentSupport,nativeMediaContentSupport,snapshotCatalogForActivation} from './libraries.ts';
import {NativeActivity,StartupHydration} from './lifecycle.ts';
import type {FeedScope} from './feed.ts';
import {encryptedTransport,NativeTransportPolicy,nativeTransportScope,selectionTransport,readyTransport,restoreSelection} from './transport.ts';
import {moveSetupFocus,setupScrollOffset} from './setup-focus.ts';
import type {SetupControl,SetupBounds} from './setup-focus.ts';
import {initialPlayback,loadedPlayback} from './playback.ts';
import type {InitialPlayback} from './playback.ts';
import {headerTarget,moveHeaderCursor} from './header-navigation.ts';
import {Requests} from './Requests.tsx';
import {SubtitleController,SubtitleClock,SUBTITLE_SEEK_RECOVERY_MS,emptySubtitles,subtitleAt} from './subtitles.ts';

const Host=NativeModules.ShinemaHost as {readState:()=>Promise<string>;stageState:(value:string)=>Promise<void>;writeState:(value:string)=>Promise<void>;readPreferences:()=>Promise<string>;writePreferences:(value:string)=>Promise<void>;finish:()=>void;setRequestNavigation:(enabled:boolean)=>void;setLocalHttpOrigin:(origin:string|null)=>Promise<void>};
type Route='setup'|'library'|'detail'|'player'|'appearance'|'requests';
type Key={code:number;action:number;repeat:number};
const disabledTextTrack={type:SelectedTrackType.DISABLED};
const deviceLanguages=()=>{try{return [Intl.DateTimeFormat().resolvedOptions().locale];}catch{return [];}};

async function request(origin:string,path:string,method='GET',value?:Progress,signal?:AbortSignal,transport:ServerTransport=encryptedTransport):Promise<unknown>{
  origin=serverOrigin(origin,transport);
  const controller=new AbortController();const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,5000);
  try{
    const options={method,signal:controller.signal,redirect:'error' as const,credentials:'omit' as const,headers:value?{'Content-Type':'application/json'}:undefined,body:value?JSON.stringify(value):undefined};
    const response=await fetch(origin+path,options);
    if(signal?.aborted)throw new Error('Canceled library request');
    if(response.url&&new URL(response.url).origin!==origin)throw new Error('The server redirected outside its approved origin.');
    if(!response.ok)throw new HttpStatusError(response.status);
    return response.status===204?null:await response.json();
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}

const scopeFor=(value:Parameters<typeof nativeFeedScope>[0])=>{try{return nativeFeedScope(value);}catch{return null;}};

export default function App(){
  const feed=useRef(new NativeFeed(scopeFor(fresh()) as FeedScope));
  const [feedSnapshot,setFeedSnapshot]=useState(()=>feed.current.snapshot());const [renderAnchor,setRenderAnchor]=useState(0);const [headerCursor,setHeaderCursor]=useState(0);
  const {width,height}=useWindowDimensions();const [stored,setStored]=useState<Stored>(fresh());const store=useRef(stored);
  const visibleLibraries=useMemo(()=>visibleLibraryDescriptors(stored.libraries),[stored.libraries]);
  const selectedLibrary=visibleLibraries.find(library=>library.id===stored.selectedLibraryId);
  const librarySupport=navigationContentSupport(stored);
  const [route,setRoute]=useState<Route>('setup');const [cursor,setCursor]=useState(0);const [originText,setOriginText]=useState(fresh().origin);
  const cursorPosition=useRef(cursor);cursorPosition.current=cursor;
  const [setupFocus,setSetupFocus]=useState<SetupControl>('connect');
  const [draftHttpOrigin,setDraftHttpOrigin]=useState<string|null>(null);const draftConsent=useRef<string|null>(null);
  const [message,setMessage]=useState('Enter your server address.');const [busy,setBusy]=useState(false);const [paused,setPaused]=useState(false);
  const [clock,setClock]=useState(0);const [duration,setDuration]=useState(0);const [loading,setLoading]=useState(true);
  const [subtitles,setSubtitles]=useState(emptySubtitles);const [subtitleMenu,setSubtitleMenu]=useState(false);const [subtitleCursor,setSubtitleCursor]=useState(0);
  const subtitleController=useRef(new SubtitleController(setSubtitles));
  const [caption,setCaption]=useState('');const subtitleTime=useRef(new SubtitleClock());
  const subtitleRecovery=useRef<ReturnType<typeof setTimeout>|null>(null);
  const video=useRef<VideoRef>(null);const input=useRef<React.ComponentRef<typeof TextInput>>(null);const position=useRef(0);const total=useRef(0);
  const playback=useRef<InitialPlayback|null>(null);const waitingSeek=useRef(false);const backHeld=useRef(false);const lastSave=useRef(0);
  const activeItem=useRef<Media|null>(null);
  const activeDestination=useRef<ConnectionStamp|null>(null);
  const session=useRef(new SessionGuard());const handler=useRef<(key:Key)=>void>(()=>{});
  const activity=useRef(new NativeActivity());const mounted=useRef(true);
  const startupStorage=useRef<StartupHydration<Stored>|null>(null);
  const [,notifyTransport]=useState(0);const policy=useRef<NativeTransportPolicy|null>(null);
  if(!policy.current)policy.current=new NativeTransportPolicy(origin=>Host.setLocalHttpOrigin(origin),()=>{if(mounted.current)notifyTransport(value=>value+1);},nativeTransportScope);
  const saveCurrent=useRef<()=>Promise<void>>(async()=>{});const persistQueue=useRef(new StorageQueue());
  const syncQueue=useRef(new ProgressQueue());
  const requestsBack=useRef<()=>void>(()=>{});
  const [preferences,setPreferences]=useState<AppearancePreferences>(defaultPreferences);
  const currentPreferences=useRef(preferences);
  const appearance=useRef(new AppearancePersistence());const appearanceReturn=useRef<'setup'|'library'|'detail'>('setup');
  const preferenceRevision=useRef(0);const [appearanceMessage,setAppearanceMessage]=useState('');
  const [themeText,setThemeText]=useState('');const themeInput=useRef<React.ComponentRef<typeof TextInput>>(null);
  const [appearanceCursor,setAppearanceCursor]=useState(0);const [headerFocused,setHeaderFocused]=useState(true);
  const sceneScroll=useRef<React.ComponentRef<typeof ScrollView>>(null);const sceneOffset=useRef(0);const libraryScroll=useRef(0);const navigationMode=useRef<'remote'|'touch'>('remote');const withinLibraryRow=useRef(0);const [viewportHeight,setViewportHeight]=useState(0);
  const appearanceTop=useRef(0);const appearanceEditorTop=useRef(0);const appearanceBounds=useRef<{y:number;height:number}[]>([]);const libraryTop=useRef(0);const detailPlay=useRef({y:0,height:0});
  const setupTop=useRef(0);const setupBounds=useRef<SetupBounds>({});
  const [systemReduced,setSystemReduced]=useState(true);const reduced=prefersReducedMotion(preferences.motion,systemReduced,preferences.theme.design.motion);
  const {compact,columns,cardHeight,gap}=nativeSkinLayout(preferences.theme,width,height);
  const styles=useMemo(()=>makeStyles(preferences.theme,compact),[preferences.theme,compact]);
  const sceneOpacity=useRef(new Animated.Value(1)).current;
  feed.current.focus(cursor);const totalItems=feedSnapshot.total;const selected=route==='player'?activeItem.current??undefined:feed.current.itemAt(cursor);
  const selectedSupport=selected?nativeMediaContentSupport(selected,stored):{supported:true};
  const selectedTransport=useMemo(()=>{try{return selectionTransport(stored);}catch{return null;}},[stored.origin,stored.localHttpOrigin]);
  const transportReady=selectedTransport!==null&&policy.current.permits(stored.origin,selectedTransport);
  const source=transportReady?playback.current?.source:undefined;

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
  async function restoreConfirmedTransport():Promise<boolean>{
    return restoreSelection(policy.current!,store.current);
  }
  function cancelConnection(){
    activity.current.cancelConnection();session.current.cancelConnection();
    // Once the atomic final write starts its new server may still become
    // authoritative. Its completion restores from the newest confirmed state.
    if(mounted.current&&!session.current.isSwitchCommitting())void restoreConfirmedTransport();
  }
  async function scopedRequest(origin:string,path:string,method='GET',value?:Progress,signal?:AbortSignal,transport?:ServerTransport):Promise<unknown>{
    const context=transport??selectionTransport(store.current);const ticket=policy.current!.version();
    if(!policy.current!.current(ticket,origin,context))throw new Error('Server transport permission changed.');
    const response=await request(origin,path,method,value,signal,context);
    if(!policy.current!.current(ticket,origin,context))throw new Error('Server transport permission changed.');
    return response;
  }
  function editOrigin(value:string){
    activity.current.interact();cancelConnection();draftConsent.current=null;setDraftHttpOrigin(null);setOriginText(value);
  }
  function toggleLocalHttp(){
    if(session.current.isSwitchCommitting()){setMessage('Finishing the server change. Change HTTP consent after this completes.');return;}
    activity.current.interact();cancelConnection();
    if(draftConsent.current){
      const revoked=draftConsent.current;draftConsent.current=null;setDraftHttpOrigin(null);
      if(store.current.origin===revoked&&store.current.localHttpOrigin===revoked){
        session.current.invalidateTransport();feed.current.cancelPending();update({...store.current,localHttpOrigin:null});
        void policy.current!.revoke().catch(()=>{});
        void persist().catch(()=>setMessage('HTTP permission is off for this session, but could not be saved. Try again before restarting.'));
      }
      setMessage('Local HTTP is off. HTTPS remains the default.');return;
    }
    try{const origin=localHttpOrigin(originText);draftConsent.current=origin;setDraftHttpOrigin(origin);setMessage('Local HTTP consent applies only to '+origin+'. Press Connect to verify this local server.');}
    catch{setMessage('Enter a local http:// server origin without a path or credentials before allowing HTTP.');}
  }
  function focusSetup(control:SetupControl){
    setSetupFocus(control);setHeaderFocused(control==='appearance'||control==='requests');
    if(control==='appearance')setHeaderCursor(visibleLibraries.length);
    else if(control==='requests')setHeaderCursor(visibleLibraries.length+1);
    if(control==='address')input.current?.focus();else input.current?.blur();
  }
  function activateSetup(){
    if(setupFocus==='appearance')openAppearance();else if(setupFocus==='requests')void openRequests();
    else if(setupFocus==='http')toggleLocalHttp();else if(setupFocus==='address')input.current?.focus();
    else if(!busy)void connect(originText);
  }
  function openServer(){
    if(route==='player')return;
    if(session.current.isSwitchCommitting()){setMessage('Finishing the current server change. Try again in a moment.');return;}
    activity.current.interact();cancelConnection();feed.current.cancelPending();setFeedSnapshot(feed.current.snapshot());
    setBusy(false);focusSetup('connect');setRoute('setup');setMessage('Edit server address, then connect.');
  }

  function loadFeed(index:number,retry=false){
    const context=readyTransport(policy.current!,store.current);if(!context)return;
    if(activity.current.connecting())return;
    if(!navigationContentSupport(store.current).supported)return;
    if(store.current.libraries&&store.current.selectedLibraryId===null)return;
    const destination=session.current.capture(store.current.origin,context);const work=feed.current.load(index,(origin,path,signal,transport)=>scopedRequest(origin,path,'GET',undefined,signal,transport),cursorPosition.current,retry);setFeedSnapshot(feed.current.snapshot());
    void work.then(applied=>{if(!mounted.current)return;setFeedSnapshot(feed.current.snapshot());if(!applied||!session.current.current(destination,store.current.origin))return;const start=Math.floor(index/FEED_BATCH_SIZE)*FEED_BATCH_SIZE;for(let slot=start;slot<start+FEED_BATCH_SIZE;slot++){const item=feed.current.itemAt(slot);const pending=item?store.current.pending[item.id]:undefined;if(item&&pending)void flush(item,pending,destination);}});
  }
  useEffect(()=>{
    if(route!=='library'||busy||!transportReady||!librarySupport.supported||(stored.libraries&&stored.selectedLibraryId===null)||(feedSnapshot.known&&totalItems===0))return;
    if(!feed.current.isCached(renderAnchor)&&!feed.current.isLoading(renderAnchor)&&!feed.current.errorAt(renderAnchor)){loadFeed(renderAnchor);return;}
    if(!feed.current.isCached(cursor)&&!feed.current.isLoading(cursor)&&!feed.current.errorAt(cursor)){loadFeed(cursor);return;}
    const edge=Math.min(totalItems-1,Math.max(cursor,renderAnchor+Math.ceil(viewportHeight/(cardHeight+gap))*columns-1));
    if(edge>=0&&!feed.current.isCached(edge)&&!feed.current.isLoading(edge)&&!feed.current.errorAt(edge)){loadFeed(edge);return;}
    const next=(Math.floor(edge/FEED_BATCH_SIZE)+1)*FEED_BATCH_SIZE;
    if(next-edge<=columns*3&&next<totalItems&&!feed.current.isCached(next)&&!feed.current.isLoading(next)&&!feed.current.errorAt(next))loadFeed(next);
  },[route,busy,transportReady,cursor,renderAnchor,feedSnapshot.revision,feedSnapshot.known,columns,totalItems,viewportHeight,cardHeight,gap,stored.libraries,stored.selectedLibraryId,librarySupport.supported]);

  function chooseLibrary(library:LibraryDescriptor){
    if(route==='player')return;
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    setHeaderFocused(true);setHeaderCursor(Math.max(0,visibleLibraries.findIndex(item=>item.id===library.id)));
    if(library.id===store.current.selectedLibraryId&&(feed.current.snapshot().known||!librarySupport.supported)){cancelConnection();setBusy(false);setHeaderFocused(!librarySupport.supported);setRoute('library');return;}
    void connect(store.current.origin,true,library.id,store.current.localHttpOrigin??null);
  }
  useEffect(()=>{setHeaderCursor(current=>Math.min(current,visibleLibraries.length+(route==='library'?2:1)));},[visibleLibraries.length,route]);
  useEffect(()=>{setRenderAnchor(current=>clampFeedAnchor(current,feedSnapshot.known,totalItems));},[feedSnapshot.known,totalItems]);

  function revealFocus(top:number,focusHeight:number){
    const y=focusScrollOffset(sceneOffset.current,top,focusHeight,viewportHeight);
    sceneOffset.current=y;sceneScroll.current?.scrollTo({y,animated:false});
  }
  function revealLibraryFocus(){
    const y=libraryFocusOffset({current:sceneOffset.current,gridTop:libraryTop.current,cursor:cursorPosition.current,columns,cardHeight,gap,viewport:viewportHeight,headerFocused});
    sceneOffset.current=y;libraryScroll.current=y;sceneScroll.current?.scrollTo({y,animated:false});
  }
  function revealSetupFocus(){
    const y=setupScrollOffset(sceneOffset.current,setupFocus,setupTop.current,setupBounds.current,viewportHeight);
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
    if(route==='setup')revealSetupFocus();
    else if(route==='appearance'){
      if(themeInput.current?.isFocused())return;
      const bounds=appearanceBounds.current[appearanceCursor];if(bounds)revealFocus(appearanceTop.current+bounds.y,bounds.height);
    }else if(route==='library'){
      if(!librarySupport.supported)return;
      if(navigationMode.current==='touch'&&!headerFocused)return;
      revealLibraryFocus();
    }else if(route==='detail'){
      if(headerFocused){sceneOffset.current=0;sceneScroll.current?.scrollTo({y:0,animated:false});}
      else if(detailPlay.current.height)revealFocus(detailPlay.current.y,detailPlay.current.height);
    }
  },[setupFocus,appearanceCursor,cursor,headerFocused,route,columns,cardHeight,gap,viewportHeight,librarySupport.supported]);

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
  function closeAppearance(){themeInput.current?.blur();setRoute(appearanceReturn.current);setHeaderFocused(!navigationContentSupport(store.current).supported);}
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
    if(scope){try{feed.current.reset(scope,restored.catalog??undefined);}catch{restored={...restored,catalog:null};feed.current.reset(scope);if(mounted.current)setMessage('Saved library data was invalid. Reconnect to refresh.');}}
    else feed.current.cancelPending();
    update(restored);if(mounted.current)setFeedSnapshot(feed.current.snapshot());
  }
  function startupState():StartupHydration<Stored>{
    if(!startupStorage.current)startupStorage.current=new StartupHydration(()=>Host.readState().then(recover),hydrateStartup);
    return startupStorage.current;
  }
  function acceptCatalog(value:Stored,refresh:boolean){
    const scope=scopeFor(value);const oldScope=scopeFor(store.current);const changed=JSON.stringify(scope)!==JSON.stringify(oldScope);const selectedId=feed.current.itemAt(cursorPosition.current)?.id;
    const preserved=scope!==null&&!changed&&!refresh&&Boolean(value.catalog)&&!(value.libraries&&value.selectedLibraryId===null);
    if(!scope)feed.current.cancelPending();else if(preserved&&value.catalog)feed.current.refresh(value.catalog);else feed.current.reset(scope,value.catalog??undefined);
    update(value);setFeedSnapshot(feed.current.snapshot());
    const restored=selectedId&&!changed?value.catalog?.items.findIndex(item=>item.id===selectedId):-1;
    focusCursor(preserved?cursorPosition.current:changed?0:typeof restored==='number'&&restored>=0?restored:Math.min(cursorPosition.current,Math.max(0,feed.current.snapshot().total-1)));
    if(changed){setRenderAnchor(0);libraryScroll.current=0;sceneOffset.current=0;withinLibraryRow.current=0;navigationMode.current='remote';sceneScroll.current?.scrollTo({y:0,animated:false});}
  }
  function openDetails(item=feed.current.itemAt(cursorPosition.current)){
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    if(!item)return;const support=nativeMediaContentSupport(item,store.current);if(!support.supported){setMessage(support.reason??'This content is not supported on this device.');return;}
    cancelConnection();setBusy(false);setHeaderFocused(false);setRoute('detail');
  }
  async function openRequests(){
    if(session.current.isSwitchCommitting()){setMessage('Finishing library update. Try again in a moment.');return;}
    activity.current.interact();cancelConnection();feed.current.cancelPending();const ticket=activity.current.capture();
    try{await startupState().ready();}catch{if(mounted.current&&activity.current.current(ticket))setMessage('Could not read the saved server. Retry setup before opening requests.');return;}
    if(!mounted.current||!activity.current.current(ticket))return;
    const restored=await restoreConfirmedTransport();
    if(!mounted.current||!activity.current.current(ticket))return;
    if(!restored){setRoute('setup');setMessage('Allow HTTP for the exact saved local server, then Connect before opening requests.');return;}
    setBusy(false);setHeaderFocused(true);setHeaderCursor(visibleLibraries.length+1);setRoute('requests');
  }
  function persist():Promise<void>{
    // Sample when this queue slot executes, so an old snapshot cannot overwrite
    // a newer successfully activated server after a delayed connection write.
    return startupState().run(()=>persistQueue.current.run(()=>Host.writeState(JSON.stringify(store.current))));
  }
  async function syncOne(item:Media,value:Progress,destination:ConnectionStamp){
    if(!nativeMediaContentSupport(item,store.current).supported)return;
    const id=item.id;
    try{
      await syncProgress(session.current,destination,id,value,{read:()=>store.current,write:update,persist},async(origin,key,progress)=>{await scopedRequest(origin,`/api/media/${key}/progress`,'PUT',progress,undefined,{localHttpOrigin:destination.localHttpOrigin??null});});
    }catch{if(session.current.current(destination,store.current.origin))setMessage('Progress saved on this device; sync will retry.');}
  }
  function flush(item:Media,value:Progress,destination:ConnectionStamp):Promise<void>{
    return syncQueue.current.enqueue(()=>syncOne(item,value,destination));
  }
  async function save(item=activeItem.current){
    const destination=activeDestination.current;
    if(!item || activeItem.current?.id!==item.id || !destination || !session.current.current(destination,store.current.origin) || total.current<=0 || waitingSeek.current)return;
    const value={positionSeconds:Math.min(Math.max(0,position.current),total.current),durationSeconds:total.current};
    update({...store.current,progress:{...store.current.progress,[item.id]:value},pending:{...store.current.pending,[item.id]:value}});
    try{await persistThenSync(session.current,destination,persist,()=>store.current.origin,stamp=>flush(item,value,stamp));}
    catch{if(session.current.current(destination,store.current.origin))setMessage('Device progress storage failed.');}
  }
  saveCurrent.current=()=>save();

  async function connect(raw:string,refresh=true,selection?:string,consent:string|null=draftConsent.current){
    activity.current.interact();
    if(session.current.isSwitchCommitting()){setMessage('Finishing the current server change. Try again in a moment.');return;}
    let origin:string;let transport:ServerTransport;try{transport=selectionTransport({origin:raw,localHttpOrigin:consent});origin=serverOrigin(raw,transport);}catch{cancelConnection();setBusy(false);setMessage('Use HTTPS, or explicitly allow this exact local HTTP server. Paths and credentials are not allowed.');return;}
    feed.current.cancelPending();setFeedSnapshot(feed.current.snapshot());const signal=activity.current.beginConnection();const attempt=session.current.beginConnection();const presentation=activity.current.capture();const fromLibrary=route==='library';setBusy(true);setMessage('Loading library...');
    setOriginText(origin);draftConsent.current=transport.localHttpOrigin;setDraftHttpOrigin(transport.localHttpOrigin);
    try{
      await startupState().ready();
      if(!mounted.current||signal.aborted||!session.current.currentAttempt(attempt))return;
      if(!await policy.current!.activate(origin,transport)||signal.aborted||!session.current.currentAttempt(attempt))return;
      const current=store.current;const sameOrigin=origin===current.origin;
      const snapshot=await loadLibrarySnapshot(origin,selection??(sameOrigin?current.selectedLibraryId:null),sameOrigin?current.libraries:null,(destination,path)=>activity.current.read(signal,()=>scopedRequest(destination,path,'GET',undefined,signal,transport)),FEED_BATCH_SIZE);
      const loadedScope=scopeFor({origin,localHttpOrigin:transport.localHttpOrigin,libraries:snapshot.libraries,selectedLibraryId:snapshot.selectedLibraryId});
      const snapshotSupport=navigationContentSupport(snapshot);
      const seedOnly=!snapshotSupport.supported||Boolean(snapshot.libraries&&snapshot.selectedLibraryId===null);
      const candidateCatalog=snapshotCatalogForActivation(store.current,origin,snapshot);
      const catalog=!loadedScope?parseCatalog(candidateCatalog):seedOnly?parseFeedCatalog(candidateCatalog,loadedScope):parseFeedBatch(candidateCatalog,loadedScope,0);
      if(!refresh&&!seedOnly&&loadedScope&&JSON.stringify(loadedScope)===JSON.stringify(scopeFor(store.current))&&!feed.current.canRefresh(catalog))throw new Error('Library changed. Reconnect to refresh this view.');
      const result=await connectValidated(session.current,attempt,origin,async()=>catalog,{
        read:()=>store.current,write:value=>acceptCatalog(value,refresh),persist,queue:persistQueue.current,
        stageDisk:value=>Host.stageState(JSON.stringify(value)),
        writeDisk:value=>Host.writeState(JSON.stringify(value)),
      },snapshot,transport);
      if(!result)return;
      const {stamp}=result;
      setRoute('library');if(!snapshotSupport.supported||libraryEntryTarget(fromLibrary,sameOrigin&&current.selectedLibraryId===snapshot.selectedLibraryId,activity.current.current(presentation))==='header'){setHeaderFocused(true);setHeaderCursor(Math.max(0,visibleLibraryDescriptors(snapshot.libraries).findIndex(item=>item.id===snapshot.selectedLibraryId)));}setMessage(!snapshotSupport.supported?snapshotSupport.reason??'This content is not supported on this device.':feed.current.errorAt(0)??(catalog.items.length?'Library ready.':snapshot.libraries&&snapshot.selectedLibraryId===null?'No libraries are visible. Update visibility in the server library settings.':'This library is empty.'));
      for(const item of catalog.items){const pending=store.current.pending[item.id];if(pending&&nativeMediaContentSupport(item,store.current).supported)void flush(item,pending,stamp);}
    }catch(error){
      if(!session.current.currentAttempt(attempt))return;
      if(store.current.catalog||store.current.libraries){setRoute('library');setHeaderFocused(current=>!navigationContentSupport(store.current).supported||activity.current.current(presentation)&&!fromLibrary?true:current);setMessage(error instanceof Error&&error.message.startsWith('Library changed.')?error.message:origin===store.current.origin?'Browsing cached library. Server is unavailable.':'Could not switch server. Your current library and progress are retained.');}
      else setMessage('Could not connect. Check the address and trusted HTTPS setup.');
    }finally{
      activity.current.finishConnection(signal);
      // Read the authoritative state after any irreversible write, never a
      // captured pre-switch server. Stale attempts cannot issue a restoration.
      if(session.current.currentAttempt(attempt))await restoreConfirmedTransport();
      if(session.current.currentAttempt(attempt))setBusy(false);
    }
  }

  async function play(){
    if(!selected || busy)return;
    const support=nativeMediaContentSupport(selected,store.current);if(!support.supported){setMessage(support.reason??'This content is not supported on this device.');return;}
    if(session.current.isSwitchCommitting()){setMessage('Finishing server switch. Try Play again in a moment.');return;}
    let transport:ServerTransport;try{transport=selectionTransport(store.current);}catch{setMessage('Enable local HTTP for this server before playback.');return;}
    activity.current.cancelConnection();const item=selected;const ticket=session.current.beginPlayback(store.current.origin,transport);
    if(!await restoreConfirmedTransport()||!session.current.currentPlayback(ticket,store.current.origin))return;
    setBusy(true);setMessage('Checking resume position...');
    const result=await resolvePlayableResume(session.current,ticket,item,()=>store.current,(origin,id)=>scopedRequest(origin,`/api/media/${id}/progress`,'GET',undefined,undefined,transport));
    if(!result)return;
    if(!result.supported){setBusy(false);setMessage(result.reason??'This content is not supported on this device.');return;}
    const initial=initialPlayback(ticket.origin+item.streamPath,result.progress);
    playback.current=initial;activeItem.current=item;activeDestination.current=ticket;position.current=initial.positionSeconds;total.current=0;waitingSeek.current=false;lastSave.current=Date.now();
    clearSubtitleRecovery();subtitleTime.current.reset(initial.positionSeconds);setCaption('');setSubtitleMenu(false);setSubtitleCursor(0);
    void subtitleController.current.start(ticket.origin,item.id,deviceLanguages(),transport);
    setClock(initial.positionSeconds);setDuration(0);setPaused(false);setLoading(true);setRoute('player');setBusy(false);setMessage('');
  }

  useEffect(()=>{
    let alive=true;mounted.current=true;policy.current!.claim();const startup=activity.current.capture();
    void startupState().ready().then(restored=>{if(!alive||!activity.current.current(startup))return;setOriginText(restored.origin);draftConsent.current=restored.localHttpOrigin??null;setDraftHttpOrigin(draftConsent.current);if(restored.origin.startsWith('http:')&&!restored.localHttpOrigin){void policy.current!.revoke().catch(()=>{});setMessage('Saved local server needs explicit HTTP consent before connecting.');return;}if(store.current.catalog||store.current.libraries){setHeaderFocused(true);setRoute('library');}void connect(restored.origin,false,undefined,restored.localHttpOrigin??null);}).catch(()=>{if(alive&&activity.current.current(startup))setMessage('Could not read the saved library. Enter your server address to reconnect.');});
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
    return()=>{alive=false;mounted.current=false;keys.remove();lifecycle.remove();nativeBack.remove();clearSubtitleRecovery();subtitleTime.current.stop();subtitleController.current.cancel();cancelConnection();feed.current.cancelPending();void policy.current!.dispose().catch(()=>{});};
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
      if(route==='player'&&subtitleMenu){if(!backHeld.current){backHeld.current=true;setSubtitleMenu(false);}return;}
      if(route==='requests'){if(!backHeld.current){backHeld.current=true;requestsBack.current();}return;}
      if(backHeld.current)return;backHeld.current=true;cancelConnection();setBusy(false);
      const destination=backDestination(route,Boolean(store.current.catalog||store.current.libraries));
      if(route==='player'){subtitleController.current.cancel();stopCaption();setPaused(true);void save();activeItem.current=null;activeDestination.current=null;setLoading(false);}
      if(destination==='exit')void persist().catch(()=>{}).then(()=>Host.finish());
      else {setRoute(destination);setHeaderFocused(destination==='library'&&!navigationContentSupport(store.current).supported);setBusy(false);}
      return;
    }
    // Request controls own native focus. Their keys must not reach library/player actions.
    if(route==='requests')return;
    if(route==='setup'){
      if(key.code===82 && key.repeat===0)openAppearance();
      else if([19,20].includes(key.code))focusSetup(moveSetupFocus(setupFocus,key.code===19?-1:1));
      else if([21,22].includes(key.code)&&setupFocus==='http')toggleLocalHttp();
      else if((key.code===23 || key.code===66)&&key.repeat===0)activateSetup();
      return;
    }
    if(key.code===82 && route!=='player'){openServer();return;}
    if(route==='library'){
      if(headerFocused){
        if(key.code===20&&librarySupport.supported&&totalItems>0)setHeaderFocused(false);
        else if([21,22].includes(key.code))setHeaderCursor(current=>moveHeaderCursor(visibleLibraries.length,current,key.code===21?-1:1,true));
        else if([23,66].includes(key.code) && key.repeat===0){const target=headerTarget(visibleLibraries.length,headerCursor,true);if(target?.type==='library'){const library=visibleLibraries[target.index];if(library)chooseLibrary(library);}else if(target?.type==='appearance')openAppearance();else if(target?.type==='requests')void openRequests();else if(target?.type==='server')openServer();}
        return;
      }
      if(!librarySupport.supported){setHeaderFocused(true);setMessage(librarySupport.reason??'This content is not supported on this device.');return;}
      navigationMode.current='remote';const direction=({21:-1,22:1,19:-columns,20:columns} as Record<number,number>)[key.code];
      if(key.code===19 && cursor<columns){setHeaderFocused(true);setHeaderCursor(Math.max(0,visibleLibraries.findIndex(library=>library.id===selectedLibrary?.id)));}
      else if(direction!==undefined){const next=move(cursorPosition.current,direction,totalItems);focusCursor(next);setRenderAnchor(next);}
      else if((key.code===23 || key.code===66) && key.repeat===0){if(feed.current.itemAt(cursorPosition.current))openDetails();else loadFeed(cursorPosition.current,true);}
    }else if(route==='detail'){
      if(key.code===19){setHeaderFocused(true);setHeaderCursor(visibleLibraries.length);}
      else if(key.code===20)setHeaderFocused(false);
      else if((key.code===23 || key.code===66) && key.repeat===0){if(headerFocused)openAppearance();else void play();}
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
    {route==='player' && selected && selectedSupport.supported&&transportReady?<>
      <Video ref={video} style={StyleSheet.absoluteFill} source={source} selectedTextTrack={disabledTextTrack} paused={paused} resizeMode="contain" playInBackground={false} playWhenInactive={false} progressUpdateInterval={subtitles.cues.length?100:1000}
        onLoad={event=>{
          total.current=event.duration;setDuration(event.duration);setLoading(false);
          const initial=playback.current;if(!initial)return;
          const loaded=loadedPlayback(initial,event.duration,event.currentTime);waitingSeek.current=loaded.seekTo!==null;
          position.current=loaded.positionSeconds;setClock(loaded.positionSeconds);
          if(loaded.seekTo!==null){hideCaptionForSeek(loaded.seekTo);video.current?.seek(loaded.seekTo);}else captionAt(loaded.positionSeconds);
        }}
        onSeek={event=>{if(!subtitleTime.current.acceptsSeek(event.seekTime))return;waitingSeek.current=false;position.current=event.currentTime;setClock(event.currentTime);captionAt(event.currentTime,event.seekTime);}}
        onProgress={event=>{
          captionAt(event.currentTime);if(waitingSeek.current){if(!Number.isFinite(subtitleTime.current.current()))return;waitingSeek.current=false;}position.current=event.currentTime;setClock(current=>Math.floor(current)===Math.floor(event.currentTime)?current:event.currentTime);
          if(Date.now()-lastSave.current>=5000){lastSave.current=Date.now();void save(selected);}
        }}
        onBuffer={event=>setLoading(event.isBuffering)}
        onEnd={()=>{stopCaption();position.current=total.current;void save(selected);setPaused(true);setMessage('Finished. Press Back to return.');}}
        onError={()=>{stopCaption();setLoading(false);setPaused(true);setMessage('Playback failed. This slice directly plays device-supported files only. Press Back.');}}
      />
      {caption?<View pointerEvents="none" style={styles.captions}><Text style={styles.captionText} numberOfLines={4}>{caption}</Text></View>:null}
      <NativePlayerChrome theme={preferences.theme} title={selected.title} loading={loading} paused={paused} clock={clock} duration={duration} message={message} subtitleStatus={subtitleStatus} onSubtitles={openSubtitles} />
      {subtitleMenu?<View style={styles.subtitleMenu}>
        <Text style={styles.title}>Subtitles</Text><Text style={styles.small}>Plain text | Auto uses the default track, then device language.</Text>
        <Text style={styles.notice}>{subtitleStatus}</Text>
        {subtitleChoices.slice(Math.floor(Math.min(subtitleCursor,subtitleChoices.length-1)/5)*5,Math.floor(Math.min(subtitleCursor,subtitleChoices.length-1)/5)*5+5).map(choice=><Pressable key={choice.key} accessibilityRole="button" accessibilityState={{selected:choice.active,disabled:choice.disabled}} disabled={choice.disabled} style={[styles.subtitleChoice,subtitleChoices[Math.min(subtitleCursor,subtitleChoices.length-1)]?.key===choice.key&&styles.headerFocus,choice.disabled&&styles.unsupported]} onPress={()=>chooseSubtitle(choice.key)}><Text style={styles.text} numberOfLines={2}>{choice.active?'✓ ':''}{choice.label}</Text></Pressable>)}
        {subtitles.warnings.length?<Text style={styles.small}>{subtitles.warnings.join(' ')}</Text>:null}
        <Text style={styles.small}>Up / Down: browse | Select: choose | Back: close{subtitleChoices.length>5?` | ${Math.min(subtitleCursor+1,subtitleChoices.length)} / ${subtitleChoices.length}`:''}</Text>
      </View>:null}
    </>:route==='player'&&selected?<NativeUnavailable theme={preferences.theme} width={width} height={height} name={selected.title} reason={!transportReady?'The selected server transport is not approved or ready.':selectedSupport.reason??'This content is not supported on this device.'} instructions="Saved progress stays on this device. Press Back to return to details." />:<>
      <NativeHeader theme={preferences.theme} width={width} focused={route==='setup'?(setupFocus==='appearance'||setupFocus==='requests'):headerFocused} headerCursor={route==='detail'?visibleLibraries.length:headerCursor} libraries={visibleLibraries} selectedLibraryId={selectedLibrary?.id} onLibrary={chooseLibrary} onAppearance={openAppearance} onRequests={()=>{void openRequests();}} onServer={route==='library'?openServer:undefined} onActionFocus={action=>{if(route==='setup'&&action!=='server')focusSetup(action);else if(route==='library'){setHeaderFocused(true);setHeaderCursor(visibleLibraries.length+(action==='appearance'?0:action==='requests'?1:2));}}} />
      {route==='requests'&&transportReady?<Requests key={stored.origin} origin={stored.origin} transport={selectedTransport??undefined} backHandler={requestsBack} onBack={()=>{setHeaderFocused(true);setHeaderCursor(visibleLibraries.length+1);setRoute('library');}} />:<>
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
      </View>:route==='setup'?<View key="setup" style={styles.detail} onLayout={event=>{setupTop.current=event.nativeEvent.layout.y;revealSetupFocus();}}>
        <Text style={styles.eyebrow}>YOUR COLLECTION, BEAUTIFULLY CLOSE</Text>
        <Text style={styles.title}>Connect your library</Text><Text style={styles.text}>HTTPS server address</Text>
        <TextInput ref={input} style={[styles.input,setupFocus==='address'&&styles.headerFocus]} value={originText} onFocus={()=>focusSetup('address')} onLayout={event=>{setupBounds.current.address=event.nativeEvent.layout;if(setupFocus==='address')revealSetupFocus();}} onChangeText={editOrigin} autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={()=>{input.current?.blur();void connect(originText);}} returnKeyType="done" />
        <Pressable focusable accessibilityRole="checkbox" accessibilityState={{checked:draftHttpOrigin!==null}} onFocus={()=>focusSetup('http')} onLayout={event=>{setupBounds.current.http=event.nativeEvent.layout;if(setupFocus==='http')revealSetupFocus();}} onPress={toggleLocalHttp} style={[styles.preferenceButton,setupFocus==='http'&&styles.headerFocus]}><Text style={styles.text}>{draftHttpOrigin?'[x]':'[ ]'} Allow local HTTP for this server</Text><Text style={styles.small}>{draftHttpOrigin??'Enter an http:// address, then select this option for that exact origin.'}</Text></Pressable>
        <Text style={styles.small}>{draftHttpOrigin?'Unencrypted HTTP to '+draftHttpOrigin+' exposes media, requests and access tokens to anyone able to intercept this network. Use only a trusted local network. No other server is allowed.':'HTTPS is the default. Shinema never silently downgrades or bypasses certificate validation.'}</Text>
        <Pressable focusable accessibilityRole="button" onFocus={()=>focusSetup('connect')} onLayout={event=>{setupBounds.current.connect=event.nativeEvent.layout;if(setupFocus==='connect')revealSetupFocus();}} style={[styles.button,setupFocus==='connect'&&styles.headerFocus]} onPress={()=>{input.current?.blur();if(!busy)void connect(originText);}}><Text style={styles.buttonText}>{busy?'Connecting...':'Connect'}</Text></Pressable>
        <Text style={styles.small}>Up / Down: choose address, HTTP consent or Connect   Select: activate   Menu: appearance</Text>
      </View>:(route==='library'||route==='detail'||route==='requests')&&!transportReady?<NativeUnavailable theme={preferences.theme} width={width} height={height} name="Server connection" reason="The selected server transport is not approved or is being verified. Return to server settings to connect." />:route==='library'&&!librarySupport.supported?<NativeUnavailable theme={preferences.theme} width={width} height={height} name={selectedLibrary?.name??'Library'} reason={librarySupport.reason??'This content type is not supported on this device.'} />:route==='detail' && selected?selectedSupport.supported?<NativeDetail theme={preferences.theme} width={width} height={height} reduced={reduced} origin={stored.origin} transport={selectedTransport??undefined} item={selected} progress={remembered} busy={busy} focused={!headerFocused} onPlay={()=>void play()} onPlayLayout={bounds=>{detailPlay.current=bounds;if(!headerFocused)revealFocus(bounds.y,bounds.height);}} />:<NativeUnavailable theme={preferences.theme} width={width} height={height} name={selected.title} reason={selectedSupport.reason??'This format is not supported on this device.'} />:<NativeLibrary theme={preferences.theme} width={width} height={height} reduced={reduced} origin={stored.origin} transport={selectedTransport??undefined} itemAt={index=>feed.current.itemAt(index)} total={totalItems} known={feedSnapshot.known} anchor={renderAnchor} viewport={viewportHeight} cursor={cursor} headerFocused={headerFocused} busy={busy} libraryName={selectedLibrary?.name??'Your collection'} contentSupport={item=>nativeMediaContentSupport(item,stored)} errorAt={index=>feed.current.errorAt(index)} isLoading={index=>feed.current.isLoading(index)} onRetry={index=>loadFeed(index,true)} progress={stored.progress} onSelect={index=>{focusCursor(index);openDetails();}} onGridLayout={bounds=>{libraryTop.current=bounds.y;if(headerFocused){revealLibraryFocus();return;}if(navigationMode.current==='touch'){const y=restoreFeedAnchor(clampFeedAnchor(renderAnchor,feedSnapshot.known,totalItems),withinLibraryRow.current,bounds.y,columns,cardHeight+gap);sceneOffset.current=y;libraryScroll.current=y;sceneScroll.current?.scrollTo({y,animated:false});}else revealLibraryFocus();}} />}
      {route!=='appearance'&&route!=='library'?<Text accessibilityLiveRegion="polite" style={[styles.notice,{height:40}]} numberOfLines={2}>{message}</Text>:null}

      </Animated.View></ScrollView>
      {route==='library'?<View style={{height:compact?52:36,paddingTop:4}}><Text numberOfLines={1} style={[styles.footer,{height:14,lineHeight:14,fontSize:compact?11:10,marginTop:0}]}>{librarySupport.supported?headerFocused?'Left / Right: libraries and settings   Down: titles':(totalItems?'Title '+(cursor+1)+' of '+totalItems+'  ':'')+'Arrows: browse   Select: details / retry   Up from top: libraries':'Left / Right: libraries   Select: choose'}   Back: exit   Menu: server</Text><Text accessibilityLiveRegion="polite" numberOfLines={compact?2:1} style={[styles.notice,{height:compact?30:14,lineHeight:14,fontSize:compact?12:11,marginTop:2}]}>{!librarySupport.supported?librarySupport.reason:!selectedSupport.supported?selectedSupport.reason:message||' '}</Text></View>:null}
      </>}
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
    captions:{position:'absolute',bottom:310,left:'8%',right:'8%',alignItems:'center'},captionText:{fontSize:24,color:'#fff',textAlign:'center',backgroundColor:'#000c',paddingHorizontal:12,paddingVertical:5},
    subtitleMenu:{position:'absolute',top:16,right:compact?16:28,bottom:16,width:compact?'92%':'58%',padding:20,gap:10,backgroundColor:colors.background,borderWidth:1,borderColor:colors.muted,borderRadius:radius},subtitleChoice:{padding:10,borderWidth:3,borderColor:'transparent',backgroundColor:colors.surface,borderRadius:radius},unsupported:{opacity:0.55},
    appearance:{gap:10},preferenceColumns:{flexDirection:compact?'column':'row',gap:dense?16:24,marginTop:8},preferenceActions:{width:compact?'100%':'42%',gap:dense?4:6},preferenceButton:{paddingVertical:dense?8:10,paddingHorizontal:12,borderWidth:2,borderColor:colors.muted,borderRadius:radius,backgroundColor:colors.surface},headerFocus:{borderColor:colors.focus},preferenceText:{fontFamily,color:colors.text,fontSize:14},preferenceEditor:{flex:1,gap:8},jsonInput:{height:106,padding:12,textAlignVertical:'top',color:colors.text,backgroundColor:colors.surface,borderColor:colors.muted,borderWidth:1,borderRadius:radius,fontSize:12},exportScroll:{height:130,maxHeight:130,backgroundColor:colors.surface,borderRadius:radius},export:{color:colors.text,padding:12,fontSize:11,lineHeight:14},
  });
};
