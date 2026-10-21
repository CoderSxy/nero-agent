import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createEgressProxy } from '../src/mastra/sandbox/network/proxy';
test('proxy denies internal targets for HTTP and CONNECT',async(t)=>{
 const proxy=createEgressProxy(); proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
 t.after(()=>proxy.close()); const port=(proxy.address() as net.AddressInfo).port;
 const status=await new Promise<number>((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:'http://127.0.0.1/'},res=>{res.resume();resolve(res.statusCode!)});req.on('error',reject)});
 assert.equal(status,403);
 const socket=net.connect(port,'127.0.0.1'); t.after(()=>socket.destroy()); socket.write('CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n');
 const [chunk]=await once(socket,'data'); assert.match(chunk.toString(),/403/);
});
test('proxy connects to checked IP and preserves HTTP hostname and CONNECT pre-read bytes',async(t)=>{
 const upstream=http.createServer((req,res)=>{assert.equal(req.headers.host,'example.com');res.end('ok')});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
 const upstreamPort=(upstream.address() as net.AddressInfo).port;
 const proxy=createEgressProxy({resolve:async(host,port)=>({address:'127.0.0.1',family:4,hostname:host,port:upstreamPort as 80})});proxy.listen(0,'127.0.0.1');await once(proxy,'listening');t.after(()=>proxy.close());
 const proxyPort=(proxy.address() as net.AddressInfo).port;
 const body=await new Promise<string>((resolve,reject)=>{http.get({host:'127.0.0.1',port:proxyPort,path:'http://example.com/'},res=>{let s='';res.on('data',d=>s+=d);res.on('end',()=>resolve(s))}).on('error',reject)});assert.equal(body,'ok');
 const socket=net.connect(proxyPort,'127.0.0.1');t.after(()=>socket.destroy());
 socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nGET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
 let data='';await new Promise<void>((resolve,reject)=>{socket.on('data',d=>data+=d);socket.on('end',resolve);socket.on('error',reject)});assert.match(data,/200 Connection Established/);assert.match(data,/ok/);
});
