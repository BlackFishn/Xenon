# TCL air conditioner in Xenon

This fork implements the owner's `xenon-ac-handoff` package as native Xenon UI.
The reference Lovelace card is not loaded or installed. Controls live in the existing
Smart Home renderer and use the existing Node Home Assistant connection, service
route, compact snapshots and `homeassistant` SSE events.

## User interface and selection

Select `climate.split_ac_c8emtcvgaae_climate` under Settings → Smart Home. Its four
selects, four switches and current-temperature sensor are included together.
The title is **แอร์ห้องนอน**, as in `ac-card.config.json`. Removing the climate
selection removes this group; selecting other devices is unchanged.

The same grouped card appears in both Rooms and Custom. It uses the climate
entity's saved order and section; companion entities do not get duplicate cards.
Other devices keep their order, sections, sizes and controls, including other
thermostats. Missing registry/device/area metadata does not prevent TCL grouping.
Custom AC cards use at least half a wide grid; one saved height step equals four
ordinary rows, with scrolling when controls exceed the chosen height. At narrow
widths the card spans the grid. The existing dashboard edit controls resize/move it.

The card includes power, target temperature, room temperature, mode, fan speed,
vertical swing, horizontal swing, ECO and soft wind. More settings contains sleep,
display light and beep. The disclosure remains within the same card. State and
pending commands are shared across duplicated Smart Home widgets.

## Exact entity contract

The explicit mapping is in `packages/core/src/tcl-ac.js`. This is deliberately
the supplied device profile, not name-based discovery for arbitrary thermostats.
If HA entity IDs are renamed, update that mapping and its tests.

| Role | Entity ID |
| --- | --- |
| Main | `climate.split_ac_c8emtcvgaae_climate` |
| Fan | `select.split_ac_c8emtcvgaae_wind_speed` |
| Vertical swing | `select.split_ac_c8emtcvgaae_up_and_down_air_supply` |
| Horizontal swing | `select.split_ac_c8emtcvgaae_left_and_right_air_supply` |
| Sleep | `select.split_ac_c8emtcvgaae_sleep_mode` |
| ECO | `switch.split_ac_c8emtcvgaae_eco_switch` |
| Soft wind | `switch.split_ac_c8emtcvgaae_soft_wind` |
| Display | `switch.split_ac_c8emtcvgaae_diplay_light_switch` |
| Beep | `switch.split_ac_c8emtcvgaae_beep_mode_switch` |
| Room-temperature fallback | `sensor.split_ac_c8emtcvgaae_current_temperature` |

`diplay` is the real entity spelling. `climate.living_room_a_c` and Google Assistant
are not used by this card. Fan speed goes through its sibling select, not
`climate.set_fan_mode`.

Both settings normalizers append companions without changing other settings.
The existing 100 general-entity limit remains, with up to nine extra fixed TCL
companions so grouping cannot evict another selected device. Normalization is
idempotent. No source code writes directly to `server/data`.

## Service, capability and state handling

All commands POST `/api/homeassistant/service` with `{domain, service, entityId, data}`:

| Action | Service | Data |
| --- | --- | --- |
| Power/mode | `climate.set_hvac_mode` | `{ "hvac_mode": "cool" }` or another allowed live mode |
| Target | `climate.set_temperature` | `{ "temperature": 26 }` |
| Select | `select.select_option` | `{ "option": "Medium" }` with the exact live raw string |
| Switch | `switch.turn_on` / `switch.turn_off` | `{}` |

Modes are the intersection of live capabilities and `off`, `cool`, `dry`,
`fan_only`, `auto`. `heat` is excluded even if the integration advertises it.
Power-on restores the last observed supported non-off mode, then prefers `cool`.
Target range, step, supported-feature bit and select options come from current HA
state. Unknown numeric capabilities disable temperature editing. The backend
applies the same profile validation before forwarding; unrelated devices retain
their existing service contract.

The climate's current temperature takes precedence over the sibling sensor.
Units come from HA's `temperature_unit` or the sensor's unit; no conversion or
guessed setpoint range is applied.

A service acknowledgement does not change displayed state. One command is allowed
per device at a time; the card waits for matching HA state. HTTP failure,
`{ok:false}`, request timeout (12 seconds) or no matching readback (18 seconds after
acknowledgement) leaves visible feedback and requires **Refresh state** before
retrying. Refresh calls the existing state route with `?refresh=1`, which asks HA
for a fresh snapshot through the existing WebSocket. There are no automatic
command retries and no additional polling loop.

Main climate missing/unknown/unavailable, backend HA disconnect, or browser SSE
disconnect disables commands. A missing sibling disables only that control.
Reconnect is reported ready only after HA state has been reseeded. Native dropdowns
and pointer gestures are not replaced mid-interaction; button focus is restored
after other devices update. Disabled/busy state also applies to duplicate cards.

Credentials remain in Xenon's existing server-side settings flow. The browser
never receives an HA token; no new login path, HA URL, direct browser HA request,
Origin exception or Widget SDK permission was added.

## Mock validation

Work in a feature checkout from `production`, following `INSTRUCTURE.md`.
Never use port 3030 or the daily-use data/profile for tests.

```powershell
rtk npm install
rtk proxy node --test server/test/tcl-ac.test.mjs server/test/home-assistant.test.mjs server/test/smart-home-layout.test.mjs
rtk npm test
rtk proxy node tools/test-tcl-ac-ui.mjs
rtk git diff --check
```

The optional browser runner uses an existing Playwright installation. Set
`PLAYWRIGHT_MODULE` to its module path and, if needed,
`PLAYWRIGHT_EXECUTABLE_PATH` to the installed browser. `TCL_TEST_PORT` defaults to
3031 and explicitly refuses 3030. `TCL_TEST_OUTPUT` selects a screenshot directory.
It starts mock HA on an ephemeral loopback port, executes the production service
and state route bodies with mock I/O, serves the real Smart Home module/CSS, and
creates a fresh browser context. It reads no runtime settings and writes no
`server/data`. Stop the runner before starting another backend on the test port.

Coverage includes all control payloads, no optimistic state, rapid duplicate
clicks, two widget instances, missing/unavailable entities, fallback temperature,
range/step boundaries, power mode restoration, reconnect readiness, HTTP and
application errors, confirmation timeout/refresh, keyboard/focus, selection,
unrelated device updates, token redaction and the production loopback Origin guard.
Layout checks cover 2560×720, desktop, portrait and 320px, including access to the
advanced controls by scrolling.

## Real-device verification still required

After mock validation, read-only discovery on 2026-09-30 found all ten mapped
entities. At that observation HA reported Cool, target 25°C, room 26°C, fan Medium,
vertical Up and down swing, horizontal Not set, sleep off, and all four switches
off. The reported range was 16–36°C with a 1°C step. These are observations, not
hardcoded defaults. No physical AC command was used for that discovery.

Physical follow-up must verify compressor/power response, temperature changes,
actual fan speed, both swing motors, ECO/soft wind interactions, sleep mode,
display light and beep. HA readback alone cannot prove those physical effects.
Before testing, record the current device state; use bounded changes, observe the
unit, then restore the recorded settings. Also confirm TCL cloud latency fits the
confirmation window and whether switching modes resets companion values.
