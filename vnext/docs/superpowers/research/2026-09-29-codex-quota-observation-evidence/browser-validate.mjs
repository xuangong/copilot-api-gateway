import { chromium } from "/Users/zhangxian/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs"
import assert from "node:assert/strict"
import { readFileSync,writeFileSync } from "node:fs"
import { dirname } from "node:path"
const connection=process.env.C09_CONNECTION;assert(connection)
const {port,token,sourceRoot}=JSON.parse(readFileSync(connection,"utf8")),base=`http://127.0.0.1:${port}`,out=dirname(connection)
const browser=await chromium.launch({headless:true})
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 await context.addCookies([{name:"session_token",value:token,domain:"127.0.0.1",path:"/"}])
 const page=await context.newPage(),pageErrors=[]
 page.on("pageerror",error=>pageErrors.push(error.message))
 await page.goto(`${base}/dashboard#upstreams`);await page.waitForLoadState("networkidle")
 const panel=page.getByTestId("codex-quota-panel");await panel.waitFor();await page.waitForLoadState("networkidle")
 const text=await panel.innerText();writeFileSync(`${out}/panel.txt`,text)
 assert(/stale/i.test(text),text);assert(/unknown/i.test(text),text);assert(text.includes("0%"),text);assert(text.includes("42%"),text)
 await page.screenshot({path:`${out}/quota.png`,fullPage:true})
 const before=await (await context.request.get(`${base}/__verify`)).json()
 const reread=page.waitForResponse(response=>response.url().endsWith("/codex/quota"))
 await page.getByTestId("codex-quota-reload").click();assert.equal((await reread).status(),200);await page.waitForLoadState("networkidle")
 const after=await (await context.request.get(`${base}/__verify`)).json()
 assert.equal(after.quotaReads,before.quotaReads+1);assert.equal(after.credentialCalls,0);assert.equal(after.outboundCalls,0);assert.equal(after.modelReads,before.modelReads);assert(after.unchanged)
 assert.deepEqual(pageErrors,[])
 const result={passed:true,sourceRoot,checks:["stale-observation","unknown-versus-zero","fresh-value","quota-reread-only","no-credential-refresh","no-outbound","no-model-reload","no-state-write","no-page-errors"],facts:after,out}
 writeFileSync(`${out}/result.json`,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result))
}finally{await browser.close()}
