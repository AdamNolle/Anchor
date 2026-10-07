require('node:fs').mkdirSync(require('node:path').resolve(__dirname,'../.test-results'),{recursive:true});
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const extension = root;
const results = [];
const wav = Buffer.alloc(44 + 8000*2*60);
wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
const source = 'data:audio/wav;base64,' + wav.toString('base64');
const fixture = `<!doctype html><html><body><h1>Streaming-player fixture</h1><video id="video" style="width:640px;height:360px" preload="auto"></video><button id="toggle" aria-label="Play">Play</button><input id="search" placeholder="Search"><div id="edit" contenteditable="true">Text</div><script>
window.count = { siteKeys: 0, siteUps: 0 };
const video = document.querySelector('video'); video.src = ${JSON.stringify(source)};
const toggle = document.querySelector('#toggle');
function paint(){toggle.setAttribute('aria-label', video.paused ? 'Play' : 'Pause'); toggle.textContent = video.paused ? 'Play' : 'Pause';}
video.addEventListener('play', paint); video.addEventListener('pause', paint);
toggle.addEventListener('click',()=>{if(video.paused) video.play().catch(()=>{});else video.pause();});
document.addEventListener('keydown', e => { if(e.target.matches('input,[contenteditable]')) return; if(e.code==='Space'||e.code==='KeyK') { count.siteKeys++; if(video.paused) video.play().catch(()=>{});else video.pause(); }});
document.addEventListener('keyup', e => { if(e.target.matches('input,[contenteditable]')) return; if(e.code==='Space'||e.code==='KeyK') count.siteUps++; });
window.addEventListener('keydown',e=>{if((e.code==='Space'||e.code==='KeyK')&&!e.target.matches('input,[contenteditable]')) count.windowKeys=(count.windowKeys||0)+1;},true);
</script></body></html>`;

