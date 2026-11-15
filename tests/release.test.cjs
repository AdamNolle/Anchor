/* Release regressions: ignored sites, autoplay on streaming / news / social pages,
 * page-scoped holds, next episodes, per-player holds and keyboard behavior. */
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

// A streaming watch page: full-size player, overlay controls, a control bar on top
// of the video, a seek bar, and in-app navigation to the next title.
const streaming = `<!doctype html><html><head><style>
body{margin:0} #player{position:relative;width:960px;height:540px} video{width:960px;height:540px;display:block}
#overlay{position:absolute;left:0;top:0;right:0;bottom:72px} #progress{position:absolute;left:0;right:0;bottom:60px;height:12px;background:#555}
#bar{position:absolute;left:0;right:0;bottom:0;height:60px;display:flex;gap:4px;background:#222}
</style></head><body>
<div id="player" data-testid="play-pause-container">
  <video id="video" src="${source}"></video>
  <div id="overlay"></div><div id="progress" class="progress-bar"></div>
  <div id="bar"><button id="toggle" aria-label="Play">P</button><button id="skip">Skip intro</button>
  <button id="next" aria-label="Next episode">Next</button><button id="lecture" aria-label="Lecture">&#9654;</button></div>
</div><div style="height:2000px"></div>
<script>
window.log = [];
const video = () => document.getElementById('video');
const paint = () => toggle.setAttribute('aria-label', video().paused ? 'Play' : 'Pause');
document.addEventListener('play', paint, true); document.addEventListener('pause', paint, true);
const play = () => video().play().catch(e => log.push(e.name));
toggle.onclick = () => video().paused ? play() : video().pause();
skip.onclick = () => { video().currentTime += 20; };
overlay.onclick = () => video().paused ? play() : video().pause();
progress.onclick = () => { video().currentTime = 5; play(); };
lecture.onclick = play;
const fresh = () => { const v = document.createElement('video'); v.id = 'video'; v.src = video().src; video().replaceWith(v); return v; };
next.onclick = () => fresh().play().catch(e => log.push(e.name));
window.spaNext = p => { history.pushState({}, '', p); return fresh().play().then(() => 'played', e => e.name); };
window.restart = () => video().play().then(() => 'played', e => e.name);
</script></body></html>`;

// A news article (and stand-in social feed) with independent muted autoplay clips.
const news = `<!doctype html><html><body style="margin:0"><h1>Article</h1>
<div class="card"><video id="v1" muted autoplay loop src="${source}" style="width:320px;height:180px"></video><button aria-label="Pause">II</button></div>
<p style="height:300px">Story text</p>
<div class="card"><video id="v2" muted autoplay loop src="${source}" style="width:320px;height:180px"></video><button aria-label="Pause">II</button></div>
<div style="height:3000px"></div>
<script>
for (const card of document.querySelectorAll('.card')) {
  const v = card.querySelector('video'), b = card.querySelector('button');
  const paint = () => b.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
  v.addEventListener('play', paint); v.addEventListener('pause', paint);
  b.onclick = () => v.paused ? v.play().catch(() => {}) : v.pause();
}
window.restart = id => document.getElementById(id).play().then(() => 'played', e => e.name);
</script></body></html>`;

