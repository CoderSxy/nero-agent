import http from 'node:http';
import net from 'node:net';
import { resolvePublicTarget, type PublicTarget } from './policy.js';
const HOP=new Set(['connection','proxy-connection','proxy-authorization','proxy-authenticate','keep-alive','te','trailer','transfer-encoding','upgrade']);
function headers(input:http.IncomingHttpHeaders){
 const blocked=new Set([...HOP,...String(input.connection??'').toLowerCase().split(',').map(s=>s.trim())]);
 return Object.fromEntries(Object.entries(input).filter(([key])=>!blocked.has(key.toLowerCase())));
}
export function createEgressProxy(deps:{resolve?:(host:string,port:number)=>Promise<PublicTarget>}={}){
 const resolve=deps.resolve??resolvePublicTarget;
 const server=http.createServer(async(req,res)=>{
  let target:PublicTarget;let url:URL;
  try{
   url=new URL(req.url??'');
   if(url.protocol!=='http:' || url.username || url.password || req.method==='CONNECT') throw new Error('Invalid HTTP target');
   target=await resolve(url.hostname,Number(url.port||80));
  }catch{res.writeHead(403,{'connection':'close'}).end('Public HTTP/HTTPS targets only');return;}
  const upstream=http.request({host:target.address,port:target.port,family:4,path:url.pathname+url.search,method:req.method,headers:{...headers(req.headers),host:url.host},agent:false},reply=>{
   res.writeHead(reply.statusCode??502,headers(reply.headers));reply.pipe(res);reply.on('error',()=>res.destroy());
  });
  upstream.setTimeout(30000,()=>upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Upstream unavailable')});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });
 server.headersTimeout=15000;server.requestTimeout=60000;
 server.on('connect',async(req,socket,head)=>{
  socket.on('error',()=>socket.destroy());(socket as net.Socket).setTimeout(30000,()=>socket.destroy());
  let target:PublicTarget;
  try{
   const match=/^([a-zA-Z0-9.-]+):(80|443)$/.exec(req.url??'');
   if(!match)throw new Error('Invalid CONNECT target');
   target=await resolve(match[1]!,Number(match[2]));
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  if(socket.destroyed)return;
  const upstream=net.connect({host:target.address,port:target.port,family:4});
  upstream.setTimeout(30000,()=>upstream.destroy());
  upstream.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket)});
  upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
 });
 server.on('clientError',(_err,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
 return server;
}
