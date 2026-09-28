import { chromium } from '/Users/zhangxian/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const d=JSON.parse(fs.readFileSync(new URL('./connection.json',import.meta.url)))
const base=`http://127.0.0.1:${d.port}`
const browser=await chromium.launch({headless:true})
try {
 const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']})
 await context.addCookies([{name:'session_token',value:d.token,domain:'127.0.0.1',path:'/'}])
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(base+'/dashboard#keys');await page.waitForLoadState('networkidle')
 await page.getByText('Synthetic configuration key',{exact:true}).click()
 await page.locator('code.language-bash').first().waitFor()
 const initial=await page.locator('code.language-bash').first().textContent()
 assert.ok(!initial.includes('ANTHROPIC_DEFAULT_'))
 const choose=async(label,value)=>{
  await page.getByRole('button',{name:label,exact:true}).click()
  await page.locator('[data-select-open="true"]').getByRole('button',{name:value,exact:true}).click()
 }
 await choose('Default Opus model','claude-opus-4.6')
 await choose('Default Sonnet model','claude-sonnet-4.6')
 await choose('Default Haiku model','claude-haiku-4.5')
 const shell=await page.locator('code.language-bash').first().textContent()
 for(const tier of ['OPUS','SONNET','HAIKU']) assert.ok(shell.includes('ANTHROPIC_DEFAULT_'+tier+'_MODEL'))
 const initialMain=initial.split('\n').find(x=>x.startsWith('export ANTHROPIC_MODEL='))
 assert.ok(shell.split('\n').includes(initialMain))
 await page.getByRole('button',{name:'settings.json',exact:true}).click()
 const settings=JSON.parse(await page.locator('code.language-json').first().textContent())
 assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL,'claude-opus-4.6')
 assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'claude-sonnet-4.6')
 assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,'claude-haiku-4.5')
 await page.screenshot({path:new URL('./independent-cli-tiers.png',import.meta.url).pathname,fullPage:true})
 await choose('Default Sonnet model','Use Claude Code default')
 const cleared=JSON.parse(await page.locator('code.language-json').first().textContent())
 assert.ok(!('ANTHROPIC_DEFAULT_SONNET_MODEL' in cleared.env))
 assert.equal(cleared.env.ANTHROPIC_DEFAULT_OPUS_MODEL,'claude-opus-4.6')
 await page.getByText('Synthetic second key',{exact:true}).click()
 await page.locator('code.language-bash').first().waitFor()
 assert.ok(!(await page.locator('code.language-bash').first().textContent()).includes('ANTHROPIC_DEFAULT_'))
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({initialOptionalTiersOmitted:true,threeIndependentTiers:true,mainUnchanged:true,clearOnePreservesOthers:true,keyChangeResetsTiers:true,pageErrors:errors},null,2))
} finally {await browser.close()}
