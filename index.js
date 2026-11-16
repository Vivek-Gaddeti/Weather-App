/* Vivek's Weather
 * Plain JavaScript, no build step. Weather data comes from Open-Meteo (no API key needed).
 */
(() => {
    'use strict';

    /* ------------------------------------------------------------------ helpers */

    const $ = (sel, root = document) => root.querySelector(sel);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const rand = (a, b) => a + Math.random() * (b - a);
    const round = n => {
        const v = Math.round(n);
        return Object.is(v, -0) ? 0 : v;
    };
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const store = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch { /* storage full or blocked: the app still works without it */ }
        },
    };

    const KEYS = { units: 'vw:units', last: 'vw:last', saved: 'vw:saved', cache: 'vw:cache' };
    const REFRESH_MS = 10 * 60 * 1000;
    const CACHE_MS = 6 * 60 * 60 * 1000;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    /* Open-Meteo returns local wall-clock times with no offset ("2026-11-16T14:00").
       We parse them as if they were UTC and always format in UTC, which keeps every
       time on screen in the place's own time zone. */
    const T = s => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}:00Z`);
    const formatters = new Map();
    const fmt = (ms, opts) => {
        const key = JSON.stringify(opts);
        if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts }));
        return formatters.get(key).format(ms);
    };
    const fmtTime = ms => fmt(ms, { hour: 'numeric', minute: '2-digit' });
    const fmtHour = ms => fmt(ms, { hour: 'numeric' });
    const fmtSpan = ms => {
        const mins = Math.max(0, Math.round(ms / 60000));
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    };

    /* ------------------------------------------------------------------ state */

    const state = {
        units: store.get(KEYS.units, 'c') === 'f' ? 'f' : 'c',
        saved: store.get(KEYS.saved, []),
        place: null,
        data: null, // { placeId, fc, aq, at }
        shownTemp: null,
        heroIcon: '',
    };

    const U = {
        temp: c => round(state.units === 'f' ? c * 9 / 5 + 32 : c),
        tempDelta: c => round(state.units === 'f' ? c * 9 / 5 : c),
        speed: kmh => round(state.units === 'f' ? kmh * 0.621371 : kmh),
        speedUnit: () => (state.units === 'f' ? 'mph' : 'km/h'),
        dist: m => {
            const v = state.units === 'f' ? m / 1609.344 : m / 1000;
            return v >= 10 ? round(v) : Math.round(v * 10) / 10;
        },
        distUnit: () => (state.units === 'f' ? 'mi' : 'km'),
        pressure: hpa => (state.units === 'f' ? (hpa * 0.02953).toFixed(2) : round(hpa)),
        pressureUnit: () => (state.units === 'f' ? 'inHg' : 'hPa'),
    };

    /* ------------------------------------------------------------------ weather codes */

    // WMO weather interpretation codes, as used by Open-Meteo.
    function describe(code, isDay) {
        const d = isDay ? 'day' : 'night';
        const make = (label, kind, icon, level = 0.5) => ({ label, kind, icon, level });
        switch (code) {
            case 0: return make(isDay ? 'Sunny' : 'Clear', 'clear', `clear-${d}`);
            case 1: return make(isDay ? 'Mostly sunny' : 'Mostly clear', 'partly', `partly-${d}`);
            case 2: return make('Partly cloudy', 'partly', `partly-${d}`);
            case 3: return make('Overcast', 'cloudy', 'cloudy');
            case 45: return make('Fog', 'fog', 'fog');
            case 48: return make('Freezing fog', 'fog', 'fog');
            case 51: return make('Light drizzle', 'drizzle', 'drizzle', 0.2);
            case 53: return make('Drizzle', 'drizzle', 'drizzle', 0.3);
            case 55: return make('Heavy drizzle', 'drizzle', 'drizzle', 0.4);
            case 56:
            case 57: return make('Freezing drizzle', 'sleet', 'sleet', 0.3);
            case 61: return make('Light rain', 'rain', 'rain', 0.4);
            case 63: return make('Rain', 'rain', 'rain', 0.65);
            case 65: return make('Heavy rain', 'rain', 'rain-heavy', 1);
            case 66:
            case 67: return make('Freezing rain', 'sleet', 'sleet', 0.6);
            case 71: return make('Light snow', 'snow', 'snow', 0.35);
            case 73: return make('Snow', 'snow', 'snow', 0.65);
            case 75: return make('Heavy snow', 'snow', 'snow', 1);
            case 77: return make('Snow grains', 'snow', 'snow', 0.3);
            case 80: return make('Light showers', 'rain', 'rain', 0.4);
            case 81: return make('Showers', 'rain', 'rain', 0.7);
            case 82: return make('Heavy showers', 'rain', 'rain-heavy', 1);
            case 85: return make('Snow showers', 'snow', 'snow', 0.5);
            case 86: return make('Heavy snow showers', 'snow', 'snow', 1);
            case 95: return make('Thunderstorm', 'storm', 'storm', 0.9);
            case 96:
            case 99: return make('Thunderstorm with hail', 'storm', 'storm', 1);
            default: return make('Cloudy', 'cloudy', 'cloudy');
        }
    }

    const isSnowy = code => (code >= 71 && code <= 77) || code === 85 || code === 86;
    const isWet = code => (code >= 51 && code <= 67) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86) || code >= 95;
    const wetWord = code => (code >= 95 ? 'Storms' : isSnowy(code) ? 'Snow' : 'Rain');

    /* ------------------------------------------------------------------ icons */

    const CLOUD = 'M46.5 44H19a11 11 0 0 1-1.6-21.9 15 15 0 0 1 28.6 3.1A9.5 9.5 0 0 1 46.5 44z';
    const MOON = 'M36.5 16.5a16 16 0 1 0 11 27.5 17 17 0 0 1-11-27.5z';

    const part = {
        sun(cx, cy, r) {
            let rays = '';
            for (let k = 0; k < 8; k++) {
                const a = k * Math.PI / 4;
                const c = Math.cos(a);
                const s = Math.sin(a);
                rays += `M${(cx + c * (r + 4.5)).toFixed(1)} ${(cy + s * (r + 4.5)).toFixed(1)}L${(cx + c * (r + 9)).toFixed(1)} ${(cy + s * (r + 9)).toFixed(1)}`;
            }
            return `<path class="rays" d="${rays}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g-sun)"/>`;
        },
        moon: (tx, ty, s) => `<g transform="translate(${tx} ${ty}) scale(${s})"><path d="${MOON}" fill="url(#g-moon)"/></g>`,
        cloud: (tx, ty, s, dark = false, cls = 'float') =>
            `<g transform="translate(${tx} ${ty}) scale(${s})"><path class="${cls}" d="${CLOUD}" fill="url(#${dark ? 'g-cloud-dark' : 'g-cloud'})"/></g>`,
        drops: (xs, y, len) => xs.map((x, i) => `<path class="drop" style="--d:${(i * 0.27).toFixed(2)}s" d="M${x} ${y}l${-len * 0.3} ${len}"/>`).join(''),
        flakes: (pts) => pts.map(([x, y], i) => `<circle class="flake" style="--d:${(i * 0.6).toFixed(2)}s" cx="${x}" cy="${y}" r="2.3"/>`).join(''),
        // four-point sparkles
        stars: pts => pts.map(([x, y, r], i) =>
            `<path class="tw" style="--d:${(i * 0.9).toFixed(1)}s" d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z"/>`).join(''),
    };

    const ICONS = {
        'clear-day': () => part.sun(32, 32, 12.5),
        'clear-night': () => part.moon(-2, 0, 1) + part.stars([[50, 15, 4.6], [57, 29, 3.2], [43, 6, 2.6]]),
        'partly-day': () => part.sun(23, 22, 9) + part.cloud(6, 13, 0.9),
        'partly-night': () => part.moon(-2, -5, 0.7) + part.stars([[41, 9, 3.6], [51, 18, 2.6]]) + part.cloud(6, 13, 0.9),
        cloudy: () => part.cloud(15, 2, 0.72, true, 'float float--b') + part.cloud(2, 13, 0.92),
        fog: () => part.cloud(0, -5, 1) + '<path class="fogline" d="M13 47h38"/><path class="fogline" style="--d:1.2s" d="M20 55h24"/>',
        drizzle: () => part.cloud(0, -6, 1) + part.drops([23, 33, 43], 44, 5),
        rain: () => part.cloud(0, -6, 1, true) + part.drops([23, 33, 43], 43, 9),
        'rain-heavy': () => part.cloud(0, -6, 1, true) + part.drops([19, 27, 35, 43, 51], 43, 10),
        snow: () => part.cloud(0, -6, 1) + part.flakes([[22, 47], [32, 52], [42, 47]]),
        sleet: () => part.cloud(0, -6, 1, true) + part.drops([23], 43, 8) + part.flakes([[33, 50]]) + part.drops([44], 43, 8),
        storm: () => part.cloud(0, -6, 1, true) + part.drops([20, 47], 43, 8)
            + '<path class="bolt" d="M35 33l-8.5 12.5h6L29.5 57 41 41.5h-6L39 33z" fill="url(#g-bolt)"/>',
    };

    const icon = (name, animated = false) =>
        `<svg class="wi${animated ? ' wi--anim' : ''}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${(ICONS[name] || ICONS.cloudy)()}</svg>`;

    const LINE = {
        feels: '<path d="M10 13.6V5a2 2 0 0 1 4 0v8.6a4 4 0 1 1-4 0z"/>',
        wind: '<path d="M3 9h10.5A2.5 2.5 0 1 0 11 6.5M3 14h14.5a2.5 2.5 0 1 1-2.5 2.5M3 18.5h6"/>',
        drop: '<path d="M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5z"/>',
        uv: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
        sun: '<path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 4.5V9M9.5 7L12 4.5 14.5 7"/>',
        air: '<path d="M4 8c2.5-2 5.5-2 8 0s5.5 2 8 0M4 13c2.5-2 5.5-2 8 0s5.5 2 8 0M4 18c2.5-2 5.5-2 8 0s5.5 2 8 0"/>',
        eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
        gauge: '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l3.8-3.8M12 5.5V7"/>',
        spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9zM18.5 16v4M16.5 18h4"/>',
    };
    const line = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${LINE[name]}</svg>`;

    /* ------------------------------------------------------------------ sky */

    const SKIES = {
        'clear-day': { g: ['#1857bd', '#3b8ae0', '#84bff1'], glass: 'rgba(10, 34, 86, 0.36)' },
        'clear-dawn': { g: ['#2b3d7a', '#b0628f', '#f0a36f'], glass: 'rgba(40, 22, 66, 0.3)' },
        'clear-dusk': { g: ['#222859', '#80417a', '#e98259'], glass: 'rgba(34, 16, 56, 0.3)' },
        'clear-night': { g: ['#040918', '#0c1839', '#243366'], glass: 'rgba(255, 255, 255, 0.07)' },
        'cloudy-day': { g: ['#4a5f7b', '#6f859f', '#9aacbf'], glass: 'rgba(18, 32, 54, 0.34)' },
        'cloudy-dusk': { g: ['#383e61', '#75607c', '#b08a84'], glass: 'rgba(30, 22, 48, 0.28)' },
        'cloudy-night': { g: ['#0d131f', '#1d2736', '#333d50'], glass: 'rgba(255, 255, 255, 0.07)' },
        'rain-day': { g: ['#304258', '#4b5f75', '#6c7f96'], glass: 'rgba(10, 20, 38, 0.32)' },
        'rain-night': { g: ['#080d16', '#151f2d', '#263243'], glass: 'rgba(255, 255, 255, 0.07)' },
        'snow-day': { g: ['#516782', '#7b92ad', '#acbdd1'], glass: 'rgba(20, 36, 62, 0.36)' },
        'snow-night': { g: ['#111929', '#253248', '#43536d'], glass: 'rgba(255, 255, 255, 0.08)' },
        'fog-day': { g: ['#55626d', '#808c97', '#a2acb5'], glass: 'rgba(18, 28, 42, 0.36)' },
        'fog-night': { g: ['#10151d', '#242b36', '#39414d'], glass: 'rgba(255, 255, 255, 0.07)' },
        storm: { g: ['#121527', '#282d44', '#444963'], glass: 'rgba(255, 255, 255, 0.07)' },
    };

    const Sky = (() => {
        const layers = [$('#skyA'), $('#skyB')];
        const orb = $('#orb');
        const themeMeta = $('meta[name="theme-color"]');
        let top = 0;
        let current = '';

        function set(key) {
            if (key === current || !SKIES[key]) return;
            current = key;
            const sky = SKIES[key];
            const next = layers[1 - top];
            const prev = layers[top];
            // Fade the new sky in over the old one, which stays fully opaque underneath.
            next.style.transition = 'none';
            next.classList.remove('is-on');
            next.style.background = `linear-gradient(180deg, ${sky.g[0]} 0%, ${sky.g[1]} 52%, ${sky.g[2]} 100%)`;
            prev.style.zIndex = 0;
            next.style.zIndex = 1;
            void next.offsetWidth;
            next.style.transition = '';
            next.classList.add('is-on');
            top = 1 - top;
            document.documentElement.style.setProperty('--glass', sky.glass);
            themeMeta.setAttribute('content', sky.g[0]);
        }

        function setOrb(kind, x, y, opacity) {
            orb.classList.toggle('is-sun', kind === 'sun');
            orb.classList.toggle('is-moon', kind === 'moon');
            if (!kind) return;
            orb.style.setProperty('--x', `${x.toFixed(1)}%`);
            orb.style.setProperty('--y', `${y.toFixed(1)}%`);
            orb.style.setProperty('--o', opacity);
        }

        return { set, setOrb };
    })();

    /* Canvas effects: stars, drifting clouds, rain, snow, fog and lightning. */
    const FX = (() => {
        const canvas = $('#fx');
        const ctx = canvas.getContext('2d');
        const flash = $('#flash');
        const LAYERS = ['stars', 'clouds', 'rain', 'snow', 'fog'];
        const cur = { stars: 0, clouds: 0, rain: 0, snow: 0, fog: 0 };
        const tgt = { stars: 0, clouds: 0, rain: 0, snow: 0, fog: 0 };
        let W = 0, H = 0, raf = 0, last = 0;
        let wind = 0, tone = '', storm = false;
        let stars = [], clouds = [], drops = [], flakes = [], sprites = [], fogSprite = null;
        let bolt = null, nextBolt = 0, shoot = null, nextShoot = 0;

        function makeSprite(rgb, strength) {
            const s = document.createElement('canvas');
            s.width = 420;
            s.height = 220;
            const c = s.getContext('2d');
            const n = 7 + Math.floor(Math.random() * 4);
            for (let i = 0; i < n; i++) {
                const x = rand(90, 330), y = rand(95, 125), r = rand(45, 85);
                const g = c.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, `rgba(${rgb},${strength})`);
                g.addColorStop(0.55, `rgba(${rgb},${strength * 0.4})`);
                g.addColorStop(1, `rgba(${rgb},0)`);
                c.fillStyle = g;
                c.beginPath();
                c.arc(x, y, r, 0, Math.PI * 2);
                c.fill();
            }
            return s;
        }

        function setTone(next) {
            if (next === tone) return;
            tone = next;
            const rgb = { light: '255,255,255', gray: '206,216,230', night: '112,128,168', dusk: '255,214,208' }[tone];
            const strength = { light: 0.52, gray: 0.5, night: 0.42, dusk: 0.5 }[tone];
            sprites = [0, 1, 2, 3].map(() => makeSprite(rgb, strength));
            fogSprite = makeSprite(tone === 'night' ? '150,162,184' : '236,240,245', 0.5);
        }

        function newDrop() {
            const depth = Math.random();
            return { x: rand(-0.2, 1.2), y: Math.random(), len: 10 + depth * 16, v: 620 + depth * 520, a: 0.18 + depth * 0.32 };
        }

        function newFlake() {
            const depth = Math.random();
            return { x: Math.random(), y: Math.random(), r: 1 + depth * 2.4, v: 28 + depth * 60, a: 0.45 + depth * 0.5, p: rand(0, 6.28), s: rand(0.6, 1.6) };
        }

        function seed() {
            const scale = clamp(W / 900, 0.72, 1.5);
            stars = Array.from({ length: Math.round(clamp(W * H / 6500, 70, 280)) }, () => ({
                x: Math.random(), y: Math.pow(Math.random(), 1.4) * 0.9, r: rand(0.5, 1.5), p: rand(0, 6.28), s: rand(0.4, 1.7),
            }));
            clouds = Array.from({ length: 12 }, (_, i) => {
                const w = rand(300, 580) * scale;
                return { x: rand(-0.3, 1) * W, y: rand(-0.06, 0.5) * H - (i % 3) * 10, w, h: w * 220 / 420, v: rand(4, 13), a: 0, sp: i % 4 };
            });
            drops = Array.from({ length: Math.round(clamp(W * H / 2600, 160, 520)) }, newDrop);
            flakes = Array.from({ length: Math.round(clamp(W * H / 4200, 110, 320)) }, newFlake);
        }

        function resize() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            W = window.innerWidth;
            H = window.innerHeight;
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            seed();
            if (reducedMotion.matches) drawStill();
        }

        function drawStars(t) {
            if (cur.stars < 0.01) return;
            ctx.fillStyle = '#fff';
            for (const s of stars) {
                ctx.globalAlpha = cur.stars * (0.5 + 0.5 * Math.sin(t / 1000 * s.s + s.p)) * 0.95;
                ctx.beginPath();
                ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
                ctx.fill();
            }
            if (shoot) {
                const k = (t - shoot.t0) / shoot.dur;
                if (k >= 1) shoot = null;
                else {
                    const x = shoot.x + shoot.dx * k, y = shoot.y + shoot.dy * k;
                    const g = ctx.createLinearGradient(x, y, x - shoot.dx * 0.22, y - shoot.dy * 0.22);
                    g.addColorStop(0, 'rgba(255,255,255,0.9)');
                    g.addColorStop(1, 'rgba(255,255,255,0)');
                    ctx.globalAlpha = cur.stars * Math.sin(Math.PI * k);
                    ctx.strokeStyle = g;
                    ctx.lineWidth = 1.6;
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(x - shoot.dx * 0.22, y - shoot.dy * 0.22);
                    ctx.stroke();
                }
            } else if (cur.stars > 0.85 && t > nextShoot && !reducedMotion.matches) {
                if (nextShoot) shoot = { t0: t, dur: 900, x: rand(0.1, 0.7) * W, y: rand(0.04, 0.3) * H, dx: rand(220, 380), dy: rand(70, 150) };
                nextShoot = t + rand(9000, 22000);
            }
            ctx.globalAlpha = 1;
        }

        function drawClouds(dt) {
            const visible = tgt.clouds * clouds.length;
            const base = tone === 'night' ? 0.8 : 0.95;
            for (let i = 0; i < clouds.length; i++) {
                const c = clouds[i];
                const want = i < visible ? Math.min(1, visible - i) : 0;
                c.a += (want - c.a) * Math.min(1, dt * 1.4);
                c.x += (c.v + wind * 36) * dt;
                if (c.x > W + 40) c.x = -c.w;
                else if (c.x + c.w < -40) c.x = W;
                if (c.a < 0.01) continue;
                ctx.globalAlpha = c.a * base;
                ctx.drawImage(sprites[c.sp], c.x, c.y, c.w, c.h);
            }
            ctx.globalAlpha = 1;
        }

        function drawFog(t) {
            if (cur.fog < 0.01) return;
            const w = W * 1.5 + 300;
            for (let i = 0; i < 5; i++) {
                const speed = 9 + i * 4;
                const x = ((t / 1000 * speed + i * w * 0.37) % (W + w)) - w;
                ctx.globalAlpha = cur.fog * 0.6;
                ctx.drawImage(fogSprite, x, H * (0.12 + i * 0.17), w, H * 0.5);
            }
            ctx.globalAlpha = 1;
        }

        function drawRain(dt) {
            if (cur.rain < 0.01) return;
            const n = Math.round(cur.rain * drops.length);
            const slant = wind * 0.42;
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#d6e7ff';
            for (let i = 0; i < n; i++) {
                const d = drops[i];
                d.y += d.v * dt / H;
                d.x += slant * d.v * dt / W;
                if (d.y > 1.05) { d.y = -0.05; d.x = rand(-0.2, 1.2); }
                const x = d.x * W, y = d.y * H;
                ctx.globalAlpha = d.a;
                ctx.lineWidth = d.len > 18 ? 1.4 : 1;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x - slant * d.len, y - d.len);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        function drawSnow(dt, t) {
            if (cur.snow < 0.01) return;
            const n = Math.round(cur.snow * flakes.length);
            ctx.fillStyle = '#fff';
            for (let i = 0; i < n; i++) {
                const f = flakes[i];
                f.y += f.v * dt / H;
                f.x += (Math.sin(t / 1000 * f.s + f.p) * 16 + wind * 70) * dt / W;
                if (f.y > 1.03) { f.y = -0.03; f.x = Math.random(); }
                if (f.x > 1.05) f.x = -0.05;
                else if (f.x < -0.05) f.x = 1.05;
                ctx.globalAlpha = f.a;
                ctx.beginPath();
                ctx.arc(f.x * W, f.y * H, f.r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }

        function drawBolt(t) {
            if (storm && !reducedMotion.matches && t > nextBolt) {
                if (nextBolt) {
                    const pts = [];
                    let x = rand(0.15, 0.85) * W, y = -10;
                    const end = rand(0.3, 0.55) * H;
                    while (y < end) {
                        pts.push([x, y]);
                        x += rand(-26, 26);
                        y += rand(18, 44);
                    }
                    bolt = { pts, t0: t };
                    flash.classList.remove('is-on');
                    void flash.offsetWidth;
                    flash.classList.add('is-on');
                }
                nextBolt = t + rand(5500, 14000);
            }
            if (!bolt) return;
            const k = (t - bolt.t0) / 260;
            if (k >= 1) { bolt = null; return; }
            ctx.save();
            ctx.globalAlpha = 1 - k;
            ctx.strokeStyle = '#f3f6ff';
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.shadowColor = '#c9d6ff';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            bolt.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.stroke();
            ctx.restore();
        }

        function paint(t, dt) {
            ctx.clearRect(0, 0, W, H);
            drawStars(t);
            drawClouds(dt);
            drawFog(t);
            drawRain(dt);
            drawSnow(dt, t);
            drawBolt(t);
        }

        function frame(t) {
            const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
            last = t;
            for (const k of LAYERS) cur[k] += (tgt[k] - cur[k]) * Math.min(1, dt * 1.5);
            paint(t, dt);
            raf = requestAnimationFrame(frame);
        }

        // With reduced motion we paint one still frame instead of animating.
        function drawStill() {
            for (const k of LAYERS) cur[k] = tgt[k];
            const visible = tgt.clouds * clouds.length;
            clouds.forEach((c, i) => { c.a = i < visible ? Math.min(1, visible - i) : 0; });
            paint(0, 0);
        }

        function start() {
            cancelAnimationFrame(raf);
            if (reducedMotion.matches) { drawStill(); return; }
            if (document.hidden) return;
            last = performance.now();
            raf = requestAnimationFrame(frame);
        }

        function set(cfg) {
            tgt.stars = cfg.stars || 0;
            tgt.clouds = cfg.clouds || 0;
            tgt.rain = cfg.rain || 0;
            tgt.snow = cfg.snow || 0;
            tgt.fog = cfg.fog || 0;
            wind = cfg.wind || 0;
            storm = !!cfg.storm;
            if (!storm) nextBolt = 0;
            setTone(cfg.tone || 'light');
            if (reducedMotion.matches) drawStill();
        }

        let resizeTimer = 0;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(resize, 150);
        });
        document.addEventListener('visibilitychange', () => (document.hidden ? cancelAnimationFrame(raf) : start()));
        reducedMotion.addEventListener?.('change', start);

        setTone('light');
        resize();
        start();
        return { set };
    })();

    /* Pick the sky, sun or moon, and effects for the current conditions. */
    function applySky() {
        if (!state.data) return;
        const { fc } = state.data;
        const cur = fc.current;
        const now = Date.now() + fc.utc_offset_seconds * 1000;
        const di = dayIndex(fc, now);
        const sr = T(fc.daily.sunrise[di] || '');
        const ss = T(fc.daily.sunset[di] || '');
        const sunValid = ss > sr;
        const dayNow = sunValid ? now >= sr && now < ss : cur.is_day === 1;
        const edge = 45 * 60 * 1000;
        const phase = sunValid && Math.abs(now - sr) < edge ? 'dawn' : sunValid && Math.abs(now - ss) < edge ? 'dusk' : dayNow ? 'day' : 'night';
        const w = describe(cur.weather_code, dayNow);
        const dn = dayNow ? 'day' : 'night';

        let key;
        if (w.kind === 'clear' || w.kind === 'partly') key = `clear-${phase}`;
        else if (w.kind === 'cloudy') key = phase === 'dawn' || phase === 'dusk' ? 'cloudy-dusk' : `cloudy-${dn}`;
        else if (w.kind === 'storm') key = 'storm';
        else if (w.kind === 'snow') key = `snow-${dn}`;
        else if (w.kind === 'fog') key = `fog-${dn}`;
        else key = `rain-${dn}`;
        Sky.set(key);

        const open = w.kind === 'clear' || w.kind === 'partly';
        if (open && dayNow && sunValid) {
            const p = clamp((now - sr) / (ss - sr), 0, 1);
            Sky.setOrb('sun', 66 + 24 * p, 22 - Math.sin(Math.PI * p) * 15, w.kind === 'clear' ? 1 : 0.85);
        } else if (open && !dayNow) {
            Sky.setOrb('moon', 80, 6.5, w.kind === 'clear' ? 1 : 0.8);
        } else {
            Sky.setOrb(null);
        }

        const cover = (cur.cloud_cover ?? 0) / 100;
        const clouds = {
            clear: cover * 0.45, partly: Math.max(0.3, cover * 0.7), cloudy: 0.95, fog: 0.5,
            drizzle: 0.8, rain: 0.92, sleet: 0.9, snow: 0.85, storm: 1,
        }[w.kind];
        const toward = ((cur.wind_direction_10m ?? 270) + 180) * Math.PI / 180;
        FX.set({
            stars: !dayNow && open ? (w.kind === 'clear' ? 1 : 0.7) : 0,
            clouds,
            rain: { drizzle: w.level * 0.8, rain: w.level, sleet: w.level * 0.7, storm: 0.95 }[w.kind] || 0,
            snow: w.kind === 'snow' ? w.level : w.kind === 'sleet' ? 0.3 : 0,
            fog: w.kind === 'fog' ? 1 : 0,
            storm: w.kind === 'storm',
            wind: Math.sin(toward) * clamp((cur.wind_speed_10m ?? 0) / 40, 0, 1),
            tone: !dayNow ? 'night' : phase === 'dawn' || phase === 'dusk' ? 'dusk' : open ? 'light' : 'gray',
        });
    }

    // Before any weather is loaded, match the sky to the visitor's own time of day.
    function ambientSky() {
        const h = new Date().getHours();
        const phase = h >= 6 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 19 ? 'dusk' : 'night';
        Sky.set(`clear-${phase}`);
        if (phase === 'night') Sky.setOrb('moon', 80, 6.5, 1);
        else Sky.setOrb('sun', 78, phase === 'day' ? 10 : 24, 1);
        FX.set({ stars: phase === 'night' ? 1 : 0, clouds: phase === 'night' ? 0.15 : 0.3, wind: 0.2, tone: phase === 'night' ? 'night' : phase === 'day' ? 'light' : 'dusk' });
    }

    /* ------------------------------------------------------------------ API */

    const API = {
        async json(url, signal) {
            const res = await fetch(url, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },

        async geocode(name, signal, count = 6) {
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=en&format=json`;
            const json = await this.json(url, signal);
            return (json.results || []).map(r => ({
                id: `om:${r.id}`,
                name: r.name,
                admin: r.admin1 || '',
                country: r.country || '',
                code: r.country_code || '',
                lat: r.latitude,
                lon: r.longitude,
            }));
        },

        forecast(place, signal) {
            const q = new URLSearchParams({
                latitude: place.lat,
                longitude: place.lon,
                current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index,dew_point_2m',
                hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
                daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max',
                timezone: 'auto',
                forecast_days: 8,
            });
            return this.json(`https://api.open-meteo.com/v1/forecast?${q}`, signal);
        },

        // Air quality is a bonus: if it fails, the rest of the app carries on.
        air(place, signal) {
            const q = new URLSearchParams({ latitude: place.lat, longitude: place.lon, current: 'us_aqi,pm2_5', timezone: 'auto' });
            return this.json(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`, signal).catch(err => {
                if (err.name === 'AbortError') throw err;
                return null;
            });
        },

        // Turn coordinates into a place name for "Use my location".
        async reverse(lat, lon) {
            const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
            const j = await this.json(url);
            const name = j.city || j.locality;
            return name ? { name, admin: j.principalSubdivision || '', country: j.countryName || '' } : null;
        },
    };

    // Accepts "Paris" as well as "Paris, France" or "Paris, TX".
    async function findPlaces(query, signal) {
        const [name, ...rest] = query.split(',');
        const hint = rest.join(' ').trim().toLowerCase();
        const results = await API.geocode(name.trim(), signal, hint ? 20 : 6);
        if (!hint) return results;
        const match = results.filter(p =>
            p.code.toLowerCase() === hint || p.country.toLowerCase().includes(hint) || p.admin.toLowerCase().includes(hint));
        return (match.length ? match : results).slice(0, 6);
    }

    /* ------------------------------------------------------------------ views */

    const views = {
        welcome: $('#view-welcome'),
        loading: $('#view-loading'),
        notfound: $('#view-notfound'),
        error: $('#view-error'),
        dash: $('#view-dash'),
    };
    const dash = views.dash;

    function setView(name) {
        for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    }

    const banner = $('#banner');
    const bannerAction = $('#banner-action');
    let bannerFn = null;

    function showBanner(text, actionLabel, fn) {
        $('#banner-text').textContent = text;
        bannerAction.hidden = !actionLabel;
        bannerAction.textContent = actionLabel || '';
        bannerFn = fn || null;
        banner.hidden = false;
    }

    const hideBanner = () => { banner.hidden = true; };
    bannerAction.addEventListener('click', () => bannerFn?.());

    const setBusy = on => document.body.classList.toggle('is-busy', on);

    /* ------------------------------------------------------------------ loading */

    let loadCtl = null;

    async function load(place, animate = true) {
        loadCtl?.abort();
        const ctl = loadCtl = new AbortController();
        const changed = !state.place || state.place.id !== place.id;
        state.place = place;
        store.set(KEYS.last, place);
        renderSaved();
        hideBanner();

        const have = state.data && state.data.placeId === place.id;
        if (have) {
            if (changed || views.dash.hidden) render(animate);
        } else if (state.data && !views.dash.hidden) {
            dash.classList.add('is-stale');
        } else {
            setView('loading');
        }

        setBusy(true);
        try {
            const [fc, aq] = await Promise.all([API.forecast(place, ctl.signal), API.air(place, ctl.signal)]);
            if (!fc || !fc.current || !fc.daily || !fc.hourly) throw new Error('Unexpected response');
            state.data = { placeId: place.id, fc, aq, at: Date.now() };
            store.set(KEYS.cache, state.data);
            render(animate && !have);
        } catch (err) {
            if (err.name === 'AbortError') return;
            dash.classList.remove('is-stale');
            if (state.data && state.data.placeId === place.id) {
                const at = new Date(state.data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                showBanner(`Can't reach the weather service. Showing weather from ${at}.`, 'Retry', () => load(place, false));
            } else {
                state.data = null;
                setView('error');
            }
        } finally {
            if (loadCtl === ctl) setBusy(false);
        }
    }

    /* ------------------------------------------------------------------ render */

    function dayIndex(fc, now) {
        const today = new Date(now).toISOString().slice(0, 10);
        const i = fc.daily.time.indexOf(today);
        return i < 0 ? 0 : i;
    }

    function render(animate) {
        const { fc, aq } = state.data;
        const now = Date.now() + fc.utc_offset_seconds * 1000;
        const di = dayIndex(fc, now);

        renderHero(fc, now, di);
        renderHourly(fc, now);
        renderDaily(fc, di);
        renderTiles(fc, aq, now, di);
        applySky();

        $('#updated').textContent = `Updated ${new Date(state.data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        dash.classList.remove('is-stale');
        const wasHidden = dash.hidden;
        setView('dash');
        tickClock();

        // Entrance animations run for a new place, not for refreshes or unit changes.
        dash.classList.remove('enter');
        if (animate || wasHidden) {
            void dash.offsetWidth;
            dash.classList.add('enter');
        }
        updateHourlyNav();
    }

    function renderHero(fc, now, di) {
        const p = state.place;
        const cur = fc.current;
        const w = describe(cur.weather_code, cur.is_day === 1);

        $('#place').textContent = p.name;
        $('#region').textContent = [p.admin, p.country].filter(v => v && v !== p.name).join(', ');
        $('#cond').textContent = w.label;
        $('#meta').innerHTML =
            `Feels like <b>${U.temp(cur.apparent_temperature)}°</b> · High <b>${U.temp(fc.daily.temperature_2m_max[di])}°</b> · Low <b>${U.temp(fc.daily.temperature_2m_min[di])}°</b>`;

        if (state.heroIcon !== w.icon) {
            state.heroIcon = w.icon;
            $('#hero-icon').innerHTML = icon(w.icon, true);
        }

        countTo(U.temp(cur.temperature_2m));
        document.title = `${U.temp(cur.temperature_2m)}° ${p.name} · Vivek's Weather`;

        const tip = insight(fc, now, di);
        $('#insight').innerHTML = tip ? `${line(tip.icon)}<span>${esc(tip.text)}</span>` : '';

        const star = $('#star');
        const saved = state.saved.some(s => s.id === p.id);
        star.setAttribute('aria-pressed', saved);
        star.setAttribute('aria-label', saved ? 'Remove from saved places' : 'Save this place');
    }

    let countRaf = 0;
    function countTo(target) {
        const el = $('#temp');
        cancelAnimationFrame(countRaf);
        const from = state.shownTemp;
        state.shownTemp = target;
        if (from == null || from === target || reducedMotion.matches) {
            el.textContent = target;
            return;
        }
        const t0 = performance.now();
        const step = t => {
            const k = clamp((t - t0) / 700, 0, 1);
            const eased = 1 - Math.pow(1 - k, 3);
            el.textContent = round(from + (target - from) * eased);
            if (k < 1) countRaf = requestAnimationFrame(step);
        };
        countRaf = requestAnimationFrame(step);
    }

    function hourStart(fc, now) {
        const i = fc.hourly.time.findIndex(t => T(t) + 3600000 > now);
        return i < 0 ? 0 : i;
    }

    // One plain-language line about what happens next.
    function insight(fc, now, di) {
        const H = fc.hourly;
        const start = hourStart(fc, now);
        const code = fc.current.weather_code;
        const end = Math.min(start + 12, H.time.length - 1);

        if (isWet(code)) {
            for (let i = start + 1; i <= end; i++) {
                if (!isWet(H.weather_code[i]) && (H.precipitation_probability[i] ?? 0) < 40) {
                    return { icon: 'drop', text: `${wetWord(code)} easing around ${fmtHour(T(H.time[i]))}` };
                }
            }
            return { icon: 'drop', text: `${wetWord(code)} continuing for the next 12 hours` };
        }
        for (let i = start + 1; i <= end; i++) {
            if (isWet(H.weather_code[i]) && (H.precipitation_probability[i] ?? 100) >= 40) {
                return { icon: 'drop', text: `${wetWord(H.weather_code[i])} expected around ${fmtHour(T(H.time[i]))}` };
            }
        }
        const max = fc.daily.temperature_2m_max;
        if (max[di + 1] != null) {
            const diff = U.tempDelta(max[di + 1] - max[di]);
            if (Math.abs(diff) >= 3) return { icon: 'spark', text: `Tomorrow will be ${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'cooler'} than today` };
        }
        return { icon: 'spark', text: 'Dry for the next 12 hours' };
    }

    /* Hourly strip with a temperature curve */
    const CURVE_H = 78;

    function smoothPath(pts) {
        let d = `M${pts[0][0]} ${pts[0][1].toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
            d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} `
                + `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0]} ${p2[1].toFixed(1)}`;
        }
        return d;
    }

    function renderHourly(fc, now) {
        const H = fc.hourly;
        const start = hourStart(fc, now);
        const n = Math.min(24, H.time.length - start);
        if (n < 2) { $('#hourly').innerHTML = ''; return; }
        const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--col')) || 64;
        const temps = Array.from({ length: n }, (_, i) => H.temperature_2m[start + i]);
        temps[0] = fc.current.temperature_2m;
        const lo = Math.min(...temps), hi = Math.max(...temps);
        const pts = temps.map((t, i) => [i * col + col / 2, 34 + (1 - (t - lo) / (hi - lo || 1)) * 30]);

        let items = '';
        for (let i = 0; i < n; i++) {
            const k = start + i;
            const isDay = i === 0 ? fc.current.is_day === 1 : H.is_day[k] === 1;
            const w = describe(i === 0 ? fc.current.weather_code : H.weather_code[k], isDay);
            const pop = H.precipitation_probability[k] ?? 0;
            const time = i === 0 ? 'Now' : fmtHour(T(H.time[k]));
            const temp = U.temp(temps[i]);
            items += `<li class="hour${i === 0 ? ' is-now' : ''}" aria-label="${esc(time)}: ${esc(w.label)}, ${temp} degrees${pop >= 20 ? `, ${pop}% chance of precipitation` : ''}">`
                + `<span class="hour__time">${esc(time)}</span>`
                + `<span class="hour__icon">${icon(w.icon)}</span>`
                + `<span class="hour__pop">${pop >= 20 ? `${round(pop)}%` : ''}</span>`
                + `<span class="hour__temp" style="--b:${(CURVE_H - pts[i][1] + 9).toFixed(1)}px">${temp}°</span>`
                + '</li>';
        }

        const width = n * col;
        const path = smoothPath(pts);
        const dots = pts.map(([x, y], i) => `<circle cx="${x}" cy="${y.toFixed(1)}" r="${i === 0 ? 4 : 2.2}"${i === 0 ? ' class="is-now"' : ''}/>`).join('');
        $('#hourly').innerHTML =
            `<ol class="hours">${items}</ol>`
            + `<svg class="curve" viewBox="0 0 ${width} ${CURVE_H}" preserveAspectRatio="none" aria-hidden="true">`
            + `<path class="curve__area" d="${path}L${pts[n - 1][0]} ${CURVE_H}L${pts[0][0]} ${CURVE_H}Z"/>`
            + `<path class="curve__line" pathLength="1" d="${path}"/>${dots}</svg>`;
    }

    const hourlyScroll = $('#hourly-scroll');
    function updateHourlyNav() {
        const max = hourlyScroll.scrollWidth - hourlyScroll.clientWidth;
        $('#h-prev').hidden = hourlyScroll.scrollLeft < 8;
        $('#h-next').hidden = hourlyScroll.scrollLeft > max - 8;
    }
    hourlyScroll.addEventListener('scroll', updateHourlyNav, { passive: true });
    const scrollHours = dir => hourlyScroll.scrollBy({ left: dir * hourlyScroll.clientWidth * 0.7, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    $('#h-prev').addEventListener('click', () => scrollHours(-1));
    $('#h-next').addEventListener('click', () => scrollHours(1));

    /* 7-day list with temperature range bars */
    const TEMP_STOPS = [[-15, [126, 150, 255]], [0, [108, 190, 255]], [10, [104, 224, 206]], [18, [186, 230, 124]], [25, [255, 214, 92]], [32, [255, 152, 72]], [40, [255, 92, 82]]];
    function tempColor(c) {
        if (c <= TEMP_STOPS[0][0]) return `rgb(${TEMP_STOPS[0][1]})`;
        for (let i = 1; i < TEMP_STOPS.length; i++) {
            const [t1, c1] = TEMP_STOPS[i];
            if (c <= t1) {
                const [t0, c0] = TEMP_STOPS[i - 1];
                const k = (c - t0) / (t1 - t0);
                return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k))})`;
            }
        }
        return `rgb(${TEMP_STOPS[TEMP_STOPS.length - 1][1]})`;
    }

    function renderDaily(fc, di) {
        const D = fc.daily;
        const idx = [];
        for (let i = di; i < D.time.length && idx.length < 7; i++) idx.push(i);
        const lo = Math.min(...idx.map(i => D.temperature_2m_min[i]));
        const hi = Math.max(...idx.map(i => D.temperature_2m_max[i]));
        const span = hi - lo || 1;

        $('#daily').innerHTML = idx.map((i, row) => {
            const w = describe(D.weather_code[i], true);
            const min = D.temperature_2m_min[i], max = D.temperature_2m_max[i];
            const pop = D.precipitation_probability_max[i] ?? 0;
            const date = T(D.time[i]);
            const name = row === 0 ? 'Today' : fmt(date, { weekday: 'short' });
            const dot = row === 0 ? `<i class="range__now" style="--p:${clamp((fc.current.temperature_2m - lo) / span * 100, 0, 100).toFixed(1)}%"></i>` : '';
            return `<li class="day" aria-label="${esc(row === 0 ? 'Today' : fmt(date, { weekday: 'long' }))}: ${esc(w.label)}, high ${U.temp(max)}, low ${U.temp(min)}${pop >= 20 ? `, ${pop}% chance of precipitation` : ''}">`
                + `<span class="day__name">${esc(name)}</span>`
                + `<span class="day__icon">${icon(w.icon)}</span>`
                + `<span class="day__pop">${pop >= 20 ? `${round(pop)}%` : ''}</span>`
                + `<span class="day__lo">${U.temp(min)}°</span>`
                + `<span class="range"><i class="range__fill" style="--i:${row};--l:${((min - lo) / span * 100).toFixed(1)}%;--r:${((hi - max) / span * 100).toFixed(1)}%;background:linear-gradient(90deg,${tempColor(min)},${tempColor(max)})"></i>${dot}</span>`
                + `<span class="day__hi">${U.temp(max)}°</span>`
                + '</li>';
        }).join('');
    }

    /* Detail tiles */
    const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const band = (v, bands) => bands.find(([max]) => v <= max)[1];

    function renderTiles(fc, aq, now, di) {
        const cur = fc.current;
        const D = fc.daily;
        const tiles = [];
        const tile = (iconName, label, body, cls = '') =>
            tiles.push(`<article class="tile ${cls}" style="--i:${tiles.length}"><h3 class="tile__label">${line(iconName)}${label}</h3>${body}</article>`);

        // Feels like
        const diff = cur.apparent_temperature - cur.temperature_2m;
        const feelNote = diff <= -2 ? (cur.wind_speed_10m > 20 ? 'Wind is making it feel colder.' : 'Feels colder than the actual temperature.')
            : diff >= 2 ? (cur.relative_humidity_2m > 60 ? 'Humidity is making it feel warmer.' : 'Feels warmer than the actual temperature.')
                : 'Similar to the actual temperature.';
        tile('feels', 'Feels like', `<p class="tile__value">${U.temp(cur.apparent_temperature)}°</p><p class="tile__note">${feelNote}</p>`);

        // Wind
        const dir = cur.wind_direction_10m ?? 0;
        let ticks = '';
        for (let a = 0; a < 360; a += 45) {
            if (a === 0) continue;
            const r = a * Math.PI / 180;
            ticks += `M${(50 + Math.sin(r) * 36).toFixed(1)} ${(50 - Math.cos(r) * 36).toFixed(1)}L${(50 + Math.sin(r) * 42).toFixed(1)} ${(50 - Math.cos(r) * 42).toFixed(1)}`;
        }
        tile('wind', 'Wind',
            `<div class="tile__row"><p class="tile__value">${U.speed(cur.wind_speed_10m)}<small>${U.speedUnit()}</small></p>`
            + `<svg class="compass" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46"/><path class="ticks" d="${ticks}"/>`
            + `<text x="50" y="19">N</text><path class="needle" style="--deg:${round(dir + 180)}deg" d="M50 22l10 34-10-7-10 7z"/></svg></div>`
            + `<p class="tile__note">From ${COMPASS[Math.round(dir / 22.5) % 16]} · Gusts ${U.speed(cur.wind_gusts_10m ?? cur.wind_speed_10m)} ${U.speedUnit()}</p>`);

        // Humidity
        tile('drop', 'Humidity',
            `<p class="tile__value">${round(cur.relative_humidity_2m)}<small>%</small></p>`
            + `<div class="meter-wrap"><div class="meter meter--plain"><i style="--p:${clamp(cur.relative_humidity_2m, 0, 100)}%"></i></div></div>`
            + `<p class="tile__note">Dew point ${U.temp(cur.dew_point_2m)}°</p>`);

        // UV index
        const uv = Math.max(0, cur.uv_index ?? 0);
        const uvMax = D.uv_index_max[di];
        tile('uv', 'UV index',
            `<p class="tile__value">${round(uv)}</p><p class="tile__tag">${band(uv, [[2.5, 'Low'], [5.5, 'Moderate'], [7.5, 'High'], [10.5, 'Very high'], [Infinity, 'Extreme']])}</p>`
            + `<div class="meter-wrap"><div class="meter meter--uv"><i style="--p:${clamp(uv / 11 * 100, 0, 100).toFixed(1)}%"></i></div></div>`
            + `<p class="tile__note">${uvMax != null ? `Peaks at ${round(uvMax)} today` : '&nbsp;'}</p>`);

        // Sunrise and sunset
        const sr = T(D.sunrise[di] || ''), ss = T(D.sunset[di] || '');
        if (ss > sr) {
            const p = (now - sr) / (ss - sr);
            const up = p >= 0 && p <= 1;
            const t = clamp(p, 0, 1);
            const x = 16 + 168 * t;
            const y = (1 - t) * (1 - t) * 58 + 2 * (1 - t) * t * -30 + t * t * 58;
            const nextRise = T(D.sunrise[di + 1] || '');
            const note = up ? `Sunset in ${fmtSpan(ss - now)}`
                : now < sr ? `Sunrise in ${fmtSpan(sr - now)}`
                    : nextRise > now ? `Sunrise in ${fmtSpan(nextRise - now)}` : `${fmtSpan(ss - sr)} of daylight`;
            tile('sun', 'Sun',
                `<svg class="sunarc" viewBox="0 0 200 66" aria-hidden="true"><defs><clipPath id="sun-done"><rect x="0" y="0" width="${x.toFixed(1)}" height="58"/></clipPath></defs>`
                + '<path class="arc" d="M16 58Q100 -30 184 58"/>'
                + `<path class="arc arc--done" d="M16 58Q100 -30 184 58" clip-path="url(#sun-done)"/>`
                + '<path class="horizon" d="M4 58h192"/>'
                + `<circle class="dot${up ? '' : ' dot--night'}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"/></svg>`
                + `<div class="suntimes"><div><b>${fmtTime(sr)}</b>Sunrise</div><div><b>${fmtTime(ss)}</b>Sunset</div></div>`
                + `<p class="tile__note">${note}</p>`, 'tile--wide');
        } else {
            tile('sun', 'Sun', '<p class="tile__value">—</p><p class="tile__note">No sunrise or sunset here today.</p>', 'tile--wide');
        }

        // Air quality
        const aqi = aq?.current?.us_aqi;
        if (aqi != null) {
            const pm = aq.current.pm2_5;
            tile('air', 'Air quality',
                `<p class="tile__value">${round(aqi)}</p><p class="tile__tag">${band(aqi, [[50, 'Good'], [100, 'Moderate'], [150, 'Poor for some'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']])}</p>`
                + `<div class="meter-wrap"><div class="meter meter--aqi"><i style="--p:${clamp(aqi / 300 * 100, 0, 100).toFixed(1)}%"></i></div></div>`
                + `<p class="tile__note">${pm != null ? `PM2.5 ${round(pm)} µg/m³` : 'US AQI'}</p>`);
        } else {
            tile('air', 'Air quality', '<p class="tile__value">—</p><p class="tile__note">Not available for this place right now.</p>');
        }

        // Visibility
        const vis = cur.visibility;
        if (vis != null) {
            tile('eye', 'Visibility',
                `<p class="tile__value">${U.dist(vis)}<small>${U.distUnit()}</small></p>`
                + `<p class="tile__note">${band(vis, [[1000, 'Fog is cutting visibility.'], [4000, 'Hazy.'], [9999, 'Fairly clear.'], [Infinity, 'Perfectly clear view.']])}</p>`);
        } else {
            tile('eye', 'Visibility', '<p class="tile__value">—</p><p class="tile__note">Not available.</p>');
        }

        // Pressure
        const hpa = cur.pressure_msl;
        tile('gauge', 'Pressure',
            `<p class="tile__value">${U.pressure(hpa)}<small>${U.pressureUnit()}</small></p>`
            + `<div class="meter-wrap"><div class="meter meter--plain"><i style="--p:${clamp((hpa - 970) / 80 * 100, 0, 100).toFixed(1)}%"></i></div></div>`
            + `<p class="tile__note">${band(hpa, [[1005, 'Low, often unsettled.'], [1020, 'Normal.'], [Infinity, 'High, often settled.']])}</p>`);

        $('#tiles').innerHTML = tiles.join('');
    }

    function tickClock() {
        if (!state.data || views.dash.hidden) return;
        const now = Date.now() + state.data.fc.utc_offset_seconds * 1000;
        $('#clock').textContent = fmt(now, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    }

    /* ------------------------------------------------------------------ saved places */

    const savedNav = $('#saved');

    function renderSaved() {
        savedNav.hidden = !state.saved.length;
        savedNav.innerHTML = state.saved.map((p, i) =>
            `<button type="button" class="chip" data-i="${i}"${state.place && state.place.id === p.id ? ' aria-current="true"' : ''}>${esc(p.name)}</button>`).join('');
    }

    savedNav.addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (chip) load(state.saved[+chip.dataset.i]);
    });

    $('#star').addEventListener('click', () => {
        const p = state.place;
        if (!p) return;
        const i = state.saved.findIndex(s => s.id === p.id);
        if (i >= 0) state.saved.splice(i, 1);
        else state.saved = [p, ...state.saved].slice(0, 8);
        store.set(KEYS.saved, state.saved);
        renderSaved();
        const saved = i < 0;
        $('#star').setAttribute('aria-pressed', saved);
        $('#star').setAttribute('aria-label', saved ? 'Remove from saved places' : 'Save this place');
    });

    /* ------------------------------------------------------------------ units */

    const unitButtons = document.querySelectorAll('.units button');
    function syncUnits() {
        unitButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.unit === state.units));
    }
    unitButtons.forEach(b => b.addEventListener('click', () => {
        if (state.units === b.dataset.unit) return;
        state.units = b.dataset.unit;
        store.set(KEYS.units, state.units);
        syncUnits();
        if (state.data && !views.dash.hidden) render(false);
    }));

    /* ------------------------------------------------------------------ search */

    const form = $('#search');
    const input = $('#q');
    const list = $('#suggest');
    let items = [];
    let itemsFor = '';
    let active = -1;
    let suggestCtl = null;
    let suggestTimer = 0;

    function closeSuggest() {
        clearTimeout(suggestTimer);
        suggestCtl?.abort();
        list.hidden = true;
        active = -1;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function drawSuggest() {
        list.innerHTML = items.length
            ? items.map((p, i) =>
                `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}"><b>${esc(p.name)}</b><span>${esc([p.admin, p.country].filter(v => v && v !== p.name).join(', '))}</span></li>`).join('')
            : '<li class="suggest__empty" role="option" aria-disabled="true" aria-selected="false">No matching places</li>';
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`);
        else input.removeAttribute('aria-activedescendant');
    }

    async function suggest(query) {
        suggestCtl?.abort();
        const ctl = suggestCtl = new AbortController();
        try {
            const results = await findPlaces(query, ctl.signal);
            if (input.value.trim() !== query) return;
            items = results;
            itemsFor = query;
            active = -1;
            drawSuggest();
        } catch (err) {
            if (err.name !== 'AbortError') closeSuggest();
        }
    }

    function choose(place) {
        closeSuggest();
        input.value = '';
        input.blur();
        items = [];
        itemsFor = '';
        load(place);
    }

    input.addEventListener('input', () => {
        clearTimeout(suggestTimer);
        const query = input.value.trim();
        if (query.length < 2) { closeSuggest(); return; }
        suggestTimer = setTimeout(() => suggest(query), 220);
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeSuggest(); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        if (list.hidden || !items.length) return;
        e.preventDefault();
        active = e.key === 'ArrowDown' ? (active + 1) % items.length : (active <= 0 ? items.length : active) - 1;
        drawSuggest();
    });

    // pointerdown fires before the input loses focus, so the choice always registers
    list.addEventListener('pointerdown', e => {
        const li = e.target.closest('li[data-i]');
        if (!li) return;
        e.preventDefault();
        choose(items[+li.dataset.i]);
    });

    document.addEventListener('pointerdown', e => {
        if (!form.contains(e.target)) closeSuggest();
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (active >= 0 && items[active]) { choose(items[active]); return; }
        const query = input.value.trim();
        if (!query) { input.focus(); return; }
        closeSuggest();
        setBusy(true);
        let handedOff = false;
        try {
            const results = itemsFor === query && items.length ? items : await findPlaces(query);
            if (results.length) {
                handedOff = true; // load() manages the busy state from here
                choose(results[0]);
                return;
            }
            loadCtl?.abort();
            $('#nf-query').textContent = `“${query}”`;
            hideBanner();
            setView('notfound');
            input.select();
        } catch {
            showBanner("Can't reach the search service. Check your connection and try again.");
        } finally {
            if (!handedOff) setBusy(false);
        }
    });

    /* ------------------------------------------------------------------ location */

    function locate() {
        if (!navigator.geolocation) {
            showBanner("Location isn't available in this browser. Search for a city instead.");
            return;
        }
        document.body.classList.add('is-locating');
        const done = () => document.body.classList.remove('is-locating');
        navigator.geolocation.getCurrentPosition(async pos => {
            const lat = +pos.coords.latitude.toFixed(3);
            const lon = +pos.coords.longitude.toFixed(3);
            const place = { id: `geo:${lat.toFixed(2)},${lon.toFixed(2)}`, name: 'My location', admin: '', country: '', lat, lon };
            try {
                Object.assign(place, await API.reverse(lat, lon));
            } catch { /* keep the generic name */ }
            done();
            load(place);
        }, err => {
            done();
            showBanner(err.code === 1
                ? 'Location access is blocked. Allow it in your browser settings, or search for a city instead.'
                : "Couldn't find your location. Search for a city instead.");
        }, { timeout: 10000, maximumAge: 10 * 60 * 1000 });
    }

    $('#locate').addEventListener('click', locate);
    $('#welcome-locate').addEventListener('click', locate);
    $('#retry').addEventListener('click', () => (state.place ? load(state.place) : setView('welcome')));

    /* ------------------------------------------------------------------ start */

    const PICKS = [
        { id: 'om:1275339', name: 'Mumbai', admin: 'Maharashtra', country: 'India', lat: 19.07283, lon: 72.88261 },
        { id: 'om:2643743', name: 'London', admin: 'England', country: 'United Kingdom', lat: 51.50853, lon: -0.12574 },
        { id: 'om:5128581', name: 'New York', admin: 'New York', country: 'United States', lat: 40.71427, lon: -74.00597 },
        { id: 'om:1850147', name: 'Tokyo', admin: 'Tokyo', country: 'Japan', lat: 35.6895, lon: 139.69171 },
        { id: 'om:2147714', name: 'Sydney', admin: 'New South Wales', country: 'Australia', lat: -33.86785, lon: 151.20732 },
    ];
    $('#picks').innerHTML = PICKS.map((p, i) => `<button type="button" class="pill" data-i="${i}">${esc(p.name)}</button>`).join('');
    $('#picks').addEventListener('click', e => {
        const b = e.target.closest('.pill');
        if (b) load(PICKS[+b.dataset.i]);
    });

    // Keep the clock, sky and data fresh while the page stays open.
    function refreshIfStale() {
        if (document.hidden || !state.place || !state.data) return;
        if (Date.now() - state.data.at > REFRESH_MS) load(state.place, false);
    }
    setInterval(() => {
        tickClock();
        if (!views.dash.hidden) applySky();
        refreshIfStale();
    }, 30000);
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('online', () => state.place && load(state.place, false));

    // The hourly strip uses wider columns on large screens.
    matchMedia('(min-width: 940px)').addEventListener?.('change', () => {
        if (state.data && !views.dash.hidden) {
            renderHourly(state.data.fc, Date.now() + state.data.fc.utc_offset_seconds * 1000);
            updateHourlyNav();
        }
    });

    syncUnits();
    renderSaved();

    const lastPlace = store.get(KEYS.last, null);
    if (lastPlace && typeof lastPlace.lat === 'number') {
        const cached = store.get(KEYS.cache, null);
        if (cached && cached.placeId === lastPlace.id && cached.fc && Date.now() - cached.at < CACHE_MS) state.data = cached;
        else ambientSky();
        load(lastPlace);
    } else {
        ambientSky();
        setView('welcome');
        // Only auto-locate when permission was already granted, so nobody is greeted by a prompt.
        navigator.permissions?.query({ name: 'geolocation' }).then(res => {
            if (res.state === 'granted' && !state.place) locate();
        }).catch(() => { });
    }
})();
