# TCL air conditioner in Xenon

This fork implements the owner's `xenon-ac-handoff` package as native Xenon UI.
The reference Lovelace card is not loaded or installed. Controls live in a new,
separate **TCL Air Conditioner** dashboard widget (`tcl-ac`) and use the existing Node Home
Assistant connection, service route, compact snapshots and `homeassistant` SSE events.
The existing Smart Home widget and its settings keep their original behavior.

## User interface and selection

Add **TCL Air Conditioner** from **+ → System** in the dashboard widget picker. Its title is **แอร์ห้องนอน**,
as in `ac-card.config.json`. It is not automatically added to existing dashboards.
Use the normal dashboard editing controls to move, resize, remove or duplicate it.

The widget reads the ten exact mapped entities independently of the Smart Home
entity picker, including when `homeAssistant.entities` is empty. No climate or
companion selection is required. Missing registry/device/area metadata does not
prevent the fixed profile from working.

Smart Home retains its selected entities, order, sections, sizes, Rooms/Custom
layouts and device controls. Selecting the TCL climate there creates its ordinary
climate tile; companion entities remain independently selectable. Adding, removing
or using TCL AC does not rewrite those settings. Removing TCL AC does not alter
Smart Home's selected devices.

The card includes power, target temperature, room temperature, mode, fan speed,
vertical swing, horizontal swing, ECO and soft wind. More settings contains sleep,
display light and beep. The disclosure remains within the same card. State and
pending commands are shared across duplicated TCL AC widgets.

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

The existing Smart Home entity limit and both settings normalizers remain unchanged;
they do not append this profile's companions. The backend sends the selected
Smart Home snapshot in `entities` and the separate fixed AC snapshot in `tclAc`.
The AC module is `server/js/tcl-ac-widget.js`, with styles scoped in
`server/components/TclAcWidget/TclAcWidget.css`. No source code writes directly to
`server/data`.

## Service, capability and state handling

The dedicated widget POSTs `/api/homeassistant/service` with
`{domain, service, entityId, data, profile: "tcl-ac"}`. The profile flag selects fixed
AC validation on the backend and is never forwarded to HA. Existing Smart Home
commands, including generic `homeassistant.toggle`, retain their original behavior.

The HA commands are:

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
Reconnect is reported ready only after HA state has been reseeded. Cards update in
place, preserving focused controls and pointer gestures through SSE updates.
Disabled/busy state also applies to duplicate cards. Late HTTP replies cannot
replace newer SSE state or re-enable controls after a disconnect; backend refreshes
preserve live state changes received while the snapshot request was in flight.

Credentials remain in Xenon's existing server-side settings flow. The browser
never receives an HA token; no new login path, HA URL, direct browser HA request,
Origin exception or Widget SDK permission was added.

## Mock validation

Work in a feature checkout from `production`, following `INSTRUCTURE.md`.
Never use port 3030 or the daily-use data/profile for tests.

```powershell
rtk npm install
rtk proxy node --test server/test/tcl-ac.test.mjs server/test/tcl-ac-lifecycle.test.mjs server/test/tcl-ac-wiring.test.mjs server/test/home-assistant.test.mjs server/test/smart-home-layout.test.mjs
rtk npm test
rtk proxy node tools/test-tcl-ac-ui.mjs
rtk git diff --check
```

The optional browser runner uses an existing Playwright installation. Set
`PLAYWRIGHT_MODULE` to its module path and, if needed,
`PLAYWRIGHT_EXECUTABLE_PATH` to the installed browser. `TCL_TEST_PORT` defaults to
3031 and explicitly refuses 3030. `TCL_TEST_OUTPUT` selects a screenshot directory.
It starts mock HA on an ephemeral loopback port, executes the production service
and state route bodies with mock I/O, serves the real TCL AC and Smart Home
modules/CSS, and creates a fresh browser context. It reads no runtime settings and writes no
`server/data`. Stop the runner before starting another backend on the test port.

Coverage includes all control payloads, no optimistic state, rapid duplicate
clicks, two dedicated AC widget instances beside Smart Home, independent AC data
when Smart Home has no selected entities, and preservation of Smart Home's
selections, order, sections, sizes and ordinary climate tile. It also covers
missing/unavailable entities, fallback temperature, range/step boundaries, power
mode restoration, reconnect readiness, HTTP and application errors, request and
confirmation timeout/refresh, keyboard/focus, unrelated device updates, token
redaction and the production loopback Origin guard. Layout checks cover 2560×720,
desktop, portrait and 320px, including access to advanced controls by scrolling.

## Real-device verification still required

After mock validation, read-only discovery on 2026-09-30 found all ten mapped
entities. At that observation HA reported Cool, target 25°C, room 26°C, fan Medium,
vertical Up and down swing, horizontal Not set, sleep off, and all four switches
off. The reported range was 16–36°C with a 1°C step. These are observations, not
hardcoded defaults. No real AC command has been sent as part of this implementation or its validation.

Physical follow-up must verify compressor/power response, temperature changes,
actual fan speed, both swing motors, ECO/soft wind interactions, sleep mode,
display light and beep. HA readback alone cannot prove those physical effects.
Before testing, record the current device state; use bounded changes, observe the
unit, then restore the recorded settings. Also confirm TCL cloud latency fits the
confirmation window and whether switching modes resets companion values.
