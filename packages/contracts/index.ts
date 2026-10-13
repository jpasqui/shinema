export type Media = {id:string; title:string; container:string; sizeBytes:number; streamPath:string};
export type Catalog = {apiVersion:1; items:Media[]};
export type Progress = {positionSeconds:number; durationSeconds:number};
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object' && value!==null;
export function parseCatalog(value:unknown):Catalog {
  if(!object(value) || value.apiVersion!==1 || !Array.isArray(value.items) || value.items.length>500)throw new Error('Unsupported catalog');
  const ids=new Set<string>();
  for(const item of value.items){
    if(!object(item) || typeof item.id!=='string' || !/^[a-f0-9]{64}$/.test(item.id) || ids.has(item.id)
      || typeof item.title!=='string' || item.title.length>200 || typeof item.container!=='string'
      || !['mp4','m4v','mkv','webm'].includes(item.container) || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes)<0
      || item.streamPath!==`/api/media/${item.id}/stream`)throw new Error('Invalid catalog item');
    ids.add(item.id);
  }
  return value as Catalog;
}
export function parseProgress(value:unknown):Progress|null {
  if(value===null)return null;
  if(!object(value) || typeof value.positionSeconds!=='number' || typeof value.durationSeconds!=='number'
    || !Number.isFinite(value.positionSeconds) || !Number.isFinite(value.durationSeconds)
    || value.positionSeconds<0 || value.durationSeconds<=0 || value.durationSeconds>604800
    || value.positionSeconds>value.durationSeconds)throw new Error('Invalid progress');
  return {positionSeconds:value.positionSeconds,durationSeconds:value.durationSeconds};
}
export function serverOrigin(value:string):string {
  const url=new URL(value.trim());
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname))throw new Error('Use an HTTPS server origin without credentials or a path');
  return url.origin;
}
export function resumeAt(progress:Progress|null,duration:number):number {
  return progress && progress.positionSeconds<duration-3 ? Math.min(progress.positionSeconds,duration) : 0;
}
