import {createServer as httpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,open,mkdir,rename,lstat,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {parseCatalog,parseProgress} from '../packages/contracts/index.ts';

export function byteRange(value,size){
 if(!Number.isSafeInteger(size)||size<=0)throw new Error('Empty media');
 if(value===undefined)return {start:0,end:size-1,status:200};
 if(typeof value!=='string'||!/^bytes=\d*-\d*$/.test(value)||value==='bytes=-')throw new Error('Invalid range');
 const [left,right]=value.slice(6).split('-');let start,end;
 if(!left){const suffix=Number(right);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new Error('Invalid suffix');start=Math.max(0,size-suffix);end=size-1;}
 else{start=Number(left);const requestedEnd=right?Number(right):size-1;if(!Number.isSafeInteger(requestedEnd))throw new Error('Invalid end');end=Math.min(requestedEnd,size-1);}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new Error('Unsatisfiable range');
 return {start,end,status:206};
}
export function validateConfig(config){
 if(!config||!/^([A-Za-z_][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9.:-]*)$/.test(config.destination??''))throw new Error('Use an existing SSH user@host');
 for(const field of ['keyFile','knownHostsFile','stateDirectory'])if(typeof config[field]!=='string'||!isAbsolute(config[field]))throw new Error('Use absolute local configuration paths');
 if(config.stateDirectory.startsWith('//')||config.stateDirectory.startsWith(String.fromCharCode(92,92)))throw new Error('State must stay on the local computer');
 if(typeof config.remoteRoot!=='string'||!config.remoteRoot.startsWith('/')||config.remoteRoot.includes('\0'))throw new Error('Use an absolute remote media directory');
 if(config.port!==undefined && config.port!==8787)throw new Error('Preview is fixed to loopback port 8787');
 for(const field of ['maxItems','maxBytes'])if(config[field]!==undefined&&(!Number.isSafeInteger(config[field])||config[field]<1))throw new Error('Use positive integer preview limits');
 return {...config,maxItems:Math.max(1,Math.min(12,config.maxItems??3)),maxBytes:Math.max(1,Math.min(67108864,config.maxBytes??67108864))};
}
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export async function sshReader(config){
 for(const field of ['keyFile','knownHostsFile'])if(!(await lstat(config[field])).isFile())throw new Error('Existing SSH files must be regular files');
 const source=await readFile(new URL('./ssh-media-reader.py',import.meta.url),'utf8');const children=new Set();
 const namespace=createHash('sha256').update(config.destination+'\0'+config.remoteRoot).digest('hex');
 const run=options=>{
  const payload=Buffer.from(JSON.stringify({root:config.remoteRoot,...options,namespace}),'utf8').toString('base64');
  const command='python3 -c '+quote(source)+' '+quote(payload);
  const child=spawn(config.sshExecutable??'ssh',['-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=5','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-o','UserKnownHostsFile='+config.knownHostsFile,'-i',config.keyFile,config.destination,command],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  children.add(child);child.once('close',()=>children.delete(child));child.stderr.on('data',()=>{});return child;
 };
 const collect=options=>new Promise((done,reject)=>{
  const child=run(options);let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('SSH read timed out'));},10000);
  child.stdout.on('data',data=>{output+=data.toString('utf8');if(output.length>1048576){child.kill();reject(new Error('SSH metadata exceeded limit'));}});
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Existing strict-host-key SSH access failed'));try{done(JSON.parse(output));}catch{reject(new Error('Invalid SSH metadata'));}});
 });
 return {catalog:()=>collect({operation:'catalog',maxItems:config.maxItems,maxBytes:config.maxBytes}),
  stat:entry=>collect({operation:'stat',name:entry.name,sizeBytes:entry.sizeBytes,modifiedNs:entry.modifiedNs}),
  stream:(entry,start,length)=>run({operation:'stream',name:entry.name,sizeBytes:entry.sizeBytes,modifiedNs:entry.modifiedNs,start,length}),
  close:async()=>{await Promise.all([...children].map(child=>new Promise(done=>{child.once('close',done);child.kill();})));},
 };
}
export async function startPreview({reader,stateDirectory,port=8787}){
 if(port!==8787)throw new Error('Use preview loopback port 8787');
 await mkdir(stateDirectory,{recursive:true});const directoryInfo=await lstat(stateDirectory);if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw new Error('Use a private local state directory');
 const raw=await reader.catalog();const entries=new Map(raw.map(entry=>[entry.id,entry]));
 const catalog=parseCatalog({apiVersion:1,items:raw.map(({name,modifiedNs,...media})=>media)});
 const progressPath=join(stateDirectory,'progress.json');let progress={};
 try{const info=await lstat(progressPath);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1)throw new Error('Unsafe local progress file');const value=JSON.parse(await readFile(progressPath,'utf8'));for(const [id,item] of Object.entries(value))if(entries.has(id))progress[id]=parseProgress(item);}catch(error){if(error.code!=='ENOENT')throw error;}
 let tail=Promise.resolve();const thumbnails=new Map();const children=new Set();const sockets=new Set();
 const evidence={catalogReadAt:new Date().toISOString(),streamRequests:[],progressWrites:0};
 const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
 const server=httpServer(async(request,response)=>{
  try{
   const path=request.url?.split('?')[0];
   if(request.method==='GET'&&path==='/health')return json(response,200,{status:'ok',apiVersion:1});
   if(request.method==='GET'&&path==='/api/catalog')return json(response,200,{...catalog,items:catalog.items.map(media=>thumbnails.has(media.id)?{...media,posterPath:'/api/media/'+media.id+'/poster'}:media)});
   const match=/^\/api\/media\/([a-f0-9]{64})\/(stream|progress|poster)$/.exec(path??'');const entry=match&&entries.get(match[1]);if(!entry)return json(response,404,{error:'Unknown media'});
   const id=entry.id;
   if(match[2]==='poster'&&request.method==='GET'){const bytes=thumbnails.get(id);if(!bytes)return json(response,404,{error:'Poster unavailable'});response.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store'});return response.end(bytes);}
   if(match[2]==='progress'){
    if(request.method==='GET')return json(response,200,progress[id]??null);
    if(request.method!=='PUT')return json(response,405,{error:'Use GET or PUT'});
    const parts=[];let bytes=0;for await(const part of request){bytes+=part.length;if(bytes>1024)return json(response,413,{error:'Progress too large'});parts.push(part);}
    const rawProgress=JSON.parse(Buffer.concat(parts).toString('utf8'));
    if(!rawProgress||Object.keys(rawProgress).sort().join(',')!=='durationSeconds,positionSeconds')return json(response,400,{error:'Invalid progress'});
    const value=parseProgress(rawProgress);if(!value)return json(response,400,{error:'Invalid progress'});
    const write=tail.catch(()=>{}).then(async()=>{
      const next={...progress,[id]:value};const temporary=progressPath+'.tmp';
      // Exclusive creation refuses existing files, symlinks and hardlinks.
      const file=await open(temporary,'wx',0o600);
      try{await file.writeFile(JSON.stringify(next),'utf8');await file.sync();}catch(error){await file.close();await unlink(temporary);throw error;}
      await file.close();try{await rename(temporary,progressPath);}catch(error){await unlink(temporary);throw error;}
      progress=next;evidence.progressWrites++;
    });tail=write;await write;response.writeHead(204);return response.end();
   }
   if(match[2]!=='stream'||!['GET','HEAD'].includes(request.method))return json(response,405,{error:'Unsupported method'});
   let range;try{range=byteRange(request.headers.range,entry.sizeBytes);}catch{response.writeHead(416,{'Content-Range':'bytes */'+entry.sizeBytes});return response.end();}
   await reader.stat(entry);const length=range.end-range.start+1;
   const headers={'Content-Type':entry.container==='mkv'?'video/x-matroska':entry.container==='webm'?'video/webm':'video/mp4','Content-Length':length,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
   if(range.status===206)headers['Content-Range']=`bytes ${range.start}-${range.end}/${entry.sizeBytes}`;
   if(request.method==='HEAD'){response.writeHead(range.status,headers);return response.end();}
   if(children.size>=4)return json(response,503,{error:'Preview stream limit reached'});
   const child=reader.stream(entry,range.start,length);children.add(child);let received=0;
   const record={id,start:range.start,end:range.end,bytes:0,finished:false,startedAt:new Date().toISOString()};evidence.streamRequests.push(record);
   child.stdout.on('data',data=>{received+=data.length;record.bytes=received;});
   child.once('error',()=>response.destroy());child.once('close',code=>{children.delete(child);record.finished=code===0&&received===length;if(!record.finished)response.destroy();});
   response.once('close',()=>{if(received<length)child.kill();});response.writeHead(range.status,headers);child.stdout.pipe(response);
  }catch{if(!response.headersSent)json(response,400,{error:'Read-only preview request failed'});else response.destroy();}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
 return {catalog,entries,evidence,setThumbnail:(id,bytes)=>{if(!entries.has(id)||bytes.length>1048576)throw new Error('Invalid thumbnail');thumbnails.set(id,bytes);},
  close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(done=>server.close(done));await reader.close();await tail.catch(()=>{});},
 };
}
export async function createThumbnails(preview,{stateDirectory,ffmpeg='ffmpeg'}){
 const directory=join(stateDirectory,'thumbnails');await mkdir(directory,{recursive:true});
 if(!(await lstat(directory)).isDirectory()||(await lstat(directory)).isSymbolicLink())throw new Error('Use a private local thumbnail directory');
 for(const item of preview.catalog.items){
  const path=join(directory,item.id+'.jpg');
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1)continue;}catch(error){if(error.code!=='ENOENT')throw error;}
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss','1','-i','http://127.0.0.1:8787'+item.streamPath,'-frames:v','1','-vf','scale=640:-2','-q:v','4',path],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',()=>{});
  try{await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Thumbnail timeout'));},20000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code===0?done():reject(new Error('Thumbnail decode failed'));});});preview.setThumbnail(item.id,await readFile(path));}catch{/* Unsupported thumbnails retain the clearly generic artwork fallback. */}
 }
}
