import {parseCatalog,parseProgress,serverOrigin} from '../../../packages/contracts/index.ts';
import type {Catalog,Progress} from '../../../packages/contracts/index.ts';
export type Stored={origin:string;catalog:Catalog|null;progress:Record<string,Progress>;pending:Record<string,Progress>};
export const fresh=():Stored=>({origin:'https://localhost:8787',catalog:null,progress:{},pending:{}});
export function recover(raw:string):Stored {
  try{
    const value=JSON.parse(raw);const origin=serverOrigin(value.origin);const catalog=value.catalog===null?null:parseCatalog(value.catalog);
    const progress:Record<string,Progress>={};const pending:Record<string,Progress>={};
    for(const [id,p] of Object.entries(value.progress??{}))if(/^[a-f0-9]{64}$/.test(id)){const parsed=parseProgress(p);if(parsed)progress[id]=parsed;}
    for(const [id,p] of Object.entries(value.pending??{}))if(/^[a-f0-9]{64}$/.test(id)){const parsed=parseProgress(p);if(parsed)pending[id]=parsed;}
    return {origin,catalog,progress,pending};
  }catch{return fresh();}
}
export function move(cursor:number,direction:number,count:number):number {
  return count===0?0:Math.max(0,Math.min(count-1,cursor+direction));
}
export const pageFor=(cursor:number)=>Math.floor(cursor/8);
