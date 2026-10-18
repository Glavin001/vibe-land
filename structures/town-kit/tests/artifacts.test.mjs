import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {readArtifact} from '../scripts/artifacts.mjs';
import {sha} from '../scripts/provenance.mjs';

test('lossless compressed recordings preserve logical bytes and acceptance hashes',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'town-kit-artifacts-'));
 try{
  const data=Buffer.from('{"frames":[{"time":31.5,"label":"café","broken":[4,9]}]}\n');
  const plain=path.join(dir,'plain.json'),compressed=path.join(dir,'compressed.json');
  await writeFile(plain,data);await writeFile(`${compressed}.gz`,gzipSync(data));
  const compact=path.join(dir,'compact.json');await writeFile(`${compact}.br`,brotliCompressSync(data));
  assert.deepEqual(await readArtifact(compact),data);assert.equal(sha(await readArtifact(compact)),sha(data));
  assert.deepEqual(await readArtifact(compressed),data);
  assert.equal(sha(await readArtifact(plain)),sha(await readArtifact(compressed)));
  assert.deepEqual(JSON.parse(await readArtifact(compressed,'utf8')),JSON.parse(data));
  // A current uncompressed artifact must take precedence over an older archive.
  await writeFile(`${plain}.gz`,gzipSync('stale'));
  assert.deepEqual(await readArtifact(plain),data);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('missing or corrupt recording archives fail rather than yielding evidence',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'town-kit-artifacts-'));
 try{
  await assert.rejects(readArtifact(path.join(dir,'missing.json')),{code:'ENOENT'});
  const file=path.join(dir,'corrupt.json');await writeFile(`${file}.gz`,'not a gzip stream');await writeFile(`${file}.br`,brotliCompressSync('valid but stale'));
  const bad=path.join(dir,'bad-brotli.json');await writeFile(`${bad}.br`,'corrupt');await assert.rejects(readArtifact(bad));
  await assert.rejects(readArtifact(file));
 }finally{await rm(dir,{recursive:true,force:true});}
});
