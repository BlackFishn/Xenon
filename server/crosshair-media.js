
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('./atomic-write');
const model = require('../packages/core/src/crosshair');
const MAX_BYTES = 5 * 1024 * 1024;
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }

function imageInfo(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_BYTES) fail('Choose an image up to 5 MB.');
  let width, height, type, extension, frames = 1;
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(8) === 13) {
    type = 'image/png'; extension = 'png'; width = data.readUInt32BE(16); height = data.readUInt32BE(20);
    if (data.length < 45 || data.toString('ascii', data.length - 8, data.length - 4) !== 'IEND') fail('Incomplete PNG image.');
  } else if (data.length >= 14 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) {
    type = 'image/gif'; extension = 'gif'; width = data.readUInt16LE(6); height = data.readUInt16LE(8);
    let offset = 13 + ((data[10] & 128) ? 3 * (2 ** ((data[10] & 7) + 1)) : 0);
    frames = 0;
    function skipBlocks() {
      while (offset < data.length) {
        const length = data[offset++];
        if (!length) return;
        offset += length;
      }
      fail('Incomplete GIF image.');
    }
    while (offset < data.length && data[offset] !== 0x3b) {
      const marker = data[offset++];
      if (marker === 0x21) { offset++; skipBlocks(); }
      else if (marker === 0x2c) {
        if (offset + 9 > data.length) fail('Incomplete GIF frame.');
        const w = data.readUInt16LE(offset + 4), h = data.readUInt16LE(offset + 6);
        if (!w || !h || w > width || h > height) fail('Invalid GIF frame.');
        const flags = data[offset + 8]; offset += 9;
        if (flags & 128) offset += 3 * (2 ** ((flags & 7) + 1));
        offset++; skipBlocks(); frames++;
        if (frames > 300 || width * height * frames > 64 * 1024 * 1024) fail('GIF is too large to animate. Use a smaller or shorter GIF.');
      } else fail('Invalid GIF image.');
    }
    if (!frames || offset !== data.length - 1 || data[offset] !== 0x3b) fail('Incomplete GIF image.');
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data.readUInt16BE(data.length - 2) === 0xffd9) {
    type = 'image/jpeg'; extension = 'jpg';
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!type || !width || !height || width > 2048 || height > 2048) fail('Use PNG, GIF or JPG up to 2048 × 2048 px.');
  return { width, height, type, extension, frames };
}

function createMediaStore(getFolder) {
  let queue = Promise.resolve();
  function serialize(action) { const operation = queue.catch(() => {}).then(action); queue = operation; return operation; }
  async function location() {
    const root = await getFolder();
    if (!root) fail('Install and open Xenon Crosshair from Win + G first.', 409);
    return root;
  }
  async function assetsFolder() {
    const folder = path.join(await location(), 'crosshair-assets');
    await fs.mkdir(folder, { recursive: true });
    if ((await fs.realpath(folder)).toLowerCase() !== path.resolve(folder).toLowerCase()) fail('Invalid image storage.', 409);
    return folder;
  }
  async function safeRead(file, limit) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail('Invalid crosshair file.', 400);
    return fs.readFile(file);
  }
  async function read(asset) {
    if (typeof asset !== 'string' || !model.assetPattern.test(asset)) fail('Invalid image ID.');
    const data = await safeRead(path.join(await assetsFolder(), asset), MAX_BYTES).catch(e => {
      if (e.code === 'ENOENT') fail('This crosshair image is missing. Upload it again.', 404);
      throw e;
    });
    const info = imageInfo(data);
    if (asset !== createHash('sha256').update(data).digest('hex') + '.' + info.extension) fail('Crosshair image has changed. Upload it again.');
    return { data, ...info };
  }
  function upload(data, name) {
    const info = imageInfo(data);
    const assetName = typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/g, '').slice(0,120) : '';
    return serialize(async () => {
      const folder = await assetsFolder();
      const asset = createHash('sha256').update(data).digest('hex') + '.' + info.extension;
      const file = path.join(folder, asset);
      const files = (await fs.readdir(folder)).filter(f => model.assetPattern.test(f));
      if (!files.includes(asset)) {
        const sizes = await Promise.all(files.map(f => fs.lstat(path.join(folder, f))));
        if (files.length >= 64 || sizes.reduce((n,s) => n + s.size,0) + data.length > 128 * 1024 * 1024) fail('Crosshair image storage is full.', 409);
        await writeFileAtomic(file, data);
      } else await read(asset);
      return { asset, assetName, ...info };
    });
  }
  async function presets() {
    const file = path.join(await location(), 'xenon-crosshair-presets.json');
    let rows;
    try { rows = JSON.parse((await safeRead(file, 128 * 1024)).toString('utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (!Array.isArray(rows) || rows.length > 32) fail('Invalid preset storage.', 502);
    return rows.map(row => {
      if (!row || !/^[a-f0-9-]{36}$/.test(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 40) fail('Invalid preset storage.', 502);
      return { id: row.id, name: row.name, settings: model.drawable(row.settings) };
    });
  }
  function savePreset(value) {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 40 || /[\x00-\x1f\x7f]/.test(value.name)) fail('Name the preset using 1–40 characters.');
    const settings = model.drawable(value.settings);
    return serialize(async () => {
      if (settings.asset) await read(settings.asset);
      const rows = await presets();
      if (rows.length >= 32) fail('You can save up to 32 presets. Remove one first.', 409);
      const row = { id: randomUUID(), name: value.name.trim(), settings };
      rows.push(row);
      await writeFileAtomic(path.join(await location(), 'xenon-crosshair-presets.json'), JSON.stringify(rows));
      return row;
    });
  }
  function deletePreset(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('Invalid preset.');
    return serialize(async () => {
      const rows = (await presets()).filter(p => p.id !== id);
      await writeFileAtomic(path.join(await location(), 'xenon-crosshair-presets.json'), JSON.stringify(rows));
      return { ok: true };
    });
  }
  return { read, upload, presets, savePreset, deletePreset };
}
module.exports = { createMediaStore, imageInfo, MAX_BYTES };
