/* Builds dist/anchor-<version>.zip with only the files the extension needs, ready
 * for a GitHub release or a Chrome Web Store upload. No dependencies: a minimal
 * ZIP writer (deflate via zlib, CRC-32, central directory). */
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const manifest = require('../manifest.json');
const files = ['manifest.json', 'background.js', 'bridge.js', 'main.js', 'settings.js',
  'popup.html', 'popup.css', 'popup.js', 'options.html', 'options.css', 'options.js', 'help.html', 'LICENSE',
  ...fs.readdirSync(path.join(root, 'icons')).filter(f => /\.(png|svg)$/.test(f)).map(f => `icons/${f}`)];

// Every file the manifest and pages reference must ship.
const referenced = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), manifest.action.default_popup, manifest.options_ui.page, manifest.background.service_worker];
for (const file of referenced) if (!files.includes(file)) throw new Error(`${file} is referenced by manifest.json but not packaged`);
for (const page of files.filter(f => f.endsWith('.html'))) {
  for (const [, ref] of fs.readFileSync(path.join(root, page), 'utf8').matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!files.includes(ref)) throw new Error(`${page} references ${ref}, which is not packaged`);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// Fixed timestamp (2020-01-01) so identical sources produce an identical archive.
const DOS_TIME = 0, DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const locals = [], centrals = [];
let offset = 0;
for (const name of files) {
  const data = fs.readFileSync(path.join(root, name));
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  locals.push(local, nameBuf, packed); centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + packed.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `anchor-${manifest.version}.zip`);
fs.writeFileSync(out, Buffer.concat([...locals, directory, end]));
console.log(`PASS packaged ${files.length} files into ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
