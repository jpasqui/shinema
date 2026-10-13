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
export async function synchronize(id:string,value:Progress,io:{read:()=>Cache;write:(cache:Cache)=>void;persist:()=>void;send:(id:string,value:Progress)=>Promise<void>}):Promise<void> {
  await io.send(id,value);const current=io.read();const pending=current.pending[id];
  if(pending?.positionSeconds!==value.positionSeconds || pending?.durationSeconds!==value.durationSeconds)return;
  const next={...current.pending};delete next[id];io.write({...current,pending:next});io.persist();
}
/** Muting is applied before assigning the media source or requesting playback. */
export function initializeSilentVideo(node:{muted:boolean;defaultMuted:boolean;volume:number;src:string},source:string):void {
  node.defaultMuted=true;node.muted=true;node.volume=0;node.src=source;
}
export function clock(value:number):string {
  const seconds=Math.max(0,Math.floor(value));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
}
