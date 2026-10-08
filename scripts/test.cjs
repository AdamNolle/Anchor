const {spawnSync}=require('node:child_process');
const path=require('node:path');
const tests=['browser','universal','media-session','shortcut','hardening','compatibility'];
for(const name of tests){
  const result=spawnSync(process.execPath,[path.join(__dirname,'../tests',name+'.test.cjs')],{stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
