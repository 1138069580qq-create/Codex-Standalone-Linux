import path from 'node:path';
import os from 'node:os';
/** Canonical project-relative references only. Serving revalidates real paths and open file handles. */
export function fileReference(value:unknown,root?:string):string|undefined {
  if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f]/.test(value))return;
  let input=value;try{input=decodeURIComponent(input);}catch{return;}
  if(/[\x00-\x1f]/.test(input))return;
  if(input.startsWith('sandbox:'))input=input.slice(8);
  if(/^(?![a-z]:[\\/])[a-z][a-z\d+.-]*:/i.test(input))return;
  if(path.posix.isAbsolute(input)||path.win32.isAbsolute(input)){
    if(!root)return;const paths=path.win32.isAbsolute(root)&&!path.posix.isAbsolute(root)?path.win32:path.posix;
    input=paths.relative(root,input);if(paths.isAbsolute(input))return;
  }
  const parts=input.replace(/\\/g,'/').split('/');
  if(parts.some(p=>p==='..'||p.includes(':')||/^(?:\.git|\.ssh|\.codex|auth\.json)$/i.test(p)||/^\.env/i.test(p)))return;
  const result=parts.filter(p=>p&&p!=='.').join('/');return result||undefined;
}
export function generatedImagesRoot(){return path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images');}
export function generatedImageReference(value:unknown):string|undefined {
  if(typeof value!=='string'||!path.isAbsolute(value))return;
  const relative=fileReference(value,generatedImagesRoot());
  return relative&&/\.(?:png|jpe?g|webp|gif|avif|tiff?)$/i.test(relative)?relative:undefined;
}
/** A bounded link scanner, including escaped spaces, angle paths and balanced parentheses. */
export function markdownLinks(text:string){
  const links:Array<{source:string;label:string;image:boolean}>=[];
  const visible=text.slice(0,65536).replace(/(^|\n)(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g,m=>' '.repeat(m.length)).replace(/\x60[^\x60\n]*\x60/g,m=>' '.repeat(m.length));
  const re=/(!?)\[([^\]\n]*)\]\(/g;let match;
  while((match=re.exec(visible))&&links.length<64){let i=re.lastIndex,depth=1,angle=false;
    for(;i<visible.length;i++){const c=visible[i];if(c==='<'&&i===re.lastIndex)angle=true;else if(c==='>')angle=false;else if(!angle&&c==='(')depth++;else if(!angle&&c===')'&&--depth===0)break;}
    if(depth)continue;
    let source=visible.slice(re.lastIndex,i).trim().replace(/\s+"[^"\n]*"$/,'');if(source[0]==='<'&&source.at(-1)==='>')source=source.slice(1,-1);
    links.push({source,label:match[2],image:!!match[1]});re.lastIndex=i+1;
  }return links;
}
