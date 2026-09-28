import { chromium } from '/Users/zhangxian/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const d=JSON.parse(fs.readFileSync(new URL('./connection.json',import.meta.url)))
const base=`http://127.0.0.1:${d.port}`
const browser=await chromium.launch({headless:true})
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 await context.addCookies([{name:'session_token',value:d.token,domain:'127.0.0.1',path:'/'}])
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(base+'/dashboard#upstreams');await page.waitForLoadState('networkidle')
 const prior=await (await context.request.get(base+'/__fixture/control')).json()
 assert.ok(prior.calls>0)
 const cached=page.waitForResponse(r=>r.url().endsWith('/api/upstreams/up_fixture_custom/models'))
 await page.getByRole('button',{name:'Edit',exact:true}).click()
 assert.equal((await cached).status(),200)
 await page.locator('select[multiple] option').first().waitFor({state:'attached'})
 const options=await page.locator('select[multiple] option').allTextContents()
 assert.ok(options.some(x=>x.includes('fixture-model')))
 const opened=await (await context.request.get(base+'/__fixture/control')).json()
 assert.equal(opened.calls,prior.calls)
 await context.request.post(base+'/__fixture/control',{data:{fail:true}})
 const refreshed=page.waitForResponse(r=>r.url().includes('/api/upstreams/up_fixture_custom/models?refresh=1'))
 await page.getByRole('button',{name:'Refresh',exact:true}).click()
 assert.equal((await refreshed).status(),502)
 await page.getByText(/failed to list models:/).waitFor()
 assert.deepEqual(await page.locator('select[multiple] option').allTextContents(),options)
 await page.screenshot({path:new URL('./failed-refresh-retains-catalog.png',import.meta.url).pathname,fullPage:true})
 await page.getByPlaceholder('https://api.deepseek.com/v1').fill('http://127.0.0.1:1/changed')
 assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isDisabled(),true)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({cachedOpenWithoutDiscovery:true,failedRefreshPreservesModels:true,unsavedDiscoveryChangeDisablesRefresh:true,pageErrors:errors,initialProviderCalls:prior.calls},null,2))
} finally {await browser.close()}