(async () => {
  const profile = fs.mkdtempSync(path.join(root, '.test-results/test-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.ANCHOR_BROWSER ? undefined : 'chromium', executablePath: process.env.ANCHOR_BROWSER || undefined, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1000, height: 800 }
  });
  context.setDefaultTimeout(8000);
  await context.route('https://*.hulu.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  await worker.evaluate(async()=>{await chrome.storage.local.clear();await chrome.storage.session.clear();});
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const state = async () => (await worker.evaluate(id => status(id), await tabId()));
  const tabId = async () => worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.hulu.com/*' }))[0].id);
  const paused = async () => page.locator('#video').evaluate(v => v.paused);
  const waitPaused = async expected => page.waitForFunction(x => document.querySelector('#video').paused === x, expected);
  const waitLock = async expected => { for (let i=0;i<40;i++) { if ((await state()).locked===expected) return; await new Promise(r=>setTimeout(r,50)); } assert.fail(`lock did not become ${expected}`); };
  async function load() {
    await page.goto('https://www.hulu.com/watch/test');
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    for (let i=0;i<40;i++) { if ((await state()).frames.some(f => f.enabled)) return; await new Promise(r=>setTimeout(r,50)); }
    assert.fail('Engine did not initialize');
  }
  const config = async patch => {
    await worker.evaluate(async patch => {
      const {sites={}} = await chrome.storage.local.get('sites');
      sites['https://www.hulu.com'] = { ...PauseKeeperSettings.forOrigin('https://www.hulu.com', sites), ...patch };
      await chrome.storage.local.set({sites});
    }, patch);
    await page.waitForTimeout(120);
  };
  async function test(name, fn) {
    try { await fn(); results.push({name,passed:true}); console.log('PASS',name); }
    catch(e){results.push({name,passed:false,error:e.stack}); console.error('FAIL',name,e.stack);}
  }
  try {
    await load();
    await test('Hulu default content scripts and bridge initialize', async () => { const s=await state();assert.equal(s.media,1);assert.equal(s.frames[0].enabled,true); });
    await test('Explicit Play starts media', async()=> { await page.click('#toggle');await waitPaused(false); await waitLock(false); });
    await test('Click Pause holds against repeated scripted restarts', async()=> {
      await page.click('#toggle');await waitPaused(true);await waitLock(true);
      const attempts=await page.evaluate(async()=>{const out=[];for(let i=0;i<4;i++){try{await video.play();out.push('played');}catch(e){out.push(e.name);}}return out;});
      assert.deepEqual(attempts,['NotAllowedError','NotAllowedError','NotAllowedError','NotAllowedError']);assert.equal(await paused(),true);
    });
    await test('Explicit Play releases the pause latch',async()=>{await page.click('#toggle');await waitPaused(false);await waitLock(false);});
    await test('Space overrides duplicate website keydown and keyup handlers',async()=> {
      await page.click('h1');await page.keyboard.press('Space');await waitPaused(true);await waitLock(true);
      assert.deepEqual(await page.evaluate(()=>count),{siteKeys:0,siteUps:0});
      await page.keyboard.press('Space');await waitPaused(false);await waitLock(false);
    });
    await test('Synthetic page clicks cannot release a user pause',async()=>{
      await page.keyboard.press('k');await waitPaused(true);await waitLock(true);
      await page.evaluate(()=>toggle.click());assert.equal(await paused(),true);assert.equal((await state()).locked,true);
      await page.keyboard.press('k');await waitPaused(false);await waitLock(false);
    });
    await test('K pauses and resumes without repeat-toggle',async()=> {
      await page.keyboard.down('k');await waitPaused(true);await page.keyboard.down('k');assert.equal(await paused(),true);await page.keyboard.up('k');
      await page.keyboard.press('k');await waitPaused(false);await waitLock(false);
    });
    await test('Typing and editing do not engage extension keyboard handling',async()=>{
      await page.focus('#search');await page.keyboard.type('look here');assert.equal(await page.inputValue('#search'),'look here');
      await page.focus('#edit');await page.keyboard.type('k test');assert.match(await page.textContent('#edit'),/k test/);await page.click('h1');
    });
    await test('Seek controls preserve a pause latch',async()=>{
      await page.keyboard.press('k');await waitPaused(true);await waitLock(true);
      await page.evaluate(()=>video.currentTime=20);await page.keyboard.press('ArrowRight');assert.equal(Math.round(await page.evaluate(()=>video.currentTime)),30);assert.equal(await paused(),true);
      await page.keyboard.press('ArrowLeft');assert.equal(Math.round(await page.evaluate(()=>video.currentTime)),20);
    });
    await test('Replacement player is held paused',async()=>{
      const result=await page.evaluate(async src=>{const fresh=document.createElement('video');fresh.id='replacement';fresh.src=src;fresh.style='width:640px;height:360px';video.replaceWith(fresh);try{await fresh.play();return 'played';}catch(e){return e.name;}},source);
      assert.equal(result,'NotAllowedError');assert.equal(await page.locator('#replacement').evaluate(v=>v.paused),true);
    });
    await test('Reload retains the pause latch in session storage',async()=>{await load();await waitLock(true);assert.equal(await paused(),true);assert.equal(await page.evaluate(()=>video.play().then(()=>false,e=>e.name)),'NotAllowedError');});
    await test('Popup Resume releases the latch and plays the primary media',async()=>{
      const id=await tabId();await worker.evaluate(id=>resume(id),id);await waitPaused(false);await waitLock(false);
    });
    await test('Normal programmatic pause and recovery are allowed by default',async()=>{
      await page.waitForTimeout(900);await page.evaluate(()=>video.pause());await waitLock(false);await page.evaluate(()=>video.play());await waitPaused(false);
    });
    await test('Strict pause option catches programmatic pause',async()=>{
      await config({strictPause:true});await page.evaluate(()=>video.pause());await waitLock(true);
      assert.equal(await page.evaluate(()=>video.play().then(()=>false,e=>e.name)),'NotAllowedError');
      await config({strictPause:false});await worker.evaluate(id=>resume(id),await tabId());await waitPaused(false);
    });
    await test('Autoplay protection starts a fresh page held paused',async()=>{
      await config({blockAutoplay:true});await load();await waitLock(true);assert.equal(await paused(),true);
      await page.click('#toggle');await waitPaused(false);await waitLock(false);
    });
    await test('Ending media blocks the next autoplay attempt',async()=>{
      await page.evaluate(()=>video.currentTime=video.duration-.1);await waitPaused(true);await waitLock(true);
      assert.equal(await page.evaluate(()=>video.play().then(()=>false,e=>e.name)),'NotAllowedError');
      await config({blockAutoplay:false});await worker.evaluate(id=>resume(id),await tabId());
    });
    await test('Pause state propagates to newly created permitted iframe',async()=>{
      await worker.evaluate(id=>setLock(id,true),await tabId());
      await page.evaluate(()=>{const f=document.createElement('iframe');f.src='https://player.hulu.com/embedded';document.body.append(f);});
      const frame=await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('player.hulu.com')}).catch(()=>page.frames().find(f=>f.url().includes('player.hulu.com')));
      await frame.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await page.waitForTimeout(300);
      assert.equal(await frame.evaluate(()=>video.play().then(()=>false,e=>e.name)),'NotAllowedError');
      assert.equal(await frame.evaluate(()=>video.paused),true);
    });
    await test('Disabling protection restores normal playback',async()=>{
      await config({enabled:false});await worker.evaluate(id=>setLock(id,false),await tabId());await page.evaluate(()=>video.play());await waitPaused(false);
    });
    await test('Popup renders controls and settings without errors',async()=>{
      const pop=await context.newPage();await page.bringToFront();await pop.goto(`chrome-extension://${extensionId}/popup.html`);await pop.waitForTimeout(300);
      assert.equal(await pop.title(),'Anchor');assert.equal(await pop.locator('#error').isVisible(),false,await pop.textContent('#error'));
      assert.equal(await pop.textContent('#hostname'),'www.hulu.com');
      await pop.check('#enabled');await page.waitForTimeout(200);assert.equal(await pop.locator('#error').isVisible(),false);
      await pop.click('#lock');await waitPaused(true);await waitLock(true);
      await pop.click('#play');await waitPaused(false);await waitLock(false);
      await pop.screenshot({path:path.join(root,'.test-results/popup.png')});await pop.close();
    });
    await test('Native controls cannot bypass the pause latch; popup Resume works',async()=>{
      await config({enabled:true});
      await page.locator('iframe').evaluate(f=>f.remove());
      await page.evaluate(()=>video.controls=true);await worker.evaluate(id=>setLock(id,true),await tabId());
      await page.locator('video').hover();const box=await page.locator('video').boundingBox();
      await page.mouse.click(box.x+30,box.y+box.height-30);
      await page.waitForTimeout(500);await waitPaused(true);await waitLock(true);
      await worker.evaluate(id=>resume(id),await tabId());await waitPaused(false);await waitLock(false);
      await page.evaluate(()=>video.controls=false);
    });
    await test('Native autoplay on a replacement player is re-paused',async()=>{
      await worker.evaluate(id=>setLock(id,true),await tabId());
      await page.evaluate(src=>{const v=document.createElement('video');v.id='autoplay';v.autoplay=true;v.src=src;document.body.append(v);},source);
      await page.locator('#autoplay').evaluate(v=>new Promise(r=>{if(v.readyState>=2)r();else v.addEventListener('loadeddata',r,{once:true});}));
      await page.waitForTimeout(250);assert.equal(await page.locator('#autoplay').evaluate(v=>v.paused),true);
      await page.evaluate(()=>document.querySelector('#autoplay').remove());await worker.evaluate(id=>resume(id),await tabId());await waitPaused(false);
    });
    await test('Open shadow-root player is held and can resume explicitly',async()=>{
      await config({enabled:true});
      await worker.evaluate(id=>setLock(id,true),await tabId());
      const result=await page.evaluate(async src=>{const host=document.createElement('div');host.id='shadow';document.body.append(host);const root=host.attachShadow({mode:'open'});const player=document.createElement('video');player.src=src;root.append(player);try{await player.play();return 'played';}catch(e){return e.name;}},source);
      assert.equal(result,'NotAllowedError');await page.evaluate(()=>document.querySelector('#shadow').remove());
      await worker.evaluate(id=>resume(id),await tabId());await waitPaused(false);
    });
    await test('Pause-when-hidden option latches until explicit resume',async()=>{
      await config({pauseWhenHidden:true});
      await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
      await waitPaused(true);await waitLock(true);
      await page.evaluate(()=>delete document.hidden);await config({pauseWhenHidden:false});
      await worker.evaluate(id=>resume(id),await tabId());await waitPaused(false);
    });
    await test('No uncaught player errors',async()=>assert.deepEqual(pageErrors,[]));
  } finally {
    fs.writeFileSync(path.join(root,process.env.ANCHOR_BROWSER?'.test-results/brave-test-results.json':'.test-results/test-results.json'),JSON.stringify({engine:(process.env.ANCHOR_BROWSER?'Brave / Chromium ':'Chromium ')+context.browser().version(),tests:results},null,2));
    await context.close();
  }
  if (results.some(r=>!r.passed)) process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
