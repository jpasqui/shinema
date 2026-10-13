import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const directory=(relative:string)=>fileURLToPath(new URL(relative,import.meta.url));
const api=new URL(process.env.SHINEMA_API_ORIGIN??'http://127.0.0.1:8787');
if(api.protocol!=='http:' || api.hostname!=='127.0.0.1' || api.username || api.password || api.pathname!=='/' || api.search || api.hash)throw new Error('Development proxy target must be a host-loopback origin');
const delay=Math.min(2000,Math.max(0,Number(process.env.SHINEMA_DEMO_DELAY_MS)||0));
export default defineConfig({
  plugins:[react(),{name:'bounded-demo-loading',configureServer(server){if(delay)server.middlewares.use((request,_response,next)=>{if(request.url==='/api/catalog')setTimeout(next,delay);else next();});}}],
  server:{host:'127.0.0.1',port:5173,strictPort:true,open:false,cors:false,
    allowedHosts:['127.0.0.1','localhost'],
    fs:{strict:true,allow:[directory('.'),directory('../../packages/contracts'),directory('../../packages/design-tokens')],deny:['**/.git/**','**/.local/**','**/.private/**','**/.env*','**/*.pem','**/*.key','**/*.p12','**/*.jks']},
    proxy:{'/api':{target:api.origin,changeOrigin:false,ws:false}},
  },
  preview:{host:'127.0.0.1',port:5173,strictPort:true,open:false},
});
