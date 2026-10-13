import {mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const output=resolve('.local/media');await mkdir(output,{recursive:true});
const ffmpeg=process.env.FFMPEG??'ffmpeg';
for(const [name,frequency] of [['Generated_Orbit',440],['Generated_Horizon',660],['Generated_Pulse',880]]){
 const target=join(output,name+'.mp4');
 try{await access(target);console.log(name+' already exists; leaving it unchanged.');continue;}catch{}
 const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000`,'-t','60','-c:v','libx264','-preset','fast','-crf','25','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-b:a','128k','-movflags','+faststart',target],{stdio:'inherit'});
 if(result.error || result.status!==0)throw new Error('FFmpeg fixture generation failed; install recognized FFmpeg or set FFMPEG to its executable.');
 console.log('Generated '+name+' (60 seconds, H.264/AAC).');
}
