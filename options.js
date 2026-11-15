const S = PauseKeeperSettings;
const $ = id => document.getElementById(id);
const labels = { fixKeyboard: 'Keyboard controls', blockAutoplay: 'Stop autoplay', strictPause: 'Lock every pause', pauseWhenHidden: 'Pause when leaving tab' };
let ignored = [], busy = false;
async function send(message) { const result = await chrome.runtime.sendMessage(message); if (result?.error) throw new Error(result.error); return result; }
function problem(text) { $('add-error').textContent = text; $('add-error').hidden = !text; }
function item(name, detail, buttonText, onClick) {
  const li = document.createElement('li');
  const text = document.createElement('div');
  const strong = document.createElement('span'); strong.className = 'name'; strong.textContent = name; text.append(strong);
  if (detail) { const small = document.createElement('small'); small.textContent = detail; text.append(small); }
  const button = document.createElement('button'); button.type = 'button'; button.textContent = buttonText;
  button.setAttribute('aria-label', `${buttonText} ${name}`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await onClick(); } catch (e) { problem(e.message); button.disabled = false; }
  });
  li.append(text, button);
  return li;
}
function renderIgnored() {
  $('ignored').replaceChildren(...ignored.map(host => item(host, S.isIp(host) || !host.includes('.') ? '' : `Includes subdomains of ${host}`, 'Remove', () => save(ignored.filter(h => h !== host)))));
  $('ignored-empty').hidden = ignored.length > 0;
}
async function renderCustom() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  const rows = Object.entries(sites).map(([origin, stored]) => [origin, S.prefs(stored)])
    .filter(([, prefs]) => Object.keys(S.defaults).some(k => prefs[k] !== S.defaults[k]))
    .sort(([a], [b]) => a.localeCompare(b));
  $('custom').replaceChildren(...rows.map(([origin, prefs]) => {
    const changed = Object.keys(S.defaults).filter(k => prefs[k] !== S.defaults[k]).map(k => `${labels[k]}: ${prefs[k] ? 'on' : 'off'}`).join(' · ');
    return item(origin.replace(/^https?:\/\//, ''), changed, 'Reset', async () => { await send({ type: 'PK_RESET_SITE', origin }); await renderCustom(); });
  }));
  $('custom-empty').hidden = rows.length > 0;
}
async function save(list) {
  busy = true; problem('');
  try { ({ ignoredSites: ignored } = await send({ type: 'PK_SET_IGNORED', ignoredSites: list })); renderIgnored(); }
  finally { busy = false; }
}
$('add').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const host = S.normalizeHost($('site').value);
  if (!host) { problem('Enter a website such as example.com, a full web address, or an IP address.'); return; }
  const covering = S.ignoredBy(host, ignored);
  if (covering) { problem(covering === host ? `${host} is already ignored.` : `${host} is already ignored by ${covering}.`); return; }
  if (ignored.length >= S.maxIgnored) { problem(`You can ignore up to ${S.maxIgnored} sites.`); return; }
  try { await save([...ignored, host]); $('site').value = ''; $('site').focus(); }
  catch (e) { problem(e.message); }
});
$('site').addEventListener('input', () => problem(''));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ignoredSites && !busy) { ignored = S.cleanIgnored(changes.ignoredSites.newValue); renderIgnored(); }
  if (changes.sites) renderCustom();
});
(async () => {
  try { ({ ignoredSites: ignored } = await send({ type: 'PK_GET_IGNORED' })); renderIgnored(); await renderCustom(); }
  catch (e) { problem(e.message); }
})();
