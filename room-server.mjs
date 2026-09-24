import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const secret=()=>randomBytes(24).toString('base64url');
export function createRoomServer({ttl=45000,maxRooms=128,now=Date.now}={}){
 const rooms=new Map(),sessions=new Map(),attempts=new Map();
 const code=()=>{let c;do{c=randomBytes(6).toString('hex').toUpperCase();}while(rooms.has(c));return c;};
 const members=r=>[...r.members.values()].map(p=>({id:p.id,name:p.name,host:p===r.host}));
 const enqueue=(p,e)=>{if(e.type==='input')p.events=p.events.filter(x=>x.type!=='input'||x.id!==e.id);if(p.events.length<128)p.events.push(e);};
 function close(r){rooms.delete(r.code);for(const p of r.members.values()){sessions.delete(p.token);}r.members.clear();}
 function leave(p){const r=p.room;if(p===r.host){close(r);return;}r.members.delete(p.id);sessions.delete(p.token);enqueue(r.host,{type:'left',id:p.id});}
 const sweep=setInterval(()=>{for(const r of rooms.values()){if(now()-r.host.seen>ttl){close(r);continue;}for(const p of r.members.values())if(p!==r.host&&now()-p.seen>ttl)leave(p);}for(const [ip,a] of attempts)if(now()-a.start>60000)attempts.delete(ip);},1000);sweep.unref();
 function participant(r,name,host=false){const p={id:host?'host':secret(),token:secret(),name:String(name||'Survivor').replace(/[<>\x00-\x1f]/g,'').slice(0,24),room:r,events:[],seen:now(),rateStart:now(),rate:0};r.members.set(p.id,p);sessions.set(p.token,p);return p;}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status,data)=>{let body=Buffer.from(JSON.stringify(data));res.setHeader('Content-Type','application/json');if(body.length>2048&&/gzip/.test(req.headers['accept-encoding']||'')){body=gzipSync(body);res.setHeader('Content-Encoding','gzip');}res.writeHead(status);res.end(body);};
  try{
   if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
   const url=new URL(req.url,'http://room.local'),route=url.pathname;
   if(route==='/health'){send(200,{ok:true,protocol:1});return;}
   if(!route.startsWith('/api/')){if(route!=='/'&&route!=='/index.html'){send(404,{error:'Not found.'});return;}const body=await readFile(new URL('../dist/index.html',import.meta.url));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(body);return;}
   if(req.method!=='POST'&&route!=='/api/poll')throw Error('Use POST for room actions.');
   let data={};if(req.method==='POST'){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024){send(413,{error:'Packet too large.'});return;}chunks.push(chunk);}data=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
   if(route==='/api/create'||route==='/api/join'){
    const ip=req.socket.remoteAddress;let a=attempts.get(ip);if(!a||now()-a.start>60000){a={start:now(),count:0};attempts.set(ip,a);}if(++a.count>30){send(429,{error:'Too many room attempts. Wait one minute.'});return;}
    let r,p;if(route==='/api/create'){if(rooms.size>=maxRooms){send(503,{error:'Room service is full.'});return;}r={code:code(),members:new Map(),snapshot:null,seq:0};p=participant(r,data.name,true);r.host=p;rooms.set(r.code,r);}else{r=rooms.get(String(data.code||'').trim().toUpperCase());if(!r){send(404,{error:'Room code not found or expired.'});return;}if(r.members.size>=4){send(409,{error:'This world is full (4/4).'});return;}p=participant(r,data.name);enqueue(r.host,{type:'joined',id:p.id,name:p.name});}
    send(200,{id:p.id,token:p.token,code:r.code,members:members(r),protocol:1});return;
   }
   const p=sessions.get((req.headers.authorization||'').replace(/^Bearer /,''));if(!p){send(401,{error:'Room closed or connection expired. Rejoin using a current code.'});return;}p.seen=now();const r=p.room;
   if(route==='/api/poll'){const events=p.events.splice(0);send(200,{events,members:members(r),code:r.code,seq:r.seq,...(p!==r.host&&Number(url.searchParams.get('since'))!==r.seq?{snapshot:r.snapshot}:{})});return;}
   if(now()-p.rateStart>1000){p.rateStart=now();p.rate=0;}if(++p.rate>35){send(429,{error:'Too many actions.'});return;}
   if(route==='/api/leave'){leave(p);send(200,{ok:true});return;}
   if(route==='/api/rotate'){if(p!==r.host)throw Error('Only the host can generate a code.');rooms.delete(r.code);r.code=code();rooms.set(r.code,r);send(200,{code:r.code});return;}
   if(route==='/api/snapshot'){if(p!==r.host)throw Error('Only the host can update the world.');if(!data.snapshot||typeof data.snapshot!=='object')throw Error('Invalid world snapshot.');r.snapshot=data.snapshot;r.seq++;send(200,{ok:true});return;}
   if(route==='/api/input'){if(p===r.host)throw Error('Host input is local.');enqueue(r.host,{type:'input',id:p.id,input:{x:Math.max(-1,Math.min(1,Number(data.x)||0)),z:Math.max(-1,Math.min(1,Number(data.z)||0)),sprint:!!data.sprint,throttle:Math.max(-1,Math.min(1,Number(data.throttle)||0)),steer:Math.max(-1,Math.min(1,Number(data.steer)||0)),brake:!!data.brake}});send(200,{ok:true});return;}
   if(route==='/api/action'){if(p===r.host)throw Error('Host actions are local.');if(typeof data.action!=='string'||data.action.length>40||JSON.stringify(data.data||{}).length>1200)throw Error('Invalid action.');enqueue(r.host,{type:'action',id:p.id,action:data.action,data:data.data||{}});send(200,{ok:true});return;}
   if(route==='/api/reply'){if(p!==r.host)throw Error('Only the host can reply.');const guest=r.members.get(data.id);if(guest&&guest!==p)enqueue(guest,{type:'reply',reply:data.reply});send(200,{ok:true});return;}
   send(404,{error:'Unknown room action.'});
  }catch(e){if(!res.writableEnded)send(400,{error:e.message||'Invalid request.'});}
 });
 server.on('close',()=>clearInterval(sweep));server.requestTimeout=15000;server.headersTimeout=10000;return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT)||4174;createRoomServer().listen(port,'0.0.0.0',()=>console.log('APOCAPHILIPPINES room service and game on port '+port));}
