const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), results = [];
fs.mkdirSync(path.join(root, '.test-results'), { recursive: true });
const wav = Buffer.alloc(44 + 16000 * 60);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const source = 'data:audio/wav;base64,' + wav.toString('base64');
const fixture = `<!doctype html><html><body><h1>Compatibility fixture</h1>
<video id="video" style="width:640px;height:360px" src="${source}"></video>
<button id="play" aria-label="Play">Play</button><button id="pause" aria-label="Pause">Pause</button>
<div id="editor" contenteditable="true" role="textbox"></div>
<div id="custom" tabindex="0"></div><div id="lexical" data-lexical-editor tabindex="0"></div>
<div id="slate" data-slate-editor tabindex="0"></div><div id="shadow"></div>
<script>
window.keys = [];
document.addEventListener('keydown', e => keys.push({ code: e.code, prevented: e.defaultPrevented }));
play.onclick = () => video.play().catch(() => {}); pause.onclick = () => video.pause();
window.nextEpisode = async () => {
  const next = document.createElement('video'); next.id = 'video'; next.src = video.src;
  next.style = video.style.cssText; video.replaceWith(next); await next.play();
};
</script></body></html>`;

(async () => {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(root, '.test-results/compatibility-profile-')), {
    channel: process.env.ANCHOR_BROWSER ? undefined : 'chromium', executablePath: process.env.ANCHOR_BROWSER || undefined,
    headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--autoplay-policy=no-user-gesture-required']
  });
  context.setDefaultTimeout(8000);
  await context.route(/^https?:\/\//, route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => serialized(initialize));
  await worker.evaluate(() => {
    globalThis.testIcons = {};
    const original = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = async data => { testIcons[data.tabId] = data.path; return original(data); };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const tabId = () => worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, page.url());
  const state = async () => worker.evaluate(id => status(id), await tabId());
  const wait = async (fn, message) => {
    for (let i = 0; i < 80; i++) { if (await fn()) return; await page.waitForTimeout(50); }
    assert.fail(message);
  };
  const load = async (url, enabled = true) => {
    await page.goto(url); await page.waitForFunction(() => video.readyState >= 2);
    await wait(async () => (await state()).frames.some(f => f.enabled === enabled), 'Configuration did not reach page');
  };
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
    catch (e) { results.push({ name, passed: false, error: e.stack }); console.error('FAIL', name, e.stack); }
  };
  const configure = async patch => {
    await worker.evaluate(async ({ origin, patch }) => {
      const { sites = {} } = await chrome.storage.local.get('sites');
      sites[origin] = { ...PauseKeeperSettings.forOrigin(origin, sites), ...patch };
      await chrome.storage.local.set({ sites });
    }, { origin: new URL(page.url()).origin, patch });
    // Broadcast completion confirms the page has applied the saved preferences.
    await worker.evaluate(id => broadcast(id, { type: 'PK_REFRESH' }), await tabId());
  };
  try {
    await test('Upgrade resets Hulu transition flags and LinkedIn opt-in, preserving unrelated preferences', async () => {
      const stored = await worker.evaluate(async () => serialized(async () => {
        await chrome.storage.local.set({ compatibilityVersion: 0, sites: {
          'https://www.hulu.com': { enabled: true, strictPause: true, blockAutoplay: true, fixKeyboard: false },
          'https://www.linkedin.com': { enabled: true, fixKeyboard: false },
          'https://stream.test': { enabled: true, strictPause: true, blockAutoplay: true }
        } });
        await chrome.storage.session.set({ tabLocks: { 91: true, 92: true, 93: true }, tabOrigins: {
          91: 'https://www.hulu.com', 92: 'https://www.linkedin.com', 93: 'https://stream.test'
        } });
        compatibilityReady = null; await migrateCompatibility();
        return chrome.storage.local.get(['sites', 'compatibilityVersion']);
      }));
      assert.equal(stored.compatibilityVersion, 1);
      assert.deepEqual(stored.sites['https://www.hulu.com'], { enabled: true, strictPause: false, blockAutoplay: false, fixKeyboard: false });
      assert.deepEqual(stored.sites['https://www.linkedin.com'], { enabled: false, fixKeyboard: false });
      assert.deepEqual(stored.sites['https://stream.test'], { enabled: true, strictPause: true, blockAutoplay: true });
    });
    await test('Upgrade removes old Hulu and LinkedIn holds without clearing other sites', async () => {
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.session.get('tabLocks')).tabLocks), { 93: true });
    });
    await test('LinkedIn exemption covers its subdomains without matching lookalike sites', async () => {
      const values = await worker.evaluate(() => ['https://linkedin.com', 'https://www.linkedin.com', 'https://sub.linkedin.com',
        'https://notlinkedin.com', 'https://linkedin.com.example', 'https://stream.test'].map(o => PauseKeeperSettings.forOrigin(o).enabled));
      assert.deepEqual(values, [false, false, false, true, true, true]);
    });
    await test('LinkedIn spaces and K reach a custom feed editor without pausing its video', async () => {
      await load('https://www.linkedin.com/feed/', false);
      await page.evaluate(() => video.play()); await page.focus('#custom'); await page.keyboard.press('Space'); await page.keyboard.press('k');
      assert.deepEqual(await page.evaluate(() => keys), [{ code: 'Space', prevented: false }, { code: 'KeyK', prevented: false }]);
      assert.equal(await page.evaluate(() => video.paused), false); assert.equal((await state()).locked, false);
    });
    await test('LinkedIn protection-off toolbar icon stays gray', async () => {
      assert.equal(await worker.evaluate(id => testIcons[id]?.[16], await tabId()), 'icons/16-gray.png');
      assert.match(await worker.evaluate(id => chrome.action.getTitle({ tabId: id }), await tabId()), /protection off/);
    });
    await test('LinkedIn explicit opt-in preserves spaces in its rich text editor', async () => {
      await configure({ enabled: true, fixKeyboard: true });
      await wait(async () => (await state()).available, 'Opt-in failed');
      await page.focus('#editor'); await page.keyboard.type('hello k world');
      assert.equal(await page.locator('#editor').innerText(), 'hello k world');
      assert.equal((await state()).locked, false);
    });
    await test('Lexical and Slate editor wrappers retain Space, K and arrow shortcuts', async () => {
      for (const id of ['lexical', 'slate']) {
        await page.evaluate(() => keys.length = 0); await page.focus('#' + id);
        for (const key of ['Space', 'k', 'ArrowRight']) await page.keyboard.press(key);
        assert.deepEqual(await page.evaluate(() => keys.map(k => k.code)), ['Space', 'KeyK', 'ArrowRight']);
        assert.equal((await state()).locked, false);
      }
    });
    await test('Focused shadow-root editors preserve typing while protection is enabled', async () => {
      await page.evaluate(() => { const r = shadow.attachShadow({ mode: 'open' }); r.innerHTML = '<div contenteditable="true" id="inside"></div>'; r.querySelector('div').focus(); });
      await page.keyboard.type('shadow k space');
      assert.equal(await page.locator('#inside').innerText(), 'shadow k space'); assert.equal((await state()).locked, false);
    });
    await test('Document editing mode receives ordinary playback shortcuts', async () => {
      await page.evaluate(() => { document.designMode = 'on'; document.activeElement?.blur(); keys.length = 0; });
      await page.keyboard.press('Space'); await page.keyboard.press('k');
      assert.deepEqual(await page.evaluate(() => keys.map(k => k.code)), ['Space', 'KeyK']);
      assert.equal((await state()).locked, false); await page.evaluate(() => document.designMode = 'off');
    });
    await test('Migrated Hulu allows a natural end followed by automatic next-episode playback', async () => {
      await load('https://www.hulu.com/watch/episode');
      await page.evaluate(async () => { video.currentTime = video.duration - 0.12; await video.play(); });
      await page.waitForFunction(() => video.ended);
      assert.equal((await state()).locked, false);
      await page.evaluate(() => nextEpisode()); await page.waitForFunction(() => !video.paused);
      assert.equal((await state()).locked, false);
    });
    await test('Migrated Hulu allows a programmatic pause and source transition', async () => {
      await page.evaluate(() => video.pause());
      assert.equal((await state()).locked, false);
      await page.evaluate(() => nextEpisode()); await page.waitForFunction(() => !video.paused);
      assert.equal((await state()).locked, false);
    });
    await test('First settings request after upgrade cannot restore an obsolete Hulu hold', async () => {
      await worker.evaluate(async id => serialized(async () => {
        const { tabLocks = {}, tabOrigins = {} } = await chrome.storage.session.get(['tabLocks', 'tabOrigins']);
        tabLocks[id] = true; tabOrigins[id] = 'https://www.hulu.com';
        await chrome.storage.session.set({ tabLocks, tabOrigins });
        compatibilityReady = null;
        await chrome.storage.local.set({ compatibilityVersion: 0 });
      }), await tabId());
      await page.reload(); await page.waitForFunction(() => video.readyState >= 2);
      await wait(async () => (await state()).frames.some(f => f.enabled), 'Reload configuration missing');
      assert.equal((await state()).locked, false);
      assert.equal((await state()).frames[0].locked, false);
      await page.evaluate(() => video.play());
    });
    await test('Hulu deliberate pause still rejects an unwanted restart', async () => {
      await page.click('#pause'); await wait(async () => (await state()).locked, 'Deliberate pause not held');
      assert.equal(await page.evaluate(() => video.play().then(() => 'played', e => e.name)), 'NotAllowedError');
      await page.click('#play'); await page.waitForFunction(() => !video.paused);
      await wait(async () => !(await state()).locked, 'Play did not release hold');
    });
    await test('Explicit next-episode blocking still works after compatibility migration', async () => {
      await configure({ blockAutoplay: true });
      await page.evaluate(() => video.currentTime = video.duration - 0.12);
      await page.waitForFunction(() => video.ended);
      await wait(async () => (await state()).locked, 'Optional autoplay blocking failed');
      assert.equal(await page.evaluate(() => nextEpisode().then(() => 'played', e => e.name)), 'NotAllowedError');
    });
    await test('Later user opt-ins survive repeated migration with its in-memory cache reset', async () => {
      const stored = await worker.evaluate(async () => serialized(async () => {
        const { sites } = await chrome.storage.local.get('sites'); sites['https://www.hulu.com'].strictPause = true;
        sites['https://www.linkedin.com'].enabled = true;
        await chrome.storage.local.set({ sites }); compatibilityReady = null; await migrateCompatibility();
        return chrome.storage.local.get('sites');
      }));
      assert.equal(stored.sites['https://www.hulu.com'].strictPause, true);
      assert.equal(stored.sites['https://www.hulu.com'].blockAutoplay, true);
      assert.equal(stored.sites['https://www.linkedin.com'].enabled, true);
    });
    await test('Compatibility fixtures have no uncaught player errors', async () => assert.deepEqual(errors, []));
  } finally {
    fs.writeFileSync(path.join(root, '.test-results', process.env.ANCHOR_BROWSER ? 'brave-compatibility-results.json' : 'compatibility-results.json'),
      JSON.stringify({ engine: context.browser().version(), note: 'Intercepted LinkedIn and Hulu fixtures; no production service UI.', tests: results }, null, 2));
    await context.close();
  }
  if (results.some(r => !r.passed)) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
