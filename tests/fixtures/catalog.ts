// Deterministic local fixture installed only in an explicitly isolated CODEX_HOME.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export async function installCatalogFixture(binary: string, home: string, project: string) {
  const env={...process.env,CODEX_HOME:home,HOME:home,USERPROFILE:home,OPENAI_API_KEY:'',CODEX_API_KEY:''};
  const skill=path.join(project,'.agents','skills','review-fixture');
  const marketplace=path.join(home,'qa-marketplace');
  const plugin=path.join(marketplace,'plugins','qa-docs');
  await Promise.all([fs.mkdir(path.join(marketplace,'.agents','plugins'),{recursive:true}),fs.mkdir(skill,{recursive:true}),fs.mkdir(path.join(plugin,'.codex-plugin'),{recursive:true}),fs.mkdir(path.join(plugin,'skills','qa-document'),{recursive:true})]);
  await fs.writeFile(path.join(skill,'SKILL.md'),'---\nname: review-fixture\ndescription: Review a test project without modifying files.\n---\nSummarize the provided text. Do not use tools.\n');
  await fs.writeFile(path.join(plugin,'skills','qa-document','SKILL.md'),'---\nname: qa-document\ndescription: A document skill for the isolated integration test.\n---\nSummarize the provided text. Do not use tools.\n');
  await fs.writeFile(path.join(plugin,'.codex-plugin','plugin.json'),JSON.stringify({name:'qa-docs',version:'1.0.0',description:'Isolated plugin fixture',author:{name:'WebUI tests'},skills:'./skills/',interface:{displayName:'QA Documents',shortDescription:'Document plugin fixture',capabilities:[],defaultPrompt:'Summarize the provided text.'}}));
  await fs.writeFile(path.join(marketplace,'.agents','plugins','marketplace.json'),JSON.stringify({name:'qa-local',interface:{displayName:'QA local'},plugins:[{name:'qa-docs',source:{source:'local',path:'./plugins/qa-docs'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]}));
  execFileSync(binary,['plugin','marketplace','add',marketplace,'--json'],{env,cwd:project,stdio:'pipe',timeout:30_000});
  execFileSync(binary,['plugin','add','qa-docs@qa-local','--json'],{env,cwd:project,stdio:'pipe',timeout:30_000});
  return {env,skill,plugin};
}
