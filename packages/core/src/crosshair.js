
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XenonCrosshairModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const defaults = Object.freeze({ mode: 'draw', shape: 'cross', color: '#65F5BA', size: 20,
    length: 8, thickness: 2, gap: 4, outline: true, centerDot: false, imageSize: 64, asset: null, assetName: '' });
  const keys = Object.keys(defaults);
  const assetPattern = /^[a-f0-9]{64}\.(png|gif|jpg)$/;
  const bounds = { size: [8, 48], length: [2, 20], thickness: [1, 6], gap: [0, 12], imageSize: [8, 128] };
  function fail(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
  function validatePatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid crosshair settings.');
    const entries = Object.entries(value);
    if (!entries.length) fail('Choose a crosshair setting.');
    const result = {};
    for (const [key, v] of entries) {
      if (!keys.includes(key) && key !== 'enabled' && key !== 'center') fail('Unknown crosshair setting.');
      if (bounds[key] && (!Number.isInteger(v) || v < bounds[key][0] || v > bounds[key][1])) fail(key + ' is outside its allowed range.');
      if (['enabled', 'outline', 'centerDot'].includes(key) && typeof v !== 'boolean') fail(key + ' must be true or false.');
      if (key === 'center' && v !== true) fail('Center must be true.');
      if (key === 'mode' && !['draw', 'image'].includes(v)) fail('Choose Draw or Image / GIF.');
      if (key === 'shape' && !['cross', 'dot', 'ring', 't'].includes(v)) fail('Invalid crosshair shape.');
      if (key === 'color' && (typeof v !== 'string' || !/^#[a-f0-9]{6}$/i.test(v))) fail('Use a six-digit hex color.');
      if (key === 'asset' && v !== null && (typeof v !== 'string' || !assetPattern.test(v))) fail('Invalid crosshair image.');
      if (key === 'assetName' && (typeof v !== 'string' || v.length > 120 || /[\x00-\x1f\x7f]/.test(v))) fail('Invalid image name.');
      result[key] = key === 'color' ? v.toUpperCase() : v;
    }
    return result;
  }
  function settings(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid crosshair settings.');
    const picked = {};
    for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) picked[key] = value[key];
    return { ...defaults, ...(Object.keys(picked).length ? validatePatch(picked) : {}) };
  }
  function drawable(value) {
    const out = settings(value);
    if (out.mode === 'image' && !out.asset) fail('Choose an image first.');
    return out;
  }
  return { defaults, keys, assetPattern, validatePatch, settings, drawable };
});
