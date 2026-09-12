'use strict';
const {Transform}=require('node:stream');
const {performance}=require('node:perf_hooks');
// One budget per direction for the whole proxy, not one per request.
class TransferBudget{
 constructor(bytesPerSecond){if(!Number.isFinite(bytesPerSecond)||bytesPerSecond<=0)throw Error('Invalid transfer rate');this.rate=bytesPerSecond;this.next=0;}
 reserve(bytes){const now=performance.now();this.next=Math.max(now,this.next)+bytes/this.rate*1000;return Math.max(0,this.next-now);}
 stream(){const budget=this;return new class extends Transform{
  _transform(chunk,_encoding,done){let offset=0;const pump=()=>{if(this.destroyed)return;const part=chunk.subarray(offset,Math.min(offset+65536,chunk.length));offset+=part.length;this.timer=setTimeout(()=>{this.timer=null;if(this.destroyed)return;this.push(part);if(offset<chunk.length)pump();else done();},budget.reserve(part.length));};if(chunk.length)pump();else done();}
  _destroy(error,done){clearTimeout(this.timer);done(error);}
 }({highWaterMark:65536});}
}
module.exports={TransferBudget};
