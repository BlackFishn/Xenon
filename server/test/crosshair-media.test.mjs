
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../../packages/core/src/crosshair');
const { imageInfo, createMediaStore } = require('../crosshair-media');
const { createCrosshairControl } = require('../crosshair-control');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAYAAADuFn/PAAAAlklEQVR4nO3ZsQ2DMABFQZM2e2WTTMUm7JUaWnoiPVm+69xhPZnmjwEAsKJtTOz7O877eX9/prvPq/6A1QkQEyAmQEyAmAAxAWICxASICRATICZATICYADEBYgLEtn+PIivaHwxBXkBMgJgAselG7DujPI/5BcUEiAkQEyAmQEyAmAAxAWICxASICRATICZATAAAYCzpAqWRDEiQ9+uJAAAAAElFTkSuQmCC','base64');
const gif = Buffer.from('R0lGODlhQABAAIEAAAAAAEvM/wAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJHgAAACwAAAAAQABAAAAIygABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyAdBhg5MqRGkiVNYkQZQOVKlC4vsoxpcSZNijZvSsypEyLPniJhAvUpdGhQkkYf/kyacCnTg06fFowqdSDVqgCuVtUqletTr0zBymRJtqzZs2iRHk3Lti1apW7jylXbcK5dt3Dv6jUbU6xRv0MBAxXck7BOwzcR01TctyhWg4xdRlY52WTlkJdBZv642WPnjp85ht44+qTjxwRLo17NurXr17BhBwQAIfkECR4AAAAsCAAIADEAMQCBAAAA/150AAAAAAAACKsAAQgcSLCgQQABEiY8yLChQ4cKFz6cSPFgxAAVM2a8qLHjQ44eQxoEKbIkwogmTZJM6XElS40uX1aMKXMizZoQUeLcqHMnxZs+R/YMmlMhUZtDj1pMqrQg0KZPlUb9eLGq1atYs2rdyrWr169gw4odS7YsxpJTiaYNutZn251vccatOVdm3Zd3WeZNuVcl06YD+6L9C/ik0cJCDyMmKFhk45CPWxIGHLnj3oAAOw==','base64');
async function fixture(t) {
  const parent=path.resolve('.tmp');
  await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'crosshair-media-'));
  const folder=path.join(root,'Packages','Xenon.Crosshair_0123456789abc','LocalState');
  await fs.mkdir(folder,{recursive:true});
  t.after(async()=>{
    assert.equal(path.dirname(root),parent);
    assert.ok(path.basename(root).startsWith('crosshair-media-'));
    await fs.rm(root,{recursive:true});
  });
  return {root,folder,store:createMediaStore(async()=>folder)};
}
test('drawing settings validate every trust boundary',()=>{
  assert.equal(model.validatePatch({color:'#aabbcc'}).color,'#AABBCC');
  for(const patch of [{mode:'video'},{shape:'html'},{length:NaN},{gap:-1},{thickness:7},{imageSize:129},{outline:1},{centerDot:'true'},{asset:'../../secret'},{assetName:'bad\nname'}])
    assert.throws(()=>model.validatePatch(patch));
  assert.throws(()=>model.drawable({mode:'image'}),/Choose an image/);
});
test('image inspection keeps animated GIF frames and bounds decode dimensions',()=>{
  assert.deepEqual(imageInfo(png),{width:96,height:48,type:'image/png',extension:'png',frames:1});
  assert.equal(imageInfo(gif).frames,2);
  const wide=Buffer.from(png);wide.writeUInt32BE(2049,16);
  for(const data of [Buffer.from('<svg/>'),Buffer.alloc(5*1024*1024+1),png.subarray(0,30),gif.subarray(0,gif.length-1),wide])
    assert.throws(()=>imageInfo(data));
});
test('uploads deduplicate, persist unchanged GIF bytes, and presets survive a new controller',async t=>{
  const {folder,store}=await fixture(t);
  const asset=await store.upload(gif,'my.gif');
  assert.match(asset.asset,/^[a-f0-9]{64}\.gif$/);
  assert.equal((await store.upload(gif,'same.gif')).asset,asset.asset);
  assert.deepEqual((await store.read(asset.asset)).data,gif);
  const row=await store.savePreset({name:'My animated aim',settings:{...model.defaults,mode:'image',asset:asset.asset,assetName:asset.assetName,imageSize:91}});
  const reloaded=createMediaStore(async()=>folder);
  assert.deepEqual(await reloaded.presets(),[row]);
  await reloaded.deletePreset(row.id);
  assert.deepEqual(await store.presets(),[]);
});
test('paths, file tampering and redirected media folders cannot escape package storage',async t=>{
  const {folder,store}=await fixture(t);
  const asset=await store.upload(png,'../../name.png');
  await assert.rejects(store.read('../../anything'));
  const file=path.join(folder,'crosshair-assets',asset.asset);
  await fs.writeFile(file,gif);
  await assert.rejects(store.read(asset.asset),/has changed/);
  const assets=path.join(folder,'crosshair-assets');
  await fs.rename(assets,assets+'-real');
  await fs.symlink(assets+'-real',assets,'junction');
  await assert.rejects(store.upload(png,'safe.png'),/Invalid image storage/);
});
test('custom settings require v2 and a readable image, then wait for actual widget acknowledgement',async t=>{
  const {root,folder,store}=await fixture(t);
  const now=4_000_000;
  let current={...model.defaults,version:2,updatedAt:now,running:true,enabled:false,pinned:true,visible:true,clickThrough:true,error:'',commandId:''};
  const publish=()=>fs.writeFile(path.join(folder,'xenon-crosshair-status.json'),JSON.stringify(current));
  await publish();
  const api=createCrosshairControl({platform:'win32',localAppData:root,now:()=>now,sleep:async()=>{
    const command=JSON.parse(await fs.readFile(path.join(folder,'xenon-crosshair-command.json'),'utf8'));
    current={...current,...command,version:2,updatedAt:now,commandId:command.id};
    await publish();
  }});
  const asset=await store.upload(gif,'animated.gif');
  const state=await api.send({mode:'image',asset:asset.asset,assetName:asset.assetName,imageSize:88,enabled:true});
  assert.equal(state.imageSize,88);assert.equal(state.mode,'image');assert.equal(state.enabled,true);assert.equal(state.protocol,2);
  current={...current,shape:'ring',mode:'draw',length:11};await publish();
  assert.equal((await api.status()).shape,'ring','Game Bar changes are reflected back to Xenon');
  current.version=1;await publish();
  await assert.rejects(api.send({shape:'dot'}),/Update Xenon/);
  current.version=2;await publish();
  await assert.rejects(api.send({mode:'image',asset:'0'.repeat(64)+'.png'}),/missing/);
});
test('failed native image decode returns an error without reporting the requested design',async t=>{
  const {root,folder}=await fixture(t),now=4_000_000;
  const good={...model.defaults,version:2,updatedAt:now,running:true,enabled:false,pinned:true,visible:true,clickThrough:true,error:'',commandId:''};
  const file=path.join(folder,'xenon-crosshair-status.json');
  await fs.writeFile(file,JSON.stringify(good));
  const api=createCrosshairControl({platform:'win32',localAppData:root,now:()=>now,sleep:async()=>{
    const command=JSON.parse(await fs.readFile(path.join(folder,'xenon-crosshair-command.json'),'utf8'));
    await fs.writeFile(file,JSON.stringify({...good,error:'image_failed',commandId:command.id}));
  }});
  await assert.rejects(api.send({enabled:true}),/could not load/);
  assert.equal((await api.status()).enabled,false);
});
