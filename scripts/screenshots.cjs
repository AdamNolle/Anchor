/* Regenerates the README screenshots in docs/ from the real extension pages,
 * using an intercepted neutral site. Run: node scripts/screenshots.cjs */
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const wav = Buffer.alloc(44 + 16000 * 60);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const fixture = `<!doctype html><body style="margin:0;background:#111"><video id="video" style="width:960px;height:540px" src="data:audio/wav;base64,${wav.toString('base64')}"></video>
<button id="toggle" aria-label="Play">Play</button><script>const paint=()=>toggle.setAttribute("aria-label",video.paused?"Play":"Pause");video.onplay=video.onpause=paint;toggle.onclick=()=>video.paused?video.play():video.pause();</script></body>`;
(async () => {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-shots-')), {
    channel: 'chromium', headless: true, deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  try {
    await context.route(/^https?:\/\//, r => r.fulfill({ contentType: 'text/html', body: fixture }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => serialized(initialize));
    const id = worker.url().split('/')[2];
    const page = await context.newPage();
    await page.goto('https://watch.example.com/title/42'); await page.waitForFunction(() => video.readyState >= 2);
    await page.click('#toggle'); await page.waitForFunction(() => !video.paused);
    await page.click('#toggle'); await page.waitForFunction(() => video.paused);
    for (let i = 0; i < 3; i++) await page.evaluate(() => video.play().catch(() => {}));
    await page.waitForTimeout(500);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const popup = await context.newPage(); await popup.setViewportSize({ width: 370, height: 700 });
    await page.bringToFront(); await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#state').textContent === 'Held paused');
    const height = await popup.evaluate(() => document.documentElement.scrollHeight);
    await popup.screenshot({ path: path.join(root, 'docs/popup.png'), clip: { x: 0, y: 0, width: 370, height } });
    const options = await context.newPage(); await options.setViewportSize({ width: 820, height: 900 });
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.waitForFunction(() => document.querySelectorAll('#ignored li').length > 0);
    await options.screenshot({ path: path.join(root, 'docs/options.png'), clip: { x: 0, y: 0, width: 820, height: 900 } });
    console.log('PASS wrote docs/popup.png and docs/options.png');
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
