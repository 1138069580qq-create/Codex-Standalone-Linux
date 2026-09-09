import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,ConsoleError,defaultConfig} from '../src/backend/config';
import {CommandReceipts} from '../src/backend/receipts';
import {CodexConsoleService} from '../src/backend/service';
const admin={uuid:'admin',elevated:true};
const code=(value:string)=>(e:unknown)=>e instanceof ConsoleError&&e.code===value;
async function fixture(t:any){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'webui-fixed-directory-')),home=path.join(base,'home'),data=path.join(base,'data');
 await fs.mkdir(home);await fs.mkdir(data);t.mock.method(os,'homedir',()=>home);
 const config=new ConfigStore(path.join(data,'config.json'));config.value={...defaultConfig(),enabled:true,transport:{type:'unix',endpoint:path.join(base,'fake.sock')}};
 const service=new CodexConsoleService(config,new CommandReceipts(path.join(data,'receipts.json')));t.after(()=>service.disconnect());
 return {service,config,base,home:await fs.realpath(home)};
}
test('admin receives the service home prefix and creates a project by one folder name',async t=>{
 const {service,config,home}=await fixture(t);
 await assert.rejects(service.projectDirectory({uuid:'viewer',elevated:false}),code('ADMIN_REQUIRED'));
 const directory=await service.projectDirectory(admin);assert.deepEqual(directory,{root:home,separator:path.sep});assert.deepEqual(await fs.readdir(home),[]);
 const body={folderName:'文件夹1',baseRoot:home,confirmDirectory:true,requestId:'fixed-folder-create-123'};
 const result=await service.createProject(admin,body);assert.equal(result.root,path.join(home,'文件夹1'));assert.equal(result.name,'文件夹1');
 assert.equal((await fs.stat(result.root)).isDirectory(),true);assert.equal((await service.createProject(admin,body)).id,result.id);assert.equal(config.value.projects.length,1);
});
test('folder creation rejects traversal, full paths, stale prefixes and mixed path modes without creating directories',async t=>{
 const {service,home}=await fixture(t),body={baseRoot:home,confirmDirectory:true,requestId:'reject-folder-123'};
 for(const folderName of ['','.', '..','../escape','/1','a/b','a\\b','C:\\outside','bad:name','NUL','CON.txt','trailing.','a\0b','界'.repeat(100)])
  await assert.rejects(service.createProject(admin,{...body,folderName}),code('INVALID_FOLDER_NAME'));
 await assert.rejects(service.createProject(admin,{...body,folderName:'ok',baseRoot:path.dirname(home)}),code('PROJECT_BASE_CHANGED'));
 await assert.rejects(service.createProject(admin,{...body,folderName:'ok',root:path.join(home,'other')}),code('INVALID_PROJECT'));
 assert.deepEqual(await fs.readdir(home),[]);
});
test('fixed prefixes do not follow an existing folder redirect outside the prefix',async t=>{
 const {service,home,base}=await fixture(t),outside=path.join(base,'outside');await fs.mkdir(outside);
 await fs.symlink(outside,path.join(home,'redirect'),'junction');
 await assert.rejects(service.createProject(admin,{folderName:'redirect',baseRoot:home,confirmDirectory:true,requestId:'redirect-folder-123'}),code('PROJECT_PATH_REDIRECTED'));
 assert.deepEqual(await fs.readdir(outside),[]);
});
test('an unwritable home or filesystem root is not advertised as a usable default',async t=>{
 const {service,home}=await fixture(t);const access=t.mock.method(fs,'access',async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});});
 await assert.rejects(service.projectDirectory(admin),code('PROJECT_DIRECTORY_DENIED'));access.mock.restore();
 t.mock.method(os,'homedir',()=>path.parse(home).root);await assert.rejects(service.projectDirectory(admin),code('PROJECT_BASE_UNAVAILABLE'));
});
