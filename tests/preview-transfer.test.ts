import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {zipSync,strToU8} from 'fflate';
import {openProjectDownload,MAX_UPLOAD_BYTES} from '../src/backend/files';
import {projectPreview,ThumbnailCache} from '../src/backend/previews';
import {UploadSessions,CHUNK_BYTES,readBounded} from '../src/backend/transfers';
import {publicAddress,allowedUrl,downloadExternal} from '../src/backend/remote-files';
import {normalizeItem,imageReference} from '../src/backend/normalize';
const fixture=()=>fs.mkdtemp(path.join(os.tmpdir(),'webui-preview-'));
async function bytes(s:NodeJS.ReadableStream){const parts:Buffer[]=[];for await(const b of s as any)parts.push(Buffer.from(b));return Buffer.concat(parts);}
test('streaming downloads support validators, suffix ranges, If-Range and invalid ranges',async()=>{
 const root=await fixture();await fs.writeFile(path.join(root,'text.txt'),'0123456789');const first=await openProjectDownload(root,'text.txt',{range:'bytes=2-5'});assert.equal(first.status,206);assert.equal(first.contentRange,'bytes 2-5/10');assert.equal((await bytes(first.stream)).toString(),'2345');
 const cached=await openProjectDownload(root,'text.txt',{ifNoneMatch:'W/'+first.etag});assert.equal(cached.status,304);cached.stream.destroy();const wildcard=await openProjectDownload(root,'text.txt',{ifNoneMatch:'*'});assert.equal(wildcard.status,304);wildcard.stream.destroy();
 for(const [range,expected]of [['bytes=-3','789'],['bytes=4-','456789']]){const f=await openProjectDownload(root,'text.txt',{range});assert.equal((await bytes(f.stream)).toString(),expected);}
 const stale=await openProjectDownload(root,'text.txt',{range:'bytes=2-3',ifRange:'"old"'});assert.equal(stale.status,200);assert.equal((await bytes(stale.stream)).length,10);
 for(const range of ['bytes=-0','bytes=15-','bytes=2-1','bytes=0-1,3-4','bytes=9999999999999999999-'])await assert.rejects(openProjectDownload(root,'text.txt',{range}),(e:any)=>e.status===416);
 await fs.writeFile(path.join(root,'empty.txt'),'');const empty=await openProjectDownload(root,'empty.txt');assert.equal(empty.size,0);assert.equal((await bytes(empty.stream)).length,0);
});
test('bounded previews decode UTF BOMs and split UTF-8 safely, never interpret active HTML',async()=>{
 const root=await fixture();await fs.writeFile(path.join(root,'large.txt'),'中'.repeat(100000));const large=await projectPreview(root,'large.txt');assert.equal(large.kind,'text');assert.equal(large.truncated,true);assert.ok(Buffer.byteLength(large.text!)<=65536);assert.doesNotMatch(large.text!,/�/);
 for(const endian of ['le','be']){const b=Buffer.from('中文预览','utf16le');if(endian==='be')b.swap16();await fs.writeFile(path.join(root,endian+'.txt'),Buffer.concat([Buffer.from(endian==='le'?[255,254]:[254,255]),b]));assert.equal((await projectPreview(root,endian+'.txt')).text,'中文预览');}
 await fs.writeFile(path.join(root,'untrusted.html'),'<script>alert(1)</script>');assert.equal((await projectPreview(root,'untrusted.html')).text,'<script>alert(1)</script>');
 await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([0,1,2,3]));assert.equal((await projectPreview(root,'binary.bin')).kind,'binary');
});
test('Office extraction includes numbered slides/sheets while ZIP lists names without revealing contents',async()=>{
 const root=await fixture();for(const [file,name] of [['deck.pptx','ppt/slides/slide1.xml'],['sheet.xlsx','xl/worksheets/sheet1.xml'],['report.docx','word/document.xml']]){await fs.writeFile(path.join(root,file),zipSync({[name]:strToU8('<root>Visible content</root>')}));assert.match((await projectPreview(root,file)).text!,/Visible content/);}
 await fs.writeFile(path.join(root,'archive.zip'),zipSync({'notes.txt':strToU8('SECRET CONTENT'),'large.bin':new Uint8Array(2*1024*1024)}));const zip=await projectPreview(root,'archive.zip');assert.match(zip.text!,/notes.txt/);assert.doesNotMatch(zip.text!,/SECRET CONTENT/);
 await fs.writeFile(path.join(root,'bomb.docx'),zipSync({'word/document.xml':new Uint8Array(2*1024*1024)}));assert.equal((await projectPreview(root,'bomb.docx')).truncated,true);
});
test('large media previews are metadata only and SVG is never treated as a raster image',async()=>{
 const root=await fixture();for(const name of ['video.mp4','report.pdf']){const f=await fs.open(path.join(root,name),'w');await f.truncate(33*1024*1024);await f.close();const preview=await projectPreview(root,name);assert.equal(preview.size,33*1024*1024);assert.equal(preview.text,undefined);}
 await fs.writeFile(path.join(root,'active.svg'),'<svg onload="alert(1)"/>');await assert.rejects(new ThumbnailCache().read(root,'active.svg'),(e:any)=>e.code==='IMAGE_TYPE');
});
test('resumable chunks enforce ownership, byte identity, hash, limits, idempotent commit and expiry',async()=>{
 const root=await fixture(),data=Buffer.alloc(CHUNK_BYTES+10,7),hash=createHash('sha256').update(data).digest('hex');let now=1000,saves=0;
 const uploads=new UploadSessions(async()=>{saves++;return {path:'.codex-uploads/saved.bin'};},()=>now),a=uploads.begin('a',root,'file.bin',data.length,hash);
 assert.throws(()=>uploads.status('b',root,a.id));assert.throws(()=>uploads.status('a',root+'x',a.id));assert.throws(()=>uploads.begin('a',root,'file.bin',MAX_UPLOAD_BYTES+1,hash));
 uploads.append('a',root,a.id,0,data.subarray(0,CHUNK_BYTES));assert.equal(uploads.begin('a',root,'file.bin',data.length,hash).offset,CHUNK_BYTES);uploads.append('a',root,a.id,0,data.subarray(0,CHUNK_BYTES));assert.throws(()=>uploads.append('a',root,a.id,0,Buffer.alloc(CHUNK_BYTES,8)));
 await assert.rejects(uploads.commit('a',root,a.id));uploads.append('a',root,a.id,CHUNK_BYTES,data.subarray(CHUNK_BYTES));await Promise.all([uploads.commit('a',root,a.id),uploads.commit('a',root,a.id)]);assert.equal(saves,1);await uploads.commit('a',root,a.id);assert.equal(saves,1);
 const bad=uploads.begin('a',root,'bad.bin',1,'0'.repeat(64));uploads.append('a',root,bad.id,0,Buffer.from([1]));await assert.rejects(uploads.commit('a',root,bad.id),(e:any)=>e.code==='UPLOAD_HASH');now+=16*60000;assert.throws(()=>uploads.status('a',root,a.id));
});
test('stream limits and external URL validation reject SSRF and never follow an unsafe redirect',async()=>{
 await assert.rejects(readBounded(Readable.from([Buffer.alloc(9)]),8));
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:8.8.8.8','224.0.0.1'])assert.equal(publicAddress(ip),false,ip);assert.equal(publicAddress('8.8.8.8'),true);
 for(const url of ['http://example.com/a','https://example.com:444/a','https://user:pass@example.com/a','https://127.0.0.1/a','https://example.com.evil.test/a'])assert.throws(()=>allowedUrl(url,['example.com']));
 const root=await fixture();let calls=0;await assert.rejects(downloadExternal(root,'a.txt','https://example.com/a',['example.com'],async()=>{calls++;return {data:Buffer.alloc(0),status:302,location:'https://127.0.0.1/private'};}));assert.equal(calls,1);
});
test('normalization preserves public image paths and duration without leaking credentials or base64',()=>{
 const root=process.platform==='win32'?'C:\\project':'/project',local=path.join(root,'picture.png');const item=normalizeItem({id:'image',type:'agentMessage',text:`![output](${local})`,durationMs:1234},root,'turn');assert.equal(item.images?.[0].path,'picture.png');assert.equal(item.turnId,'turn');assert.equal(item.durationMs,1234);
 for(const value of ['../escape.png','.codex/auth.json','data:image/png;base64,AAAA','file:///etc/private.png'])assert.equal(imageReference(value,root),undefined);
 assert.equal(imageReference(path.join(root,'..','private.png'),root),undefined);
});
test('thumbnail cache coalesces full-image work and enforces its actual byte budget',async()=>{
 const root=await fixture();await fs.writeFile(path.join(root,'photo.png'),'placeholder');let calls=0;const cache=new ThumbnailCache(async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {data:Buffer.alloc(12),type:'image/webp'};});
 await Promise.all([cache.read(root,'photo.png',true),cache.read(root,'photo.png',true)]);assert.equal(calls,1);await cache.read(root,'photo.png');await cache.read(root,'photo.png');assert.equal(calls,2);
 await assert.rejects(new ThumbnailCache(async()=>({data:Buffer.alloc(256*1024+1),type:'image/webp'})).read(root,'photo.png'));
});
