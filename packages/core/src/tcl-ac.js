;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.tclAc = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Explicit mapping from the owner's verified TCL handoff. Do not infer sibling
  // entities from friendly names or attach these controls to other thermostats.
  const prefix = 'split_ac_c8emtcvgaae_';
  const profile = Object.freeze({
    climate: 'climate.' + prefix + 'climate',
    fan: 'select.' + prefix + 'wind_speed',
    vertical: 'select.' + prefix + 'up_and_down_air_supply',
    horizontal: 'select.' + prefix + 'left_and_right_air_supply',
    sleep: 'select.' + prefix + 'sleep_mode',
    eco: 'switch.' + prefix + 'eco_switch',
    soft: 'switch.' + prefix + 'soft_wind',
    display: 'switch.' + prefix + 'diplay_light_switch',
    beep: 'switch.' + prefix + 'beep_mode_switch',
    current: 'sensor.' + prefix + 'current_temperature',
  });
  const ids = Object.freeze(Object.values(profile));
  const allowedModes = ['off', 'cool', 'dry', 'fan_only', 'auto'];
  const available = (e) => !!e && typeof e.state === 'string' && !['unknown', 'unavailable', ''].includes(e.state);
  const modes = (e) => allowedModes.filter((m) => e && Array.isArray(e.hvacModes) && e.hvacModes.includes(m));
  function temperature(e) {
    const usable = e && [e.target, e.min, e.max, e.step].every(Number.isFinite)
      && e.min <= e.max && e.step > 0 && (e.features === undefined || (e.features & 1) !== 0);
    return { usable: !!usable, target: e && e.target, min: e && e.min, max: e && e.max, step: e && e.step };
  }
  function validate(domain, service, id, data, entities) {
    if (!ids.includes(id)) return null; // Other HA devices retain their existing service contract.
    const e = entities.find((x) => x.id === id);
    const climate = entities.find((x) => x.id === profile.climate);
    if (!available(climate) || !available(e)) return 'tcl_unavailable';
    if (domain !== id.split('.')[0] || !data || typeof data !== 'object' || Array.isArray(data)) return 'tcl_bad_service';
    const keys = Object.keys(data);
    if (id === profile.climate && service === 'set_hvac_mode' && keys.length === 1 && modes(e).includes(data.hvac_mode)) return null;
    if (id === profile.climate && service === 'set_temperature' && keys.length === 1) {
      const v = data.temperature, range = temperature(e);
      if (range.usable && Number.isFinite(v) && v >= range.min && v <= range.max
        && Math.abs((v - range.min) / range.step - Math.round((v - range.min) / range.step)) < 1e-6) return null;
    }
    if (domain === 'select' && service === 'select_option' && keys.length === 1 && Array.isArray(e.options) && e.options.includes(data.option)) return null;
    if (domain === 'switch' && ['turn_on', 'turn_off'].includes(service) && keys.length === 0 && ['on', 'off'].includes(e.state)) return null;
    return 'tcl_unsupported_value';
  }
  return { title: 'แอร์ห้องนอน', profile, ids, available, modes, temperature, validate };
});
