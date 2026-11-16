# Vivek's Weather

A fast, good-looking weather app in plain HTML, CSS and JavaScript. No framework, no build step and no API key.

Type a city and see its weather straight away.

## Features

- **Search with suggestions** – matches appear as you type. `Paris, France` and `Paris, TX` both work, and Enter searches.
- **Use my location** – one tap for the weather where you are.
- **Immersive layout** – the screen is a window onto the weather: only the place, temperature and conditions sit on the scene, in the lower left. Everything else is one swipe away.
- **Details sheet** – tap, or swipe up on, "Forecast & details" for the hourly strip, the 7-day forecast and the detail tiles. Close it with the close button, the backdrop, Escape or by dragging it down.
- **3D weather worlds** – sunny weather is a flight through clouds and rain is a neon-lit street in the rain. Drag to look around. They use WebGL through a vendored copy of [three.js](https://threejs.org/) (MIT). Other conditions, and browsers without WebGL, use the 2D animated sky.
- **Living sky** – the background follows the conditions and the local time of the place you search: dawn, day, dusk and night, with drifting clouds, snow, fog, stars and lightning.
- **Now** – temperature, conditions, feels-like, today's high and low, and a one-line summary of what happens next.
- **Next 24 hours** – hourly icons, chance of rain and a temperature curve.
- **7-day forecast** – daily highs and lows as range bars.
- **Details** – wind with compass, humidity and dew point, UV index, sunrise and sunset, air quality, visibility and pressure.
- **°C / °F** – switches every unit on the page and is remembered.
- **Saved places** – star a city to keep it one tap away.
- **Works when the network doesn't** – the last forecast is kept and shown with a notice if the service can't be reached.
- **Accessible** – keyboard-friendly search, screen-reader labels, and animations switch off when the system asks for reduced motion.

## Run it

The app must be served over http, because ES modules (used by the 3D worlds) do not load from `file://`. Serve the folder with any static server:

```sh
python3 -m http.server 8000
```

It can be hosted as-is on GitHub Pages or any static host.

## Data

- Weather, air quality and city search: [Open-Meteo](https://open-meteo.com/) (free, no key, CC BY 4.0).
- Place name for "Use my location": [BigDataCloud](https://www.bigdatacloud.com/) reverse geocoding.

The app stores your units, saved places and the last forecast in your browser's local storage. Nothing else is stored anywhere.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page structure |
| `worlds/` | The 3D weather worlds (three.js, vendored in `vendor/`) |
| `style.css` | Layout, glass surfaces, icon animations, responsive rules |
| `index.js` | Data fetching, rendering, search, and the animated sky |
| `images/404.png` | Illustration for "place not found" |
