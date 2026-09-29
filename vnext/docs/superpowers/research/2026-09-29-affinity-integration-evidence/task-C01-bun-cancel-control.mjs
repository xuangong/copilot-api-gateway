import { serve, version } from "bun"
let sent = 0, cancelled = false, aborted = false, timer
const server = serve({hostname:"127.0.0.1",port:0,fetch: request => {
 request.signal.addEventListener("abort",()=>{aborted=true;clearInterval(timer)},{once:true})
 return new Response(new ReadableStream({start(c){timer=setInterval(()=>{try{sent++;c.enqueue(new Uint8Array(128*1024));if(sent===40){clearInterval(timer);c.close()}}catch{clearInterval(timer)}},25)},cancel(){cancelled=true;clearInterval(timer)}}))
}})
try {
 const response = await fetch(`http://127.0.0.1:${server.port}`)
 const reader = response.body.getReader()
 await reader.read()
 await reader.cancel()
 for(let i=0;i<50 && !cancelled && !aborted;i++)await new Promise(r=>setTimeout(r,10))
 console.log(JSON.stringify({sent,cancelled,aborted,bun:version}))
}finally{clearInterval(timer);server.stop(true)}
