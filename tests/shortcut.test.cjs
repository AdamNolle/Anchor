require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-results'),{recursive:true});
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),extension=root;
 const context=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(root,'.test-results/shortcut-profile-')),{channel:process.env.ANCHOR_BROWSER?undefined:'chromium',executablePath:process.env.ANCHOR_BROWSER,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=worker.url().split('/')[2];
  const commands=await worker.evaluate(()=>chrome.commands.getAll());
  assert.equal(commands.find(c=>c.name==='toggle-pause-lock').shortcut,'');
  console.log('PASS quick toggle is optional without a reserved default');
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(()=>document.querySelector('#shortcut').textContent.startsWith('Set a quick toggle'));
  console.log('PASS popup explains how to set an unassigned shortcut');
  await page.evaluate(()=>{chrome.commands.getAll=async()=>[{name:'toggle-pause-lock',shortcut:'Alt+Shift+P'}];});
  await page.evaluate('(()=>{'+fs.readFileSync(path.join(extension,'popup.js'),'utf8')+'})();');
  await page.waitForFunction(()=>document.querySelector('#shortcut').textContent.startsWith('Set a quick toggle'));
  console.log('PASS popup warns to reassign the conflicting old shortcut');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
