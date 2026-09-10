'use strict';

// SoundVolumeView writes /scomma exports as UTF-8 with a BOM. Reading those
// bytes as latin1 corrupts non-ASCII device names and, more importantly, the
// command-line-friendly IDs used by /Mute and /SetDefault.
function decodeSoundVolumeCsv(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  return text.replace(/^\uFEFF/, '');
}

module.exports = { decodeSoundVolumeCsv };
