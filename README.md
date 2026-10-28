<p align="center">
  <img src="assets/nomad-data-logo.png" width="84" alt="Nomad Data logo">
</p>

<h1 align="center">Census Hex Map</h1>

<p align="center"><b>Turn U.S. data into 3D hexagon posters: population, elections, COVID-19, elevation, or your own points.</b></p>

<p align="center"><img src="docs/img/hero.jpg" alt="The United States as a field of green hexagon columns: cities rise as tall dark-green peaks, empty land stays low and pale"></p>

<p align="center"><i>United States, population density: one of the posters in the <a href="#gallery">gallery</a>.</i></p>

It runs entirely in your web browser. Nothing needs installing apart from Python (for the local server), and no accounts or API keys are needed.

---

## Contents

| | |
|---|---|
| [Quick start](#quick-start) | Get the app running |
| [The screen at a glance](#screen) | What every part of the screen does |
| [Make the Missouri & Illinois election poster](#steps) | Six steps, with pictures |
| [More things to try](#more) | Static measures, timelines and GIFs, your own data, dark mode |
| [Gallery](#gallery) | Posters made with the app, and the settings behind them |
| [Troubleshooting](#troubleshooting) | Fixes for common problems |
| [Reference](#reference) | Data sources, coverage, rebuilding the data, how it works |

---

<a id="quick-start"></a>

## Quick start

| 1. Start the server | 2. Open the page |
|---|---|
| In a terminal in this folder, run:<br>`python -m http.server 8000`<br>(or `python serve.py`, the local no-cache server, if you have it) | Open your browser to:<br>**http://localhost:8000** |

> [!IMPORTANT]
> Always open the page through **http://localhost:8000** (or the GitHub Pages address). Double-clicking `index.html` opens it as a file, and the map never loads (see [Troubleshooting → Stuck on "Loading…"](#ts-blank)).

Use an up-to-date Chrome, Edge or Firefox. The map is drawn with your graphics card.

---

<a id="screen"></a>

## The screen at a glance

<img src="docs/img/ui-tour.jpg" alt="The Census Hex Map screen showing Missouri and Illinois in the 2016 presidential election, with numbered callouts">

| # | What it is | What it does |
|:-:|---|---|
| 1 | **Title and subtitle** | The place you're looking at and what's mapped. The subtitle also names the column height when it differs from the colour. Type your own title on the **Style** tab. |
| 2 | **NOMAD Data mark** | Printed on every export. |
| 3 | **Light / dark** | Switches the app, and the poster paper, between light and dark. Until you click it, it follows your computer's setting. |
| 4 | **Menu** | Shows or hides the control panel (shortcut **H**). Hide it for a clean, full-screen view. |
| 5 | **Tabs** | **Map** (what to show, and where), **Style** (how it looks) and **Export** (posters, GIFs, links). |
| 6 | **Show** | What drives the map: **Static** measures, **Elections**, **Over time** (animated timelines) or **My data** (a CSV of your own). |
| 7 | **Pickers** | The choices for the current view. Here: race, year and column height. For Static it's the measure; for Over time, the timeline. |
| 8 | **Area** | **Nation**, **States** or **Counties**, a search box, your chosen places as chips, **Re-center** and **Reset area**. |
| 9 | **The map** | Click a state or county to focus it, **Shift-click** to add or remove one. **Hover** any hexagon for its value. |
| 10 | **Legend** | The colour scale. It changes with the measure; elections use a fixed D+60 to R+60 scale. |
| 11 | **Source and notes** | Where the data comes from, and what each hexagon is built from, for example *Precincts aggregated to 6 mi hexagons*. |

Hovering a hexagon shows its place, value and details:

<img src="docs/img/tooltip.jpg" width="480" alt="A tooltip over St. Clair County, Illinois reading D+23.3, 2016 Presidential Election, 73,335 votes cast">

**Keyboard:** **H** hides or shows the panel · **F** re-centres the map · **Space** plays or pauses a timeline · **Esc** closes a dialog.

---

<a id="steps"></a>

## Make the Missouri & Illinois election poster

<p align="center"><img src="docs/img/walkthrough-result-1x1.jpg" width="560" alt="The finished square poster: Missouri and Illinois in red hexagons, with Chicago, St. Louis and Kansas City rising as blue columns"></p>

**Every setting used for this poster:**

| Step | Setting | Value |
|---|---|---|
| 1. Show | Show / Race / Year / Column height | **Elections** / **Presidential Election** / **2016** / **Votes cast** |
| 2. Area | Area / Places | **States** / **Missouri** and **Illinois** |
| 3. Style | Colours | **Blue–Red** (chosen for you), **Invert colors** off |
| | Hexagons / Light | **Size automatically** on (about 6 mi) / left as they are |
| 4. Text | Title / City labels | **Automatic** / on, **8** cities |
| 5. Export | Poster | **1:1**, **2400 px** long edge |

### Step 1: Choose what to show

<table><tr>
<td width="320"><img src="docs/img/panel-map.png" width="300" alt="The Map tab with Elections chosen, Presidential Election, 2016 and Votes cast"></td>
<td>

1. On the **Map** tab, under **Show**, click **Elections**.
2. **Race:** **Presidential Election**.
3. **Year:** **2016**. Years with partial coverage say so in the list, for example *2012 (KS, FL only)*.
4. **Column height:** **Votes cast**. Places where many people voted rise highest, so cities stand out. **Flat** lays every hexagon level.

The map switches to the **Blue–Red** palette by itself. Your own palette comes back when you leave Elections.

</td></tr></table>

> [!NOTE]
> Colour is the **margin**: the Republican share of all votes minus the Democratic share. **D+20** means the Democrat won by 20 points. States that didn't hold the chosen race (common for Senate and Governor) stay grey and read **No race**.

---

### Step 2: Choose the area

1. Under **Area**, click **States**.
2. Type `Missouri` in the search box and press **Enter**.
3. Type `Illinois` and press **Enter**. Both appear as chips; click a chip's **×** to remove it.

Or click straight on the map: a click focuses one state, and **Shift-click** adds or removes another. **Counties** works the same way, a county at a time.

Under **More options**:

- **Region preset** picks a group of states in one go. The list has a section for each Census region (Midwest, Northeast, South, West), with the region itself first and then its divisions, such as New England and the South Atlantic. The last section, **Other regions**, holds American Rockies, Appalachia, Carolinas, Four Corners, Great Lakes, Great Plains, Lower 48, Pacific Northwest and Rust Belt, in alphabetical order. Lower and Upper Appalachia come straight after Appalachia. The three Appalachia presets pick the [Appalachian Regional Commission's counties](https://www.arc.gov/map/subregions-in-appalachia/) rather than whole states. Upper is ARC's Northern and North Central subregions, and Lower is its Central, South Central and Southern subregions. A county preset shows as one chip, for example "Appalachia · 423 counties".
- **Hide areas outside the focus**: switch it off to keep neighbouring states visible as a flat, muted backdrop.

The camera flies to the new area and the hexagons rebuild. Press **Re-center** (or **F**) to frame it again; **Reset area** goes back to the whole nation.

---

### Step 3: Style it

<table><tr>
<td width="320"><img src="docs/img/panel-style.png" width="300" alt="The Style tab: palettes, hexagon size, column height, light and text settings"></td>
<td>

On the **Style** tab:

1. **Colors:** **Blue–Red** is already chosen.
   - The top two rows are **sequential** palettes (light to dark, for amounts).
   - The **Diverging** row runs between two colours through a pale middle, for measures with two sides such as election margins.
   - **Invert colors** flips any palette end to end.
   - **Custom colors** lets you pick each swatch, the paper and the text colour by hand.
2. **Hexagons:**
   - **Size:** leave **Size automatically for the area** on. It picks about 6 mi here and shows the hexagon count. Drag **Size** yourself for chunkier or finer tiles (0.5 to 80 mi).
   - **Column height** exaggerates or flattens every column (0 to 3×).
   - **More options:** the **gap** between hexagons and the **animation speed**.
3. **Light:** **Sun direction**, **Sun height** and **Shadow softness**. The defaults suit most maps; lower the sun for longer shadows.

</td></tr></table>

---

### Step 4: Title and labels

At the bottom of the **Style** tab, under **Text**:

1. **Title:** leave it empty for the automatic one (*Missouri & Illinois*), or type your own.
2. **City labels:** on. **Number of cities:** **8**. The largest places in view are labelled, each pinned to the hexagon it sits in. Where two labels would collide, the smaller town is left out.

---

### Step 5: Export the poster

<table><tr>
<td width="320"><img src="docs/img/panel-export.png" width="300" alt="The Export tab: Export posters, Export animation and Copy link"></td>
<td>

1. Open the **Export** tab and press **Export posters (PNG)…**.
2. The dialog renders the map in six shapes at once: **1:1, 3:4, 4:3, 4:5, 5:4 and 16:9**. Each is laid out for its shape, with the map centred and clear of the title, legend and notes.
3. Choose the **Long edge**: **1600**, **2400** or **3600 px**.
4. Press **Download** under **1:1**, or **Download all**.

</td></tr></table>

<img src="docs/img/export-modal.jpg" alt="The export dialog showing the same map as six posters, from square to widescreen, each with Adjust and Download buttons">

---

### Step 6 (optional): Adjust the framing

Press **Adjust** under any poster to open a live preview of that shape:

<img src="docs/img/framing-editor.jpg" alt="The Adjust 1:1 framing dialog with the Missouri and Illinois poster and Reset, Cancel and Done buttons">

| Do this | To… |
|---|---|
| **Drag** the map | rotate the view |
| **Right-drag** or **Shift-drag** | pan |
| **Scroll** | zoom in or out |
| **Drag the legend** (or a timeline's chart) | move it anywhere on the poster |
| **Reset** | go back to the automatic framing |
| **Done** / **Cancel** | keep the changes (the poster re-renders) / throw them away |

Each shape remembers its own framing until you change the area, and GIF exports in that shape use it too.

---

<a id="more"></a>

## More things to try

### Static measures

**Show → Static** maps one measure at a time:

| Measure | What a hexagon shows | Height |
|---|---|---|
| **Net Population** | people living in the hexagon | the same |
| **Population Density** | people per square mile | the same |
| **Foreign-Born Population** | share of residents born abroad | the same |
| **COVID-19 Total Deaths** / **Total Cases** | per 100,000 residents, through March 2023 | deaths or cases **per square mile**, so cities rise as peaks inside their county |
| **Elevation** | average elevation of the land in the hexagon | metres above sea level, scaled to the area in view |

Under **More options**:

- **Column height** can use a different measure from the colour, for example colour by foreign-born share and height by population density.
- **Color scale** switches between **Fit to area** (colours stretch across the places in view) and **National** (one scale for every map, so maps compare directly).

**Elevation** uses the colours of topographic maps instead of the palette: green lowlands, tan and brown uplands, grey rock, and white for the highest peaks (about 3,800 m and up). Each hexagon averages every ~30 m elevation pixel inside it; hover for metres and feet.

### Timelines and GIFs

<img src="docs/img/timeline.jpg" alt="COVID-19 new cases in June 2021 with a play bar at the bottom, a big date stamp and a dual-axis chart of cases to date and the past three weeks">

1. **Show → Over time**, then pick a **Timeline**: COVID-19 cases, new cases (weekly, smoothed over 5 weeks) or deaths, January 2020 to March 2023.
2. The **play bar** appears under the map: **▶** plays, the slider scrubs, **1×** sets the speed, **×** closes the timeline.
3. COVID timelines add a **chart** in the corner: the running total (line) and the past three weeks (shaded), with the current date marked.
4. Press **GIF…** (or **Export → Export animation (GIF)…**).
   - Choose the **Ratio**, **Long edge** (480–1080 px), **Frames** and **Speed**.
   - **Adjust framing…** opens the same editor as posters.
   - Press **Render GIF**, then **Download GIF**.

City labels stay put for the whole animation: the cities in the first frame are the ones shown throughout, and they only move up and down with their column.

### Your own data

<table><tr>
<td width="320"><img src="docs/img/panel-custom.png" width="300" alt="The My data view with a CSV loaded: Color by and Column height options"></td>
<td>

1. **Show → My data → Load a CSV…**. **Download a template CSV** first if you want a starting point.
2. Your file needs one row per point with **latitude**, **longitude** and **category 1**. **Category 2** is optional. Columns are matched automatically, and you can change them before mapping.
3. Press **Map it**.
   - A **text** category colours each hexagon by its most common value.
   - A **number** is averaged or totalled per hexagon.
   - **Column height** can be the point count, category 2 or the colour value; a text category 2 becomes a filter.

The file stays in your browser. Nothing is uploaded, and it isn't saved in share links.

</td></tr></table>

<img src="docs/img/custom-modal.png" width="640" alt="The Load custom data dialog after choosing the template CSV, with column pickers and a preview table">

### Dark mode and sharing

- The **moon / sun** button left of the menu switches the app and the poster paper between light and dark. Each palette has its own light and dark paper.
- **Export → Copy link to this view** copies a link that reopens everything you set: measure, area, palette, sizes and light.

---

<a id="gallery"></a>

## Gallery

### Before and after: one view, two measures

<p align="center"><img src="docs/img/compare/pnw-density-vs-2020.webp" width="640" alt="Pacific Northwest: a slider sweeps across the map, switching between population density (tan and teal) and the 2020 presidential vote margin (red and blue)"></p>

**Pacific Northwest** · Region preset: Pacific Northwest · dark mode · 1:1. The left side of the slider shows the **2020 presidential election** (Elections, Blue–Red, height: votes cast). The right side shows **population density** (Static, Earth). The hexes, camera and labels are the same in both, so only the measure changes: the Seattle, Portland and Eugene columns are tall in both, while the empty interior goes from brown to deep red. Full-size stills: [population density](docs/img/compare/pacific-northwest-population-density-1x1.jpg) · [2020 President](docs/img/compare/pacific-northwest-2020-president-1x1.jpg).

To make a pair like this, export one poster, change only the measure (or switch Show to Elections), and export again at the same ratio. The view stays put, so the two images line up exactly.

### Posters

| | |
|---|---|
| <img src="docs/img/gallery/missouri-illinois-2016-president-1x1.jpg" alt="Missouri and Illinois, 2016 presidential election"> | <img src="docs/img/gallery/west-virginia-ohio-population-density-1x1.jpg" alt="West Virginia and Ohio, population density, dark green"> |
| **Missouri & Illinois, 2016 President** · Elections · States: MO + IL · Blue–Red · 1:1 | **West Virginia & Ohio, population density** · Static · States: WV + OH · Forest, dark mode · 1:1 |
| <img src="docs/img/gallery/utah-2016-president-4x5.jpg" alt="Utah, 2016 presidential election"> | <img src="docs/img/gallery/arizona-population-density-4x5.jpg" alt="Arizona, population density, orange"> |
| **Utah, 2016 President** · Elections · State: UT · Blue–Red · 4:5 | **Arizona, population density** · Static · State: AZ · Ember · 4:5 |
| <img src="docs/img/gallery/illinois-population-density-3x4.jpg" alt="Illinois, population density, blue"> | <img src="docs/img/gallery/new-jersey-population-density-3x4.jpg" alt="New Jersey, population density, purple"> |
| **Illinois, population density** · Static · State: IL · Indigo · 3:4 | **New Jersey, population density** · Static · State: NJ · Plum · 3:4 |
| <img src="docs/img/gallery/illinois-2016-president-4x5.jpg" alt="Illinois, 2016 presidential election"> | <img src="docs/img/gallery/south-atlantic-home-value-3x4.jpg" alt="South Atlantic, median home value, teal on navy"> |
| **Illinois, 2016 President** · Elections · State: IL · Blue–Red · 4:5 | **South Atlantic, median home value** · Region preset: South Atlantic · Glacier, dark mode · 3:4 · *a hidden measure (see [Reference](#measures))* |

<img src="docs/img/gallery/appalachia-population-density-4x5.jpg" width="560" alt="Appalachia, population density, tan and teal on black">

**Appalachia, population density** · Static · Region preset: Appalachia (423 ARC counties) · Earth, dark mode · 4:5

<img src="docs/img/gallery/great-plains-population-density-5x4.jpg" alt="The Great Plains, population density, orange">

**The Great Plains, population density** · Static · several states, with the title typed in (now also a Region preset) · Ember · 5:4

<img src="docs/img/gallery/south-black-non-hispanic-16x9.jpg" alt="The South, Black (non-Hispanic) share of residents, teal on navy">

**The South, Black (non-Hispanic) share** · Region preset: South · Glacier, dark mode · 16:9 · *a hidden measure (see [Reference](#measures))*

---

<a id="troubleshooting"></a>

## Troubleshooting

Find your symptom below and follow the steps in order.

<a id="ts-blank"></a>

### 1. Stuck on "Loading…", or the page is empty

<img src="docs/img/ts-file.jpg" width="480" alt="The app opened as a file: stuck on Loading">

**Cause:** the page was opened as a file (the address starts with `file://` or a drive letter), so the browser blocks the data files.

1. Close the tab.
2. In a terminal in the project folder, run `python -m http.server 8000`, and **leave it running**.
3. Go to **http://localhost:8000**.

### 2. A setting from this guide is missing, or an old version keeps loading

1. Press **Ctrl + F5** (Mac: **Cmd + Shift + R**) to force a full reload.
2. Still old? Stop the server (**Ctrl + C** in its window) and start it again. `python serve.py` turns browser caching off, which avoids this.

### 3. An option is greyed out or says "(data not built)"

Some data sets are built separately and may not be in your copy: **Elevation**, **Elections** and the **historical population** timeline. Build them with the scripts in [Reference → Rebuilding the data](#rebuild), then reload.

### 4. A state is grey and says "No race"

That state didn't hold the chosen race that year (only about a third of states elect a senator each cycle), or the source has no file for it (2018: California and Kentucky). See [Reference → Elections coverage](#elections).

### 5. The map is slow, or the hexagon count is huge

1. Turn **Size automatically for the area** back on, or drag **Size** up. The hint under the slider warns above 250,000 hexagons.
2. Focus a smaller area: very fine hexagons over the whole nation are heavy.
3. Close other heavy tabs; the app uses your graphics card.

### 6. A GIF takes a long time, or the file is large

Lower **Long edge** to **480** or **720 px**, or choose fewer **Frames**. A 1080 px GIF with every frame can take a minute or two and run to tens of MB.

### 7. My CSV won't load

1. Check it has a header row and latitude and longitude in decimal degrees (for example `40.7128`, `-74.0060`).
2. Read the red message in the dialog: it names the problem, such as a missing column or how many rows were skipped.
3. Compare against **Download a template CSV**.

> [!NOTE]
> Still stuck? Press **F12 → Console**, copy any red messages, and include them, with what you clicked, when you ask for help.

---

<a id="reference"></a>

## Reference

<a id="measures"></a>

### Data sources

| Data | Source | Notes |
|---|---|---|
| Net population, population density, foreign-born share | U.S. Census Bureau, American Community Survey 2020–2024 5-year estimates | tracts nationally; block groups when states or counties are focused |
| COVID-19 totals and timelines | The New York Times COVID-19 data; Census Bureau 2020 population estimates | county level, through March 2023 |
| Elections | [Voting and Election Science Team](https://dataverse.harvard.edu/dataverse/electionscience) (VEST), Harvard Dataverse | precinct level, CC BY 4.0 |
| Elevation | USGS 3D Elevation Program (3DEP), via [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | ~25–35 m pixels (lower 48, Hawaii), ~25–48 m (Alaska) |
| Historical population (optional) | IPUMS NHGIS | decennial county populations, 1800–2020 |
| Boundaries and places | [us-atlas](https://github.com/topojson/us-atlas) (Census cartographic boundaries) | Albers USA projection |

The source of whatever is mapped is printed on the screen and on every export.

**More measures are built in but hidden.** The data files also carry median income, home value and rent, poverty, unemployment, income inequality, home ownership, education, median age, race and ethnicity, and 11 CDC PLACES chronic conditions with a Chronic Conditions Index. To offer one again, add its id to `SHOWN_METRICS` in `js/scales.js`.

<a id="elections"></a>

### Elections coverage

| Year | President | U.S. Senate | Governor | Notes |
|---|---|---|---|---|
| 2012 | ✓ | ✓ | – | Florida and Kansas only |
| 2016 | all 50 + DC | 33 states | 12 states | California's Senate race (two Democrats) left out |
| 2018 | (midterm) | 32 states | 35 states | no California or Kentucky |
| 2020 | all 50 + DC | 34 states | 11 states | |

- A race needs a Democrat and a Republican to have a margin; uncontested races are left out.
- Angus King (Maine) and Bernie Sanders (Vermont), independents who ran in place of a Democratic nominee, count on the Democratic side.
- Special elections and runoffs aren't included, nor is the U.S. House (VEST publishes House results only for single-district states).
- Not available at precinct level: before 2012, 2014, 2022 and 2024. VEST hasn't published them; the Redistricting Data Hub has 2022 and 2024 for some states (free account), and The New York Times' national 2024 file is licensed for non-commercial use only.

### Known limits

- Alaska and Hawaii are insets. Alaska is drawn at 0.35× scale, so its hexagons cover about 8× more real area than the size says.
- Puerto Rico isn't included (it's outside the Albers USA projection).
- Connecticut uses tract data even when focused: its block groups predate the 2022 switch to planning regions.
- COVID-19: New York City is reported as one unit, so every borough shows the city-wide rate.
- Medians are averaged across the census units in a hexagon, which approximates the true median.

<a id="rebuild"></a>

### Rebuilding the data

Downloads are cached in `scripts/.cache/` (git-ignored), so reruns are quick.

| Data | Command | Download |
|---|---|---|
| Census measures, places, COVID-19 | `python scripts/build_data.py` (add `--year 2025` for a newer ACS release) | about 1 GB |
| Elections | `cd scripts/elections && npm install && node build_elections.mjs` | about 2 GB |
| Elevation | `cd scripts/elevation && npm install && node build_elevation.mjs` | about 11 GB; about 1.5 hours the first time |
| Historical population | `cd scripts/nhgis && npm install`, then `NHGIS_API_KEY=your-key node build_population.mjs` (PowerShell: `$env:NHGIS_API_KEY="your-key"; node build_population.mjs`) | about 1 GB; needs a free [IPUMS NHGIS](https://uma.ipums.org/) API key |

For a quick test, the elections script takes `--years 2018 --states de,md` and the elevation script `--limit 400`.

### Deploy to GitHub Pages

The site is fully static and needs no build step.

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/`. `.nojekyll` is included so Pages serves the files untouched.

<details>
<summary><b>How it works</b> (for the curious and for developers)</summary>

#### Hexagons cut to real borders

The lattice is laid over the area. Hexagons wholly inside are drawn as one instanced prism; those crossing a border are clipped against the real boundary (Sutherland–Hodgman over a quadtree) and triangulated, so coasts and state lines stay crisp.

#### From data to hexagons

| Data | How a hexagon gets its value |
|---|---|
| Census tracts / block groups | every unit whose centre falls in the hexagon; parts they don't cover are filled by the nearest unit, weighted by its size. Density is area-weighted, population is a total, everything else is population-weighted. |
| Precincts | the same, with votes as the weight: margins are vote-weighted, votes cast are a total |
| COVID-19 | the county under the hexagon's centre; peak heights spread the county rate over the hexagon's population density |
| Elevation | the mean of pre-averaged grid cells (0.5 map units nationally, 0.1 for small hexagons), each the mean of every ~30 m land pixel inside it |
| Your CSV | points binned straight into hexagons |

#### Rendering and animation

Three.js draws beveled, clear-coated prisms with soft shadows and contact shading. Heights and colours live in two float textures (from and to); the vertex shader blends them with a delay that sweeps west to east, so any change is one smooth tween even with hundreds of thousands of hexagons. Timeline frames move in lockstep instead.

#### Posters and GIFs

Posters re-render the scene off-screen at the chosen size and draw the title, legend, notes, chart and mark on a 2D canvas laid out for each shape. GIFs render every frame the same way and encode them with one shared palette (gifenc), so colours don't flicker between frames.

#### Files

```
index.html        UI shell (Three.js, d3-geo, topojson-client and gifenc from jsDelivr)
css/style.css     Layout, panel, dialogs, light and dark themes
js/main.js        State and URL, panel, aggregation, colouring, labels, exports, elections, custom data
js/render.js      Three.js renderer: prisms, materials, shadows, camera framing, off-screen renders
js/hex.js         Hex lattice and border clipping
js/data.js        Boundaries, tracts, block groups, places, COVID-19 join
js/scales.js      Measures, palettes, colour ramps, number formats
js/timeline.js    Timelines (county series and gridded history)
js/elevation.js   Elevation grids and per-hexagon averaging
js/custom.js      CSV parsing, column guessing, point aggregation
js/labels.js      City label placement
js/export.js      Poster layout and drawing
js/chart.js       Timeline chart
scripts/          Data builders (Python for census data; Node for elections, elevation, NHGIS)
data/             Built data the app loads
docs/img/         Pictures used in this README
```

</details>

<p align="center"><sub>Made by Nomad Data</sub></p>
