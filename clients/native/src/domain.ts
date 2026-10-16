import {parseCatalog,parseProgress,serverOrigin} from '../../../packages/contracts/index.ts';
import type {Catalog,Progress} from '../../../packages/contracts/index.ts';
import {parseLibraries} from '../../../packages/contracts/index.ts';
import {selectedLibrary,scopedCatalog} from './libraries.ts';
import type {LibraryNavigation} from './libraries.ts';
export type Stored=LibraryNavigation & {origin:string;catalog:Catalog|null;progress:Record<string,Progress>;pending:Record<string,Progress>};
export const fresh=():Stored=>({origin:'https://localhost:8787',catalog:null,progress:{},pending:{},libraries:null,selectedLibraryId:null});
export function recover(raw:string):Stored {
  try{
    const value=JSON.parse(raw);const origin=serverOrigin(value.origin);let catalog:Catalog|null=null;
    try{if(value.catalog!==null)catalog=parseCatalog(value.catalog);}catch{}
    const progress:Record<string,Progress>={};const pending:Record<string,Progress>={};
    for(const [id,p] of Object.entries(value.progress??{}))if(/^[a-f0-9]{64}$/.test(id)){try{const parsed=parseProgress(p);if(parsed)progress[id]=parsed;}catch{}}
    for(const [id,p] of Object.entries(value.pending??{}))if(/^[a-f0-9]{64}$/.test(id)){try{const parsed=parseProgress(p);if(parsed)pending[id]=parsed;}catch{}}
    let libraries=null;let selectedLibraryId=null;
    if(value.libraries!==undefined && value.libraries!==null){
      try{
        libraries=parseLibraries(value.libraries);
        const preferred=typeof value.selectedLibraryId==='string'?value.selectedLibraryId:null;
        selectedLibraryId=selectedLibrary(libraries,preferred);
        // A renamed library keeps its ID. Removed/hidden selections must not
        // relabel another scope's cached titles while the server is offline.
        if(selectedLibraryId!==preferred || selectedLibraryId===null)catalog={apiVersion:1,items:[]};
        else if(catalog)catalog=scopedCatalog(catalog,selectedLibraryId);
      }catch{libraries=null;selectedLibraryId=null;catalog=null;}
    }
    return {origin,catalog,progress,pending,libraries,selectedLibraryId};
  }catch{return fresh();}
}
export function move(cursor:number,direction:number,count:number):number {
  return count===0?0:Math.max(0,Math.min(count-1,cursor+direction));
}
export const pageFor=(cursor:number)=>Math.floor(cursor/8);