(async () => {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(root, '.test-results/release-profile-')), {
    channel: process.env.ANCHOR_BROWSER ? undefined : 'chromium', executablePath: process.env.ANCHOR_BROWSER || undefined,
    headless: true, viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--autoplay-policy=no-user-gesture-required']
  });
  context.setDefaultTimeout(8000);
  await context.route(/^https?:\/\//, route => {
    const url = new URL(route.request().url());
    const body = /^(news|feed)\.|x\.com$|instagram\.com$|tiktok\.com$|facebook\.com$/.test(url.hostname) ? news : streaming;
    return route.fulfill({ contentType: 'text/html', body });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => serialized(initialize));
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const tabId = () => worker.evaluate(async () => (await chrome.tabs.query({})).find(t => /^https?:/.test(t.url) && t.active)?.id);
  const state = async () => worker.evaluate(id => status(id), await tabId());
  const wait = async (fn, message) => {
    for (let i = 0; i < 80; i++) { if (await fn()) return; await page.waitForTimeout(50); }
    assert.fail(message);
  };
  const engine = () => page.evaluate(() => !!window.__pauseKeeperEngine);
  const load = async (url, ready = () => document.querySelector('video')?.readyState >= 2) => {
    await page.goto(url); await page.waitForFunction(ready);
    await wait(async () => (await state()).frames.some(f => f.enabled), 'Anchor did not configure the page');
  };
  const held = async expected => wait(async () => (await state()).locked === expected, `hold did not become ${expected}`);
  const playing = sel => page.locator(sel).evaluate(v => !v.paused);
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
    catch (e) { results.push({ name, passed: false, error: e.stack }); console.error('FAIL', name, e.stack); }
  };
  const prefs = patch => worker.evaluate(async ({ origin, patch }) => {
    const { sites = {} } = await chrome.storage.local.get('sites');
    sites[origin] = { ...PauseKeeperSettings.prefs(sites[origin]), ...patch };
    await chrome.storage.local.set({ sites });
  }, { origin: new URL(page.url()).origin, patch });
  try {
    await test('Settings helpers normalize ignored sites and identify titles', async () => {
      const out = await worker.evaluate(() => {
        const S = PauseKeeperSettings;
        return {
          hosts: ['https://www.Example.COM/watch?v=1', '*.news.example.org', 'localhost:8096', '192.168.1.20', 'http://[::1]:8080/', 'not a site', 'ftp://x.com', '', 'a..b', '-bad.com'].map(h => S.normalizeHost(h)),
          ignored: ['https://example.com', 'https://video.example.com', 'https://notexample.com', 'http://192.168.1.20:8920'].map(u => S.isIgnored(u, ['example.com', '192.168.1.20'])),
          patterns: S.excludePatterns(['x.com', '192.168.1.20', 'localhost']),
          same: [['https://www.hulu.com/watch/a?t=120#c', 'https://www.hulu.com/watch/a/'], ['https://www.youtube.com/watch?v=A&pp=x&si=y', 'https://www.youtube.com/watch?v=A'],
            ['https://www.primevideo.com/detail/X/ref=atv_1', 'https://www.primevideo.com/detail/X/ref=atv_2']].map(([a, b]) => S.pageKey(a) === S.pageKey(b)),
          different: [['https://www.hulu.com/watch/a', 'https://www.hulu.com/watch/b'], ['https://www.youtube.com/watch?v=A', 'https://www.youtube.com/watch?v=B']].map(([a, b]) => S.pageKey(a) !== S.pageKey(b))
        };
      });
      assert.deepEqual(out.hosts, ['example.com', 'news.example.org', 'localhost', '192.168.1.20', '[::1]', null, null, null, null, null]);
      assert.deepEqual(out.ignored, [true, true, false, true]);
      assert.deepEqual(out.patterns, ['*://192.168.1.20/*', '*://localhost/*', '*://*.x.com/*']);
      assert.deepEqual(out.same, [true, true, true]); assert.deepEqual(out.different, [true, true]);
    });
    await test('Social feeds are ignored by default and excluded from injection', async () => {
      const registered = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => ({ id: s.id, exclude: s.excludeMatches, world: s.world })));
      assert.deepEqual(registered.map(s => s.id).sort(), ['anchor-bridge', 'anchor-main']);
      for (const s of registered) for (const p of ['*://*.x.com/*', '*://*.instagram.com/*', '*://*.tiktok.com/*', '*://*.facebook.com/*']) assert(s.exclude.includes(p), p);
      for (const url of ['https://x.com/home', 'https://www.instagram.com/', 'https://www.tiktok.com/foryou', 'https://m.facebook.com/watch']) {
        await page.goto(url); await page.waitForFunction(() => v1.readyState >= 2);
        assert.equal(await engine(), false, url);
        assert.match(await page.evaluate(() => HTMLMediaElement.prototype.play.toString()), /native code/, url);
        // Feed shortcuts and autoplay are untouched.
        await page.evaluate(() => { v1.pause(); }); assert.equal(await page.evaluate(() => restart('v1')), 'played');
      }
      await wait(async () => /ignored site/.test(await worker.evaluate(id => chrome.action.getTitle({ tabId: id }), await tabId())), 'Ignored title missing');
    });
    await test('Options page adds, validates and removes ignored sites', async () => {
      const options = await context.newPage(); options.on('pageerror', e => errors.push('options: ' + e.message));
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.waitForFunction(() => document.querySelectorAll('#ignored li').length > 0);
      await options.fill('#site', 'not a site!'); await options.click('button[type=submit]');
      assert.equal(await options.locator('#add-error').isVisible(), true);
      await options.fill('#site', 'https://www.Example.COM/watch?v=1'); await options.click('button[type=submit]');
      await options.waitForFunction(() => [...document.querySelectorAll('#ignored .name')].some(n => n.textContent === 'example.com'))
        .catch(async e => { throw new Error(`${e.message}; error shown: ${await options.textContent('#add-error')}`); });
      await options.fill('#site', 'video.example.com'); await options.click('button[type=submit]');
      assert.match(await options.textContent('#add-error'), /already ignored by example\.com/);
      assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get('ignoredSites'))).ignoredSites.includes('example.com'), true);
      await page.bringToFront(); await page.goto('https://video.example.com/watch/1'); await page.waitForFunction(() => video().readyState >= 2);
      assert.equal(await engine(), false);
      await options.click('button[aria-label="Remove example.com"]');
      // The open page gets Anchor without a reload.
      await wait(async () => await engine() && (await state()).available, 'Un-ignored page was not protected');
      await options.screenshot({ path: path.join(root, '.test-results/options.png'), fullPage: true });
      await options.close();
    });
    await test('Popup switch ignores and restores the current site', async () => {
      await load('https://stream.test/watch/1');
      const pop = await context.newPage(); await page.bringToFront();
      const ignored = async () => (await worker.evaluate(() => chrome.storage.local.get('ignoredSites'))).ignoredSites;
      // Slow CI runners (macOS) need a longer budget than local machines.
      const settle = async (fn, message) => {
        for (let i = 0; i < 300; i++) { if (await fn()) return; await page.waitForTimeout(50); }
        assert.fail(`${message}; popup state "${await pop.textContent('#state')}", error "${await pop.textContent('#error')}", ignored ${JSON.stringify(await ignored())}`);
      };
      try {
        await pop.goto(`chrome-extension://${extensionId}/popup.html`);
        await pop.waitForFunction(() => document.querySelector('#hostname').textContent === 'stream.test' && !document.querySelector('#enabled').disabled);
        await pop.uncheck('#enabled');
        // The popup finishes only after the worker has saved the list and updated the tab.
        await pop.waitForFunction(() => !document.querySelector('#enabled').disabled && document.querySelector('#state').textContent === 'Ignored', null, { timeout: 15000 })
          .catch(async e => assert.fail(`${e.message}; error "${await pop.textContent('#error')}"`));
        assert((await ignored()).includes('stream.test'), 'Not ignored');
        await settle(async () => (await state()).frames.every(f => !f.enabled), 'Page still protected');
        await pop.check('#enabled');
        await pop.waitForFunction(() => !document.querySelector('#enabled').disabled && document.querySelector('#state').textContent !== 'Ignored', null, { timeout: 15000 });
        assert(!(await ignored()).includes('stream.test'), 'Still ignored');
        await settle(async () => (await state()).frames.some(f => f.enabled), 'Protection not restored');
        assert.equal(await pop.locator('#error').isVisible(), false, await pop.textContent('#error'));
      } finally {
        // Never leave the shared fixture site ignored for later tests.
        await worker.evaluate(async () => setIgnored((await getIgnored()).filter(h => h !== 'stream.test')));
        await pop.close();
      }
    });
    await test('A hold ends when the app navigates to the next title, so it autoplays', async () => {
      await load('https://stream.test/watch/1');
      await page.click('#toggle'); await page.waitForFunction(() => !video.paused);
      await page.click('#toggle'); await held(true);
      assert.equal(await page.evaluate(() => spaNext('/watch/2')), 'played');
      await held(false);
    });
    await test('Hash and timestamp changes keep a hold; reload keeps it; a different title clears it', async () => {
      await page.click('#toggle'); await held(true);
      await page.evaluate(() => { location.hash = 'comments'; history.replaceState({}, '', location.pathname + '?t=120#comments'); });
      await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => restart()), 'AbortError');
      await page.reload(); await page.waitForFunction(() => video().readyState >= 2); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => restart()), 'AbortError');
      await page.goto('https://stream.test/watch/3'); await page.waitForFunction(() => video().readyState >= 2);
      await wait(async () => (await state()).frames.some(f => f.enabled), 'No configuration');
      assert.equal(await page.evaluate(() => restart()), 'played'); assert.equal((await state()).locked, false);
    });
    await test('Next episode while held plays the next episode', async () => {
      await page.click('#toggle'); await held(true);
      await page.click('#next'); await page.waitForFunction(() => !video.paused);
      await held(false); assert.deepEqual(await page.evaluate(() => log), []);
    });
    await test('Skip intro inside a play/pause-labelled player neither pauses nor holds', async () => {
      await page.click('#skip'); await page.waitForTimeout(250);
      assert.equal(await playing('#video'), true); assert.equal((await state()).locked, false);
    });
    await test('Clicking a playing video that only shows controls does not force a pause', async () => {
      await page.evaluate(() => overlay.style.display = 'none');
      await page.mouse.click(480, 200); await page.waitForTimeout(250);
      assert.equal(await playing('#video'), true); assert.equal((await state()).locked, false);
      await page.evaluate(() => overlay.style.display = '');
    });
    await test('Seek bar clicks keep a hold, but the paused player surface resumes', async () => {
      await page.click('#toggle'); await held(true);
      await page.click('#progress'); await page.waitForTimeout(200);
      assert.equal(await playing('#video'), false); assert.deepEqual(await page.evaluate(() => log.splice(0)), ['AbortError']);
      await page.click('#overlay'); await page.waitForFunction(() => !video.paused); await held(false);
    });
    await test('An unrecognized or localized Play button on the player resumes', async () => {
      await page.click('#toggle'); await held(true);
      await page.click('#lecture'); await page.waitForFunction(() => !video.paused); await held(false);
    });
    await test('Site K shortcut pressed while its Play button has focus holds and releases', async () => {
      // YouTube-style: after clicking Play, focus stays on the button and the site handles K itself.
      await page.evaluate(() => document.addEventListener('keydown', e => { if (e.code === 'KeyK') { e.preventDefault(); video().paused ? video().play().catch(() => {}) : video().pause(); } }));
      await page.focus('#toggle');
      await page.keyboard.press('k'); await page.waitForFunction(() => video().paused); await held(true);
      assert.equal(await page.evaluate(() => restart()), 'AbortError');
      await page.keyboard.press('k'); await page.waitForFunction(() => !video().paused); await held(false);
    });
    await test('Held play() rejects as AbortError, so players do not fall back to muted autoplay', async () => {
      await page.click('#toggle'); await held(true);
      const muted = await page.evaluate(async () => {
        const v = video();
        await v.play().catch(e => { if (e.name === 'NotAllowedError') { v.muted = true; return v.play().catch(() => {}); } });
        return v.muted;
      });
      assert.equal(muted, false);
    });
    await test('Detached sound effects play while a video is held', async () => {
      assert.equal(await page.evaluate(src => new Audio(src).play().then(() => 'played', e => e.name), source), 'played');
      await worker.evaluate(id => resume(id), await tabId()); await held(false);
    });
    await test('Arrow keys defer to a player that handles them itself', async () => {
      await page.mouse.click(1200, 650);
      await page.evaluate(() => {
        video().pause(); video().currentTime = 20;
        document.addEventListener('keydown', e => { if (e.code === 'ArrowRight') { e.preventDefault(); video().currentTime += 5; } });
      });
      await page.keyboard.press('ArrowRight');
      assert.equal(Math.round(await page.evaluate(() => video().currentTime)), 25);
    });
    await test('Space scrolls a news page whose only videos are muted autoplay clips', async () => {
      await load('https://news.test/article', () => v1.readyState >= 2 && !v1.paused && !v2.paused);
      await page.mouse.click(900, 100);
      await page.keyboard.press('Space'); await page.waitForTimeout(250);
      assert(await page.evaluate(() => scrollY) > 0, 'Space did not scroll');
      assert.equal(await playing('#v1'), true); assert.equal(await playing('#v2'), true);
      assert.equal((await state()).locked, false);
      await page.evaluate(() => scrollTo(0, 0));
    });
    await test('Pausing one news video holds only that video; others keep autoplaying', async () => {
      await page.locator('.card').nth(1).locator('button').click();
      await page.waitForFunction(() => v2.paused); await held(true);
      assert.equal(await playing('#v1'), true);
      assert.equal(await page.evaluate(() => restart('v2')), 'AbortError');
      await page.evaluate(() => v1.pause()); assert.equal(await page.evaluate(() => restart('v1')), 'played');
    });
    await test('A held clip stays paused after reload while its neighbour autoplays', async () => {
      await page.reload(); await page.waitForFunction(() => v1.readyState >= 2 && v2.readyState >= 2);
      await page.waitForTimeout(1400);
      assert.equal(await playing('#v1'), true); assert.equal(await playing('#v2'), false);
      await page.locator('.card').nth(1).locator('button').click(); await page.waitForFunction(() => !v2.paused); await held(false);
    });
    await test('Popup Keep paused still holds every video in the tab', async () => {
      await worker.evaluate(id => setLock(id, true), await tabId());
      await page.waitForFunction(() => v1.paused && v2.paused);
      assert.equal(await page.evaluate(() => restart('v1')), 'AbortError');
      await worker.evaluate(id => resume(id), await tabId()); await held(false);
    });
    await test('Stop autoplay holds news clips until each one is started', async () => {
      await prefs({ blockAutoplay: true });
      await page.reload(); await page.waitForFunction(() => v1.readyState >= 2 && v2.readyState >= 2);
      await wait(async () => (await state()).locked, 'Autoplay not held');
      await page.waitForFunction(() => v1.paused && v2.paused);
      await page.locator('.card').nth(0).locator('button').click(); await page.waitForFunction(() => !v1.paused);
      assert.equal(await page.evaluate(() => restart('v2')), 'AbortError');
      await prefs({ blockAutoplay: false });
    });
    await test('Release fixtures have no uncaught page errors', async () => assert.deepEqual(errors, []));
  } finally {
    fs.writeFileSync(path.join(root, '.test-results', process.env.ANCHOR_BROWSER ? 'brave-release-results.json' : 'release-results.json'),
      JSON.stringify({ engine: context.browser()?.version?.() || 'persistent context', note: 'Intercepted fixtures for streaming, news and social pages; no production service UI.', tests: results }, null, 2));
    await context.close();
  }
  if (results.some(r => !r.passed)) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
