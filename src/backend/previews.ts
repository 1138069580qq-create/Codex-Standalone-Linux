import {unzipSync, strFromU8} from "fflate";
import {ConsoleError} from "./config";
import {openProjectDownload, MAX_DOWNLOAD_BYTES} from "./files";
import {contentType, isImageType, isMediaType, isTextType} from "./mime";
import {readBounded} from "./transfers";
const TEXT_BYTES=64*1024, MAX_IMAGE_BYTES=32*1024*1024, MAX_ARCHIVE_BYTES=32*1024*1024;
const OFFICE_TYPES=new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.presentationml.presentation","application/vnd.oasis.opendocument.text"]);
export function imageType(name:string) { const type=contentType(name);return isImageType(type)?type:undefined; }
export async function projectPreview(root:string,name:string) {
  const type=contentType(name),office=OFFICE_TYPES.has(type),archive=type==="application/zip";
  const kind=isImageType(type)?"image":type==="application/pdf"?"pdf":isMediaType(type)?"media":undefined;
  const limit=office||archive?MAX_ARCHIVE_BYTES:kind?1:TEXT_BYTES;
  const file=await openProjectDownload(root,name,{previewBytes:limit,maxSourceBytes:office||archive?MAX_ARCHIVE_BYTES:MAX_DOWNLOAD_BYTES});
  if(kind){file.stream.destroy();return {kind,contentType:type,size:file.total};}
  const data=await readBounded(file.stream,limit);
  if(office||archive) {
    try {
      const names:string[]=[];let expanded=0,truncated=false;
      const extracted=unzipSync(data,{filter:entry=>{
        // ZIP browsing lists names without inflating their contents. Office extracts bounded XML only.
        if(names.length>=500){truncated=true;return false;}
        if(entry.name.length>240){truncated=true;return false;}
        names.push(entry.name);
        if(archive)return false;
        if(!/^(?:word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(entry.name))return false;
        if(entry.originalSize>1024*1024 || expanded+entry.originalSize>4*1024*1024){truncated=true;return false;}
        expanded+=entry.originalSize;return true;
      }});
      let text=archive?names.join("\n"):Object.entries(extracted).map(([name,bytes])=>"["+name+"]\n"+strFromU8(bytes).replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/\s+/g," ").trim()).join("\n");
      truncated ||= Buffer.byteLength(text)>TEXT_BYTES;
      text=new TextDecoder().decode(Buffer.from(text).subarray(0,TEXT_BYTES));
      return {kind:archive?"archive":"text",contentType:"text/plain",size:file.total,text,truncated};
    } catch { return {kind:"binary",contentType:type,size:file.total}; }
  }
  try {
    let encoding="utf-8",start=0;
    if(data[0]===0xff&&data[1]===0xfe){encoding="utf-16le";start=2;}
    else if(data[0]===0xfe&&data[1]===0xff){encoding="utf-16be";start=2;}
    else if(data.includes(0))return {kind:"binary",contentType:type,size:file.total};
    // Streaming decode intentionally retains an incomplete last UTF code point at the byte boundary.
    const text=new TextDecoder(encoding,{fatal:true}).decode(data.subarray(start),{stream:file.total>data.length}).replace(/^\uFEFF/,"");
    if(!isTextType(type)&&/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))return {kind:"binary",contentType:type,size:file.total};
    return {kind:"text",contentType:isTextType(type)?type:"text/plain",size:file.total,text,truncated:file.total>data.length};
  } catch {return {kind:"binary",contentType:type,size:file.total};}
}
export type ImageTransformer=(source:Buffer,full:boolean)=>Promise<{data:Buffer;type:string}>;
async function imageTransformer(source:Buffer,full:boolean) {
  const {default:sharp}=await import("sharp");
  const image=sharp(source,{limitInputPixels:32*1024*1024,pages:1,failOn:"warning"}),metadata=await image.metadata();
  if(!["png","jpeg","webp","gif","heif","avif","tiff"].includes(metadata.format||""))throw new Error("Unsupported raster image");
  const output=full?image.rotate():image.rotate().resize({width:384,height:384,fit:"inside",withoutEnlargement:true});
  const data=await output.webp({quality:full?85:68,effort:4}).timeout({seconds:8}).toBuffer();
  return {data,type:"image/webp"};
}
export class ThumbnailCache {
  private cache=new Map<string,{data:Buffer;at:number}>();
  private pending=new Map<string,Promise<{data:Buffer;type:string}>>();
  constructor(private transform:ImageTransformer=imageTransformer) {}
  clear(){this.cache.clear();}
  async read(root:string,name:string,full=false) {
    if(!imageType(name))throw new ConsoleError(415,"IMAGE_TYPE","只支持安全的栅格图片预览。");
    const file=await openProjectDownload(root,name,{maxSourceBytes:MAX_IMAGE_BYTES});
    const key=root+"\0"+name+"\0"+file.etag+"\0"+(full?"full":"thumb"),etag=`W/"${full?"full":"thumb"}-${file.etag.slice(1,-1)}"`;
    const cached=this.cache.get(key);if(!full&&cached&&Date.now()-cached.at<300000){file.stream.destroy();return {data:cached.data,type:"image/webp",etag};}
    let work=this.pending.get(key);
    if(work)file.stream.destroy();
    else {
      if(this.pending.size>=2){file.stream.destroy();throw new ConsoleError(429,"PREVIEW_BUSY","图片预览繁忙，请稍后重试。");}
      work=(async()=>{
        try {
          const result=await this.transform(await readBounded(file.stream,MAX_IMAGE_BYTES),full);
          if(result.type!=="image/webp"||result.data.length>(full?MAX_IMAGE_BYTES:256*1024))throw new Error("Image size limit");
          if(!full){this.cache.set(key,{data:result.data,at:Date.now()});while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);}
          return result;
        } catch(e){if(e instanceof ConsoleError)throw e;throw new ConsoleError(415,"INVALID_IMAGE","图片无法在安全限制内解码。");}
      })();
      this.pending.set(key,work);void work.finally(()=>this.pending.delete(key)).catch(()=>{});
    }
    return {...await work,etag};
  }
}
