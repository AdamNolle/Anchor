const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),manifest=require('../manifest.json');
assert.equal(manifest.manifest_version,3);
assert.equal(manifest.version,require('../package.json').version);
assert.equal(manifest.version,require('../package-lock.json').version);
const scripts=['background','bridge','main','popup','settings','options'];
for(const name of scripts){
  const r=spawnSync(process.execPath,['--check',path.join(root,name+'.js')],{stdio:'inherit'});
  assert.equal(r.status,0,name+' syntax');
}
// Content scripts are registered dynamically by background.js.
const background=fs.readFileSync(path.join(root,'background.js'),'utf8');
for(const file of ['main.js','bridge.js','settings.js'])assert(background.includes(`'${file}'`),file+' referenced by background.js'),assert(fs.existsSync(path.join(root,file)));
for(const icons of [manifest.icons,manifest.action.default_icon])for(const file of Object.values(icons))assert(fs.existsSync(path.join(root,file)));
for(const page of [manifest.action.default_popup,manifest.options_ui.page,'help.html']){
  const html=fs.readFileSync(path.join(root,page),'utf8');
  for(const [,ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g))assert(fs.existsSync(path.join(root,ref)),`${page} references missing ${ref}`);
}
// The two copies of the page-identity rules must stay identical.
const pageKey=src=>src.match(/const volatile = (\/.*\/i);/)[1];
assert.equal(pageKey(fs.readFileSync(path.join(root,'main.js'),'utf8')),pageKey(fs.readFileSync(path.join(root,'settings.js'),'utf8')),'pageKey rules differ between main.js and settings.js');
assert(!JSON.stringify(manifest).includes('C:\\'));
assert(!manifest.content_scripts,'content scripts must stay dynamic so ignored sites can be excluded');
console.log('PASS manifest, assets, versions, page references, and JavaScript syntax');
