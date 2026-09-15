# Game Bar crosshair

Open the **crosshair icon in Xenon's side menu**. The System → FPS shortcut opens the same controls.

First open **Win + G → Widgets → Xenon Crosshair**, pin it, and enable click-through. Put Game Bar on the game display before using Center. A newly launched widget starts OFF; closing Xenon's control panel leaves the overlay state unchanged.

- **Draw:** Cross, Dot, Ring or T-shape, custom color, length/radius, thickness, gap, black outline and center dot.
- **Image / GIF:** choose or drop PNG, JPG, GIF or WebP. GIF animation and transparency are preserved. WebP imports its still image as PNG so Windows does not need an optional codec. Set the longest side to 8–128 Windows logical pixels; the aspect ratio is preserved.
- **Presets:** save a name and the complete design, including its image. Presets survive browser and widget restarts. Select a saved preset to apply it, or remove it with Delete.
- **Two-way state:** changes made in Game Bar appear back in Xenon. Edits are combined while dragging; ON/OFF reflects the widget's acknowledgement. Failed commands keep the last confirmed overlay and show a retry action.

The editor preview stays visible while the game overlay is OFF. Its label distinguishes the preview from the confirmed game state. Offline edits wait for Game Bar to reconnect; turning the overlay ON requires a live widget.

Images are local only, limited to 5 MB and 2048 × 2048 pixels. GIFs are limited to 300 frames and 64 million decoded canvas pixels across their frames. The per-widget store permits 32 presets and up to 64 unique images / 128 MB; removing a preset does not erase its image. Files are content-addressed inside the current user's Game Bar package LocalState, not arbitrary filesystem paths. No image data is sent to an external service.

See the [widget guide](../apps/game-bar-crosshair/README.md) for installation, local build requirements and platform limits.
