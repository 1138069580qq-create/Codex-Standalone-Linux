const fs=require('node:fs');const path=require('node:path');const zlib=require('node:zlib');
const files=['index.html','style.css','state.js','app.js'];let raw=0,gzip=0,br=0;
const assets=files.map(file=>{const body=fs.readFileSync(path.join(__dirname,'../public',file));const row={file,raw:body.length,gzip:zlib.gzipSync(body).length,br:zlib.brotliCompressSync(body).length};raw+=row.raw;gzip+=row.gzip;br+=row.br;return row;});
console.log(JSON.stringify({assets,total:{raw,gzip,br},brotliReductionPercent:Math.round((1-br/raw)*1000)/10,note:'Payload bytes only: headers/TLS excluded. JSON/SSE are measured separately; this is not a comparison against the original panel.'},null,2));
