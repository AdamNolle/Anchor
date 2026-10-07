const S = PauseKeeperSettings;
const ids = Object.keys(S.defaults);
const $ = id => document.getElementById(id);
let tab, origin, busy = false;
function failure(text) { $('error').textContent = text; $('error').hidden = !text; }
async function send(message) { const result = await chrome.runtime.sendMessage(message); if (result?.error) throw new Error(result.error); return result; }
function controls() { $('options').disabled = !$('enabled').checked || busy; $('enabled').disabled = !origin || busy; $('lock').disabled = $('play').disabled = !$('enabled').checked || busy || !origin; }
async function updateStatus() {
  if (!tab || !origin || busy) return;
  try {
    const state = await send({ type: 'PK_STATUS', tabId: tab.id });
    const enabled = $('enabled').checked;
    $('state').textContent = !enabled ? 'Off' : state.locked ? 'Held paused' : state.available ? 'Ready' : 'No player';
    $('state').classList.toggle('locked', enabled && state.locked);
    $('status').textContent = !enabled ? 'Enable protection to use Anchor here.' : state.locked ? `Playback held until you press play. ${state.blocked} restart attempt${state.blocked === 1 ? '' : 's'} blocked.` : state.media ? `${state.media} player${state.media === 1 ? '' : 's'} detected. Your next pause will be protected.` : 'Waiting for a player. Start a video on this page.';
    const playerError = state.frames.find(f => f.enabled && f.error)?.error;
    if (playerError) failure(`The player could not resume: ${playerError}. Try the site's own Play button.`);
  } catch (e) { failure(e.message); }
}
async function save() {
  if (!origin || busy) return;
  failure(''); busy = true; controls();
  try {
    const config = Object.fromEntries(ids.map(id => [id, $(id).checked]));
    await send({ type: 'PK_SAVE', tabId: tab.id, origin, config });
  } catch (e) { failure(e.message); }
  finally { busy = false; controls(); await updateStatus(); }
}
for (const id of ids) $(id).addEventListener('change', save);
for (const command of ['lock', 'play']) $(command).addEventListener('click', async () => {
  if (busy) return;
  busy = true; controls(); failure('');
  try { await send({ type: 'PK_CONTROL', command, tabId: tab.id }); }
  catch (e) { failure(e.message); }
  finally { busy = false; controls(); await updateStatus(); }
});
(async () => {
  try {
    const command = (await chrome.commands.getAll()).find(item => item.name === 'toggle-pause-lock');
    $('shortcut').textContent = command?.shortcut && command.shortcut !== 'Alt+Shift+P'
      ? `Quick toggle: ${command.shortcut}`
      : 'Set a quick toggle in your browser’s extension shortcuts.';
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    origin = S.origin(tab?.url);
    $('hostname').textContent = origin ? new URL(origin).host : 'Open a streaming website';
    if (!origin) { $('status').textContent = 'Chrome settings and extension pages cannot be protected.'; $('state').textContent = 'Unavailable'; }
    const { sites = {} } = await chrome.storage.local.get('sites');
    const config = S.forOrigin(origin, sites);
    for (const id of ids) $(id).checked = config[id];
    if (origin) $('permission').textContent = 'Automatic protection for web video and audio, including embedded players. Gray icon: no supported player or protection is off.';
    controls(); await updateStatus();
  } catch (e) { failure(e.message); }
})();
setInterval(updateStatus, 1500);
