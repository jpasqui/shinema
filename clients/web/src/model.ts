import {parseCatalog,parseProgress,resumeAt} from '../../../packages/contracts/index.ts';
import type {Catalog,Progress} from '../../../packages/contracts/index.ts';
export {resumeAt};
export type Cache={catalog:Catalog|null;progress:Record<string,Progress>;pending:Record<string,Progress>};
export const empty=():Cache=>({catalog:null,progress:{},pending:{}});
export function recover(value:string|null):Cache {
  try{
    if(!value)return empty();const parsed=JSON.parse(value);const catalog=parsed.catalog===null?null:parseCatalog(parsed.catalog);
    const progress:Record<string,Progress>={};const pending:Record<string,Progress>={};
    for(const [key,item] of Object.entries(parsed.progress??{}))if(/^[a-f0-9]{64}$/.test(key)){const valid=parseProgress(item);if(valid)progress[key]=valid;}
    for(const [key,item] of Object.entries(parsed.pending??{}))if(/^[a-f0-9]{64}$/.test(key)){const valid=parseProgress(item);if(valid)pending[key]=valid;}
    return {catalog,progress,pending};
  }catch{return empty();}
}
export class NavigationGuard {
  private version=0;
  next():number{return ++this.version;}
  current(version:number):boolean{return version===this.version;}
}
export class Queue {
  private tail=Promise.resolve();
  run(job:()=>Promise<void>):Promise<void>{this.tail=this.tail.catch(()=>{}).then(job);return this.tail;}
}
export function progressValue(position:number,duration:number):Progress|null {
  try{return parseProgress({positionSeconds:Math.max(0,Math.min(position,duration)),durationSeconds:duration});}catch{return null;}
}
export async function loadPlaybackProgress(id:string,io:{read:()=>Cache;revision:(id:string)=>number;load:(id:string)=>Promise<unknown>}):Promise<Progress|null>{
  const initialState=io.read();const pendingAtStart=initialState.pending[id];
  const initial=pendingAtStart??initialState.progress[id]??null;const revisionAtStart=io.revision(id);
  try{
    const remote=parseProgress(await io.load(id));const current=io.read();
    if(current.pending[id])return current.pending[id];
    // A PUT acknowledgement clears pending; it must not erase a local write's
    // priority over a GET that was already in flight before that acknowledgement.
    if(pendingAtStart || io.revision(id)!==revisionAtStart)return current.progress[id]??initial;
    return remote??current.progress[id]??initial;
  }
  catch{return io.read().pending[id]??io.read().progress[id]??initial;}
}
export async function synchronize(id:string,value:Progress,io:{read:()=>Cache;write:(cache:Cache)=>void;persist:()=>void;send:(id:string,value:Progress)=>Promise<void>}):Promise<void> {
  // Every local save creates a fresh, immutable pending object. Its identity
  // owns the request: equal positions can still belong to different writes.
  // Skip writes superseded while waiting in the serialized queue.
  if(io.read().pending[id]!==value)return;
  await io.send(id,value);const current=io.read();
  if(current.pending[id]!==value)return;
  const next={...current.pending};delete next[id];io.write({...current,pending:next});io.persist();
}
/** Muting is applied before assigning the media source or requesting playback. */
export function initializeSilentVideo(node:{muted:boolean;defaultMuted:boolean;volume:number;src:string},source:string):void {
  node.defaultMuted=true;node.muted=true;node.volume=0;node.src=source;
}
export function clock(value:number):string {
  const seconds=Math.max(0,Math.floor(value));const minutes=Math.floor(seconds/60);return seconds>=3600?`${Math.floor(seconds/3600)}:${String(minutes%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${minutes}:${String(seconds%60).padStart(2,'0')}`;
}
