const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),results=[];
fs.mkdirSync(path.join(root,'.test-results'),{recursive:true});
const wav=Buffer.alloc(44+16000*60);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
const source='data:audio/wav;base64,'+wav.toString('base64');
(async()=>{
 const browser=await chromium.launch({channel:process.env.ANCHOR_BROWSER?undefined:'chromium',executablePath:process.env.ANCHOR_BROWSER||undefined,headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const test=async(name,fn,withoutSession=false)=>{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.addInitScript(withoutSession=>{
    if(withoutSession)Object.defineProperty(navigator,'mediaSession',{value:undefined});
    window.originalPlay=HTMLMediaElement.prototype.play;
    window.listenerCalls=0;
    const nativeAdd=EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener=function(...args){if(this instanceof HTMLMediaElement)listenerCalls++;return nativeAdd.apply(this,args);};
    window.siteKeyUps=0;window.addEventListener('keyup',()=>siteKeyUps++);
   },withoutSession);
   await page.route('https://hardening.test/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html><body><video id="video" controls style="width:640px;height:360px" src="${source}"></video></body></html>`}));
   await page.goto('https://hardening.test/player');await page.waitForFunction(()=>video.readyState>=2);
   await page.addScriptTag({path:path.join(root,'main.js')});
   await page.evaluate(()=>document.dispatchEvent(new CustomEvent('pause-keeper:command',{detail:JSON.stringify({command:'configure',config:{enabled:true}})})));
   await fn(page);
   assert.deepEqual(errors,[]);
   results.push({name,passed:true});console.log('PASS',name);
  }catch(e){results.push({name,passed:false,error:e.stack});console.error('FAIL',name,e.stack);}
  finally{await page.close();}
 };
 try{
  await test('Malformed null and primitive commands do not throw',async page=>{
   await page.evaluate(()=>{for(const value of [null,42,'bad',true])document.dispatchEvent(new CustomEvent('pause-keeper:command',{detail:JSON.stringify(value)}));});
   await page.waitForTimeout(30);
  });
  await test('A later explicit pause cancels a stale native Play gesture',async page=>{
   await page.locator('#video').click({position:{x:320,y:160}});
   await page.evaluate(()=>document.dispatchEvent(new CustomEvent('pause-keeper:command',{detail:JSON.stringify({command:'lock'})})));
   assert.equal(await page.evaluate(()=>video.play().then(()=>false,e=>e.name)),'NotAllowedError');
   assert.equal(await page.evaluate(()=>video.paused),true);
  });
  await test('Reattached media keeps only one set of listener registrations',async page=>{
   const initial=await page.evaluate(()=>listenerCalls);
   await page.evaluate(()=>{window.savedVideo=video;video.remove();});
   await page.waitForTimeout(1150);
   await page.evaluate(()=>document.body.append(savedVideo));
   await page.waitForTimeout(40);
   assert.equal(await page.evaluate(()=>listenerCalls),initial);
  });
  await test('Closed shadow roots regain protection after host reattachment',async page=>{
   await page.evaluate(src=>{
    window.host=document.createElement('div');document.body.append(host);
    window.closedRoot=host.attachShadow({mode:'closed'});
    const old=document.createElement('video');old.src=src;closedRoot.append(old);
    document.dispatchEvent(new CustomEvent('pause-keeper:command',{detail:JSON.stringify({command:'lock'})}));host.remove();
   },source);
   await page.waitForTimeout(1150);
   await page.evaluate(src=>{document.body.append(host);window.lateVideo=document.createElement('video');lateVideo.src=src;closedRoot.append(lateVideo);},source);
   await page.waitForFunction(()=>lateVideo.readyState>=2);
   await page.evaluate(()=>originalPlay.call(lateVideo).catch(()=>{}));
   await page.waitForTimeout(120);
   assert.equal(await page.evaluate(()=>lateVideo.paused),true);
  });
  await test('Media Session state repairs a site overwrite while held paused',async page=>{
   await page.evaluate(()=>{document.dispatchEvent(new CustomEvent('pause-keeper:command',{detail:JSON.stringify({command:'lock'})}));navigator.mediaSession.playbackState='playing';});
   await page.waitForFunction(()=>navigator.mediaSession.playbackState==='paused');
  });
  await test('Media-key keyup uses the same identity as keydown',async page=>{
   const cdp=await page.context().newCDPSession(page);
   await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'MediaPause',code:'Unidentified',windowsVirtualKeyCode:179});
   await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'MediaPause',code:'Unidentified',windowsVirtualKeyCode:179});
   assert.equal(await page.evaluate(()=>siteKeyUps),0);
   await cdp.detach();
  });
  await test('Pause protection works when Media Session is unavailable',async page=>{
   await page.evaluate(()=>document.dispatchEvent(new CustomEvent('pause-keeper:command',{detail:JSON.stringify({command:'lock'})})));
   assert.equal(await page.evaluate(()=>video.play().then(()=>false,e=>e.name)),'NotAllowedError');
  },true);
 }finally{
  fs.writeFileSync(path.join(root,'.test-results',process.env.ANCHOR_BROWSER?'brave-hardening-results.json':'hardening-results.json'),JSON.stringify({engine:browser.version(),tests:results},null,2));
  await browser.close();
 }
 if(results.some(r=>!r.passed))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
