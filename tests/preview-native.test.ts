import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ThumbnailCache} from '../src/backend/previews';
test('real native PNG/JPEG/WebP/AVIF encoding yields small thumbnails and full-size click-through images',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'webui-native-images-')),width=1600,height=1000,data=Buffer.alloc(width*height*3);for(let i=0;i<data.length;i++)data[i]=(i*73+(i>>7)*29)%256;
 for(const format of ['png','jpeg','webp','avif'] as const){const source=await sharp(data,{raw:{width,height,channels:3}})[format]().toBuffer();const name='photo.'+format;await fs.writeFile(path.join(root,name),source);const cache=new ThumbnailCache(),thumb=await cache.read(root,name),full=await cache.read(root,name,true),tm=await sharp(thumb.data).metadata(),fm=await sharp(full.data).metadata();assert.ok(tm.width!<=384&&tm.height!<=384);assert.ok(thumb.data.length<=256*1024);assert.ok(thumb.data.length<source.length);assert.equal(fm.width,width);assert.equal(fm.height,height);assert.equal((await cache.read(root,name)).etag,thumb.etag);}
 await fs.writeFile(path.join(root,'corrupt.png'),'not an image');await assert.rejects(new ThumbnailCache().read(root,'corrupt.png'));
});
