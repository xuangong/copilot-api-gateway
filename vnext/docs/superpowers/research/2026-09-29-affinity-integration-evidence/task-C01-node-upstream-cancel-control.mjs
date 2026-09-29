import { spawn } from "node:child_process"
let lines = "", records = []
const child = spawn("node", ["--input-type=module", "-e", `
import {createServer} from 'node:http';
const server=createServer((req,res)=>{let sent=0;res.writeHead(200,{'content-type':'application/octet-stream'});const timer=setInterval(()=>{sent++;res.write(Buffer.alloc(128*1024));if(sent===40){clearInterval(timer);res.end()}},25);res.on('close',()=>{clearInterval(timer);console.log(JSON.stringify({closed:true,sent,finished:res.writableEnded}))})});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));`], {stdio:["ignore","pipe","inherit"]})
child.stdout.on("data",chunk=>{lines+=chunk.toString();let at;while((at=lines.indexOf("\n"))>=0){records.push(JSON.parse(lines.slice(0,at)));lines=lines.slice(at+1)}})
try {
 for(let i=0;i<100&&!records.length;i++)await new Promise(r=>setTimeout(r,10))
 const controller=new AbortController()
 const response=await fetch(`http://127.0.0.1:${records[0].port}`,{signal:controller.signal})
 const reader=response.body.getReader();await reader.read()
 if(process.env.EXPLICIT_ABORT)controller.abort()
 await reader.cancel().catch(()=>{})
 for(let i=0;i<60&&!records.some(r=>r.closed);i++)await new Promise(r=>setTimeout(r,10))
 console.log(JSON.stringify({runtime:{bun:process.versions.bun,node:process.versions.node},explicitAbort:!!process.env.EXPLICIT_ABORT,records}))
}finally{child.kill("SIGTERM")}
