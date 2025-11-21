# Noclip Memory Palace

This is a fork of the beautiful noclip.website. What we're adding in this repo is the ability to use the game environments as a virtual memory palace. Navigate 3D spaces and place interactive markers to associate information with locations. All of the hard stuff was done by the original maintainers of this repo! We stand on the shoulders of giants.

## Getting Started

To run the development server:

```bash
pnpm run start
```

This will build the Rust components and start the development server. The site will be available at the URL shown in the terminal (typically http://localhost:3000).

## Downloading Scene Data

To use Zelda: Ocarina of Time scenes locally, you need to download the scene files from noclip.website.

### Quick Download

```bash
# Create the data directory
mkdir -p data/ZeldaOcarinaOfTime

# Download Kokiri Forest (example)
cd data/ZeldaOcarinaOfTime
wget https://z.noclip.website/ZeldaOcarinaOfTime/spot04_scene.zelview0

# Download Inside the Deku Tree
wget https://z.noclip.website/ZeldaOcarinaOfTime/ydan_scene.zelview0
```

### Available Scenes

Scene files are hosted at: `https://z.noclip.website/ZeldaOcarinaOfTime/[scene_id].zelview0`

Common scene IDs:
- `spot04_scene` - Kokiri Forest
- `ydan_scene` - Inside the Deku Tree
- `ydan_boss_scene` - Deku Tree Boss Room
- `spot01_scene` - Kakariko Village
- `spot00_scene` - Hyrule Field
- See `src/zelview/scenes.ts` for the full list

## Memory Palace Features

### Billboards
Place interactive billboards in the 3D world to associate information with locations. Billboards are **scene-specific** - each map has its own set of billboards that persist between sessions.

**Controls:**
- **Spawn Billboard**: Use the "+ Spawn Billboard Here" button in the Billboard Controls panel
- **Edit Text**: Select a billboard and edit its dialogue text
- **Navigate**: Use Previous/Next buttons to cycle through and teleport to billboards
- **Set Viewing Angle**: Position your camera and click "📷 Set Default Viewing Angle" to save your preferred view
- **Warp Billboards**: Check "🌀 Warp Billboard" to create portals between scenes (e.g., Kokiri Forest ↔ Deku Tree)

### Collision Mode
- **Control Key**: Press `Control` (left or right) to toggle noclip mode
  - **Noclip ON**: Pass through walls, doors, and small spaces (gravity still applies)
  - **Noclip OFF**: Normal collision detection

### Persistence
- **Auto-Save**: All billboard changes automatically save to browser localStorage
- **Export/Import**: Use 💾 Export JSON / 📂 Import JSON buttons to save/load billboard configurations
- **Scene-Specific**: Each scene (Kokiri Forest, Deku Tree, etc.) has independent billboard data

## Controls

Key | Description
-|-
`Z` | Show/hide all UI
`T` | Open "Games" list
`C` | Show/hide dialog box for nearby markers
`Control` | Toggle noclip mode (pass through walls)
`W`/`A`/`S`/`D` or Arrow Keys | Move camera
Hold `Shift` | Make camera move faster
Hold `\` | Make camera move slower
`E` or `Page Up` or `Space` | Move camera up
`Q` or `Page Down` or `Ctrl+Space` | Move camera down
`Scroll Wheel` | Adjust camera movement speed (in WASD camera mode; instead changes the zoom level in Orbit or Ortho camera modes)
`I`/`J`/`K`/`L` | Tilt camera
`O` | Rotate camera clockwise
`U` | Rotate camera counterclockwise
`1`/`2`/`3`/`4`/`5`/`6`/`7`/`8`/`9` | Load savestate
`Shift`+`1`/`2`/`3`/`4`/`5`/`6`/`7`/`8`/`9` | Save savestate
`Numpad 3` | Export save states
`Numpad 7` or `[` | Take screenshot
`.` | Freeze/unfreeze time
`,` | Hold to slowly move through time
`F9` | Reload current scene
`B` | Reset camera position back to origin
`R` | Start/stop automatic orbiting (requries Orbit or Ortho camera modes)
`Numpad 5` | Immediately stop all orbiting (requries Orbit or Ortho camera modes)
`Numpad 2`/`Numpad 4`/`Numpad 6`/`Numpad 8` | Snap view to front/left/right/top view (requires Orbit camera mode)
`F` | Not sure what this key does, let me know if you figure it out