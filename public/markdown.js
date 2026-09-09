/* Small safe Markdown renderer. All model content is text/DOM, never trusted HTML. */
(function(scope){
  function render(text,{link,image}={}){
    const root=document.createElement('div');root.className='message-markdown';
    function appendInline(parent,value,depth=0){
      if(depth>4){parent.append(document.createTextNode(value));return;}
      let plain='',i=0;const flush=()=>{if(plain){parent.append(document.createTextNode(plain));plain='';}};
      while(i<value.length){
        if(value.charCodeAt(i)===92&&/[\[\]*_\x60!]/.test(value[i+1]||'')){plain+=value[i+1];i+=2;continue;}
        if(value.charCodeAt(i)===96){const end=value.indexOf(String.fromCharCode(96),i+1);if(end>i+1){flush();const node=document.createElement('code');node.textContent=value.slice(i+1,end);parent.append(node);i=end+1;continue;}}
        const isImage=value.startsWith('![',i),start=isImage?i+1:i;
        if(value[start]==='['){
          const close=value.indexOf('](',start+1);
          if(close>=0){let end=close+2,nesting=1,angle=false;
            for(;end<value.length;end++){const c=value[end];if(c==='<'&&end===close+2)angle=true;else if(c==='>')angle=false;else if(!angle&&c==='(')nesting++;else if(!angle&&c===')'&&--nesting===0)break;}
            if(nesting===0){const label=value.slice(start+1,close);let target=value.slice(close+2,end).trim().replace(/\s+"[^"\n]*"$/,'');if(target[0]==='<'&&target.at(-1)==='>')target=target.slice(1,-1);
              flush();const node=(isImage?image:link)?.(target,label);if(node)parent.append(node);else if(!isImage)parent.append(document.createTextNode(label||target));else {const fallback=document.createElement('span');fallback.className='unavailable-attachment';fallback.textContent='[图片：'+(label||'无法预览')+']';parent.append(fallback);}i=end+1;continue;
            }
          }
        }
        const marker=value.startsWith('**',i)?'**':value.startsWith('__',i)?'__':value[i]==='*'?'*':null;
        if(marker){const end=value.indexOf(marker,i+marker.length);if(end>i+marker.length){flush();const node=document.createElement(marker.length===2?'strong':'em');appendInline(node,value.slice(i+marker.length,end),depth+1);parent.append(node);i=end+marker.length;continue;}}
        plain+=value[i++];
      }flush();
    }
    const lines=String(text).replace(/\r\n/g,'\n').split('\n');let paragraph=[],list=null;
    const flush=()=>{if(paragraph.length){const p=document.createElement('p');appendInline(p,paragraph.join('\n'));root.append(p);paragraph=[];}list=null;};
    for(let i=0;i<lines.length;i++){
      const line=lines[i],fence=line.match(/^\s*(\x60{3,}|~{3,})([\w-]*)\s*$/);
      if(fence){flush();const code=[],marker=fence[1];while(++i<lines.length&&!lines[i].trimStart().startsWith(marker))code.push(lines[i]);const pre=document.createElement('pre'),node=document.createElement('code');node.textContent=code.join('\n');pre.append(node);root.append(pre);continue;}
      if(!line.trim()){flush();continue;}
      const heading=line.match(/^(#{1,6})\s+(.+)$/),bullet=line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
      if(heading){flush();const h=document.createElement('h'+Math.min(heading[1].length+1,6));appendInline(h,heading[2]);root.append(h);}
      else if(bullet){if(paragraph.length)flush();const type=bullet[1]?'UL':'OL';if(!list||list.tagName!==type){list=document.createElement(type.toLowerCase());root.append(list);}const li=document.createElement('li');appendInline(li,bullet[2]);list.append(li);}
      else if(/^>\s?/.test(line)){flush();const quote=document.createElement('blockquote');appendInline(quote,line.replace(/^>\s?/,''));root.append(quote);}
      else{list=null;paragraph.push(line);}
    }flush();return root;
  }
  const api={render};if(typeof module!=='undefined')module.exports=api;else scope.CodexMarkdown=api;
})(globalThis);
