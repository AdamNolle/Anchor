const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),manifest=require('../manifest.json');
assert.equal(manifest.manifest_version,3);
assert.equal(manifest.version,require('../package.json').version);
for(const name of ['background','bridge','main','popup','settings']){
  const r=spawnSync(process.execPath,['--check',path.join(root,name+'.js')],{stdio:'inherit'});
  assert.equal(r.status,0,name+' syntax');
}
for(const scripts of manifest.content_scripts)for(const file of scripts.js)assert(fs.existsSync(path.join(root,file)));
for(const icons of [manifest.icons,manifest.action.default_icon])for(const file of Object.values(icons))assert(fs.existsSync(path.join(root,file)));
assert(!JSON.stringify(manifest).includes('C:\\'));
console.log('PASS manifest, assets, versions, and JavaScript syntax');
