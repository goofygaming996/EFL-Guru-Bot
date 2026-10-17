'use strict';

const express = require('express');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const W = 600;
const H = 800;
const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB cap per remote image
const MAX_REDIRECTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (compatible; FIFACardGenerator/1.0; +https://example.com/bot)';

// Order of the icons in the row at the bottom of the card (left to right).
// Options: 'nation', 'league', 'club'
const BOTTOM_ORDER = ['nation', 'league', 'club'];

// Small print at the bottom of the card
const BRAND = 'EFL';

// Optional: drop a .ttf/.otf in ./fonts and it is registered automatically.
try {
  const fontDir = path.join(__dirname, 'fonts');
  if (fs.existsSync(fontDir)) {
    for (const f of fs.readdirSync(fontDir)) {
      if (/\.(ttf|otf)$/i.test(f)) {
        GlobalFonts.registerFromPath(path.join(fontDir, f), 'CardFont');
      }
    }
  }
} catch (e) {
  console.warn('Font registration skipped:', e.message);
}
const FONT = 'CardFont, Arial, Helvetica, "DejaVu Sans", sans-serif';

// ---------------------------------------------------------------------------
// Safe networking helpers
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return (
      l === '::1' || l === '::' ||
      l.startsWith('fc') || l.startsWith('fd') ||
      l.startsWith('fe80') || l.startsWith('::ffff:')
    );
  }
  return true;
}

// Blocks requests to localhost / private networks (SSRF protection).
async function assertPublicUrl(urlStr) {
  const url = new URL(urlStr);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported protocol');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private address blocked');
    return;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private host blocked');
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Private address blocked');
  }
}

async function fetchBuffer(urlStr, extraHeaders = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*,application/json;q=0.9,*/*;q=0.8',
          ...extraHeaders,
        },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error('Response too large');

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('Response too large');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects');
}

// BDFD's $url[encode;...] percent-encodes values, so the URL may arrive
// encoded (https%3A%2F%2F...). Decode defensively without ever throwing.
function normalizeUrl(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  for (let i = 0; i < 2; i++) {
    if (/^https?:\/\//i.test(u) && !/%3A%2F%2F/i.test(u)) break;
    try {
      const decoded = decodeURIComponent(u);
      if (decoded === u) break;
      u = decoded;
    } catch {
      break;
    }
  }
  return /^https?:\/\//i.test(u) ? u : null;
}

// Never throws: returns an Image or null.
async function safeLoadImage(rawUrl) {
  try {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;
    const buf = await fetchBuffer(url);
    return await loadImage(buf);
  } catch (err) {
    console.warn('[image] failed:', String(rawUrl).slice(0, 120), '-', err.message);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Roblox headshot via the official Thumbnails API. Never throws.
async function fetchRobloxHeadshot(userId) {
  try {
    if (!/^\d{1,20}$/.test(userId || '')) return null;
    const api =
      `https://thumbnails.roblox.com/v1/users/avatar-headshot` +
      `?userIds=${userId}&size=420x420&format=Png&isCircular=false`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const json = JSON.parse((await fetchBuffer(api)).toString('utf8'));
      const item = json && json.data && json.data[0];
      if (item && item.state === 'Completed' && item.imageUrl) {
        const img = await fetchBuffer(item.imageUrl);
        return await loadImage(img);
      }
      if (!item || item.state === 'Error' || item.state === 'Blocked') return null;
      await sleep(600); // "Pending" -> retry
    }
    return null;
  } catch (err) {
    console.warn('[roblox] failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Color helpers (custom card color)
// ---------------------------------------------------------------------------
const GOLD_RGB = [212, 175, 55];

const NAMED_COLORS = {
  gold: 'D4AF37', red: 'D32F2F', blue: '1E66F5', green: '2E9E4F',
  purple: '8E44AD', pink: 'FF69B4', orange: 'FF8C1A', yellow: 'FFD21F',
  black: '111111', white: 'F2F2F2', silver: 'B8BCC4', grey: '8A8F98',
  gray: '8A8F98', cyan: '00BCD4', teal: '14A098', brown: '8B5A2B',
  navy: '14285A', maroon: '7A1F2B', lime: '8BD42B', bronze: 'CD7F32',
};

// Accepts "ff0000", "#ff0000", "f00" or a color name. Returns [r,g,b] or null.
function parseColor(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/^#/, '').replace(/\s+/g, '');
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s].toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

// ---------------------------------------------------------------------------
// Nation flag: accepts a 2-letter country code ("in", "br", "gb-eng"),
// a common country name ("brazil"), or a direct image URL.
// ---------------------------------------------------------------------------
const NATION_NAMES = {
  england: 'gb-eng', scotland: 'gb-sct', wales: 'gb-wls', uk: 'gb',
  brazil: 'br', argentina: 'ar', france: 'fr', germany: 'de', spain: 'es',
  portugal: 'pt', italy: 'it', netherlands: 'nl', belgium: 'be', croatia: 'hr',
  india: 'in', usa: 'us', america: 'us', mexico: 'mx', canada: 'ca',
  japan: 'jp', korea: 'kr', morocco: 'ma', egypt: 'eg', nigeria: 'ng',
  senegal: 'sn', ghana: 'gh', uruguay: 'uy', colombia: 'co', poland: 'pl',
  turkey: 'tr', norway: 'no', sweden: 'se', denmark: 'dk', australia: 'au',
  srilanka: 'lk', pakistan: 'pk', bangladesh: 'bd', nepal: 'np',
};

function nationUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^https?:\/\//i.test(s) || /%3A%2F%2F/i.test(s)) return s;
  s = s.toLowerCase().replace(/\s+/g, '');
  if (NATION_NAMES[s]) s = NATION_NAMES[s];
  if (/^[a-z]{2}(-[a-z]{2,3})?$/.test(s)) return `https://flagcdn.com/w320/${s}.png`;
  return null;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const brightness = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function buildTheme(type, base) {
  if (type === 'tots') {
    return {
      special: true,
      bgTop: '#001335', bgBottom: '#000A1A',
      glow: 'rgba(0,229,255,0.22)', ray: 'rgba(0,229,255,0.07)',
      band: ['rgba(0,229,255,0.07)', 'rgba(0,0,0,0.3)'],
      outer: '#D4AF37', inner: '#00E5FF', extra: 'rgba(212,175,55,0.7)',
      accent: '#D4AF37',
      tag: 'TEAM OF THE SEASON', tagFill: ['#B8921F', '#F5D060'], tagText: '#001335',
      text: '#F5D060',
      sub: '#00E5FF',
      line: 'rgba(0,229,255,0.7)',
      placeholder: '#00E5FF',
    };
  }
  if (type === 'totw') {
    return {
      special: true,
      bgTop: '#232323', bgBottom: '#040404',
      glow: 'rgba(242,210,122,0.20)', ray: 'rgba(242,210,122,0.07)',
      band: ['rgba(242,210,122,0.06)', 'rgba(0,0,0,0.35)'],
      outer: '#D4AF37', inner: 'rgba(255,255,255,0.75)', extra: 'rgba(212,175,55,0.6)',
      accent: '#D4AF37',
      tag: 'TEAM OF THE WEEK', tagFill: ['#B8921F', '#F2D27A'], tagText: '#0B0B0B',
      text: '#F2D27A',
      sub: '#E8E8E8',
      line: 'rgba(242,210,122,0.65)',
      placeholder: '#F2D27A',
    };
  }
  const light = brightness(base) > 0.6;
  return {
    special: false,
    top: mix(base, WHITE, 0.42),
    mid: base,
    bottom: mix(base, BLACK, 0.38),
    ray: 'rgba(255,255,255,0.13)',
    band: [rgb(mix(base, WHITE, 0.5), 0.45), rgb(mix(base, WHITE, 0.2), 0.2)],
    text: light ? rgb(mix(base, BLACK, 0.82)) : '#FFFFFF',
    sub: light ? rgb(mix(base, BLACK, 0.62)) : rgb(mix(base, WHITE, 0.78)),
    line: light ? rgb(mix(base, BLACK, 0.7), 0.55) : 'rgba(255,255,255,0.6)',
    border: rgb(mix(base, WHITE, 0.8)),
    placeholder: light ? rgb(mix(base, BLACK, 0.7)) : '#FFFFFF',
  };
}

// ---------------------------------------------------------------------------
// Card outline (modern FC-style): wide crown, flared shoulders,
// straight sides, bevelled bottom with a centre point.
// Designed in a 604-wide space and mapped onto the 600x800 canvas.
// ---------------------------------------------------------------------------
const SC = 1.2; // scale
const mp = (x, y) => [300 + (x - 302) * SC, 40 + (y - 65) * SC];

function shieldPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(...mp(302, 65));
  // left crown + shoulder flare
  ctx.bezierCurveTo(...mp(250, 65), ...mp(185, 72), ...mp(140, 92));
  ctx.bezierCurveTo(...mp(127, 98), ...mp(102, 122), ...mp(86, 126));
  // left side + bevelled bottom to centre point
  ctx.lineTo(...mp(86, 590));
  ctx.bezierCurveTo(...mp(86, 612), ...mp(104, 628), ...mp(140, 638));
  ctx.bezierCurveTo(...mp(200, 652), ...mp(262, 654), ...mp(302, 668));
  // right bottom + side
  ctx.bezierCurveTo(...mp(342, 654), ...mp(404, 652), ...mp(464, 638));
  ctx.bezierCurveTo(...mp(500, 628), ...mp(518, 612), ...mp(518, 590));
  ctx.lineTo(...mp(518, 126));
  // right shoulder flare + crown
  ctx.bezierCurveTo(...mp(502, 122), ...mp(477, 98), ...mp(464, 92));
  ctx.bezierCurveTo(...mp(419, 72), ...mp(354, 65), ...mp(302, 65));
  ctx.closePath();
}

function insetShield(ctx, scale) {
  ctx.translate(300, 400);
  ctx.scale(scale, scale);
  ctx.translate(-300, -400);
  shieldPath(ctx);
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawContain(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function fitFont(ctx, text, maxWidth, startSize, weight = 'bold') {
  let size = startSize;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && size > 14) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
}

// Player image with a soft fade at the bottom so it blends into the card.
function drawAvatarFaded(ctx, img, x, y, size) {
  const off = createCanvas(size, size);
  const o = off.getContext('2d');
  const scale = Math.min(size / img.width, size / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  o.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
  o.globalCompositeOperation = 'destination-in';
  const g = o.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.82, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  o.fillStyle = g;
  o.fillRect(0, 0, size, size);
  ctx.drawImage(off, x, y);
}

function drawPlaceholderAvatar(ctx, x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size * 0.38, size * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x + size / 2, y + size * 0.86, size * 0.32, size * 0.26, 0, Math.PI, 0);
  ctx.fill();
  ctx.restore();
}

// Sunburst rays fanning out from a point (clipped to the card by the caller).
function drawRays(ctx, cx, cy, color) {
  const n = 44;
  const step = (Math.PI * 2) / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const wFactor = 0.25 + 0.5 * (((i * 37) % 7) / 7); // deterministic variety
    const a0 = i * step;
    const a1 = a0 + step * wFactor;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 900, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
}

const BAND_Y = 500; // top of the lower info band

function drawBackground(ctx, theme) {
  // Fill
  shieldPath(ctx);
  if (theme.special) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, theme.bgTop);
    g.addColorStop(1, theme.bgBottom);
    ctx.fillStyle = g;
  } else {
    const g = ctx.createLinearGradient(0, 40, 0, 760);
    g.addColorStop(0, rgb(theme.top));
    g.addColorStop(0.45, rgb(theme.mid));
    g.addColorStop(1, rgb(theme.bottom));
    ctx.fillStyle = g;
  }
  ctx.fill();

  // Rays, glow, lower band - clipped to the card
  ctx.save();
  shieldPath(ctx);
  ctx.clip();

  const RX = 410;
  const RY = 330;
  drawRays(ctx, RX, RY, theme.ray);

  const glow = ctx.createRadialGradient(RX, RY, 10, RX, RY, 280);
  glow.addColorStop(0, theme.special ? theme.glow : 'rgba(255,255,255,0.35)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, BAND_Y);

  const band = ctx.createLinearGradient(0, BAND_Y, 0, H);
  band.addColorStop(0, theme.band[0]);
  band.addColorStop(1, theme.band[1]);
  ctx.fillStyle = band;
  ctx.fillRect(0, BAND_Y, W, H - BAND_Y);
  ctx.fillStyle = theme.special ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.3)';
  ctx.fillRect(0, BAND_Y, W, 1.5);

  if (theme.special) {
    // Gold accents on the shoulders
    ctx.fillStyle = theme.accent;
    for (const s of [1, -1]) {
      const cx = s === 1 ? 38 : 562;
      ctx.beginPath();
      ctx.moveTo(cx, 112);
      ctx.lineTo(cx + s * 34, 112);
      ctx.lineTo(cx, 138);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Frames
  ctx.save();
  shieldPath(ctx);
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.special ? theme.outer : theme.border;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  insetShield(ctx, 0.95);
  ctx.lineWidth = 2 / 0.95;
  ctx.strokeStyle = theme.special ? theme.inner : theme.line;
  ctx.stroke();
  ctx.restore();

  if (theme.special) {
    ctx.save();
    insetShield(ctx, 0.91);
    ctx.lineWidth = 1.5 / 0.91;
    ctx.strokeStyle = theme.extra;
    ctx.stroke();
    ctx.restore();
  }
}

function drawFlag(ctx, img, x, y, w, h, lineColor) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 5);
  ctx.clip();
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2,
    img.width * s, img.height * s);
  ctx.restore();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, x, y, w, h, 5);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Card renderer
// ---------------------------------------------------------------------------
async function renderCard(opts) {
  const { type, color, name, rating, position, stats, roblox, teamLogoUrl, leagueIconUrl, nation } = opts;
  const theme = buildTheme(type, color);

  // Fetch all remote images in parallel; each helper is crash-safe.
  const [avatar, teamLogo, leagueIcon, flag] = await Promise.all([
    fetchRobloxHeadshot(roblox),
    safeLoadImage(teamLogoUrl),
    safeLoadImage(leagueIconUrl),
    safeLoadImage(nationUrl(nation)),
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  drawBackground(ctx, theme);

  // Player image (centre-right, fading into the lower band)
  const AV = 370;
  const avX = 125;
  const avY = 146;
  if (avatar) {
    drawAvatarFaded(ctx, avatar, avX, avY, AV);
  } else {
    drawPlaceholderAvatar(ctx, avX, avY, AV, theme.placeholder);
  }

  // Event tag at the top (TOTS / TOTW only)
  if (theme.special) {
    const bx = 200, by = 62, bw = 200, bh = 24;
    const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    bg.addColorStop(0, theme.tagFill[0]);
    bg.addColorStop(0.5, theme.tagFill[1]);
    bg.addColorStop(1, theme.tagFill[0]);
    roundRectPath(ctx, bx, by, bw, bh, 7);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = theme.tagText;
    ctx.textAlign = 'center';
    ctx.font = `bold 13px ${FONT}`;
    try { ctx.letterSpacing = '1px'; } catch { /* unsupported, ignore */ }
    ctx.fillText(theme.tag, W / 2, by + 17);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
  }

  // Rating + position (top-left)
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.text;
  ctx.font = `bold 76px ${FONT}`;
  ctx.fillText(String(rating), 120, 198);
  fitFont(ctx, position, 84, 34);
  ctx.fillStyle = theme.special ? theme.sub : theme.text;
  ctx.fillText(position, 120, 238);

  // Player name
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.text;
  fitFont(ctx, name, 400, 44);
  ctx.fillText(name, W / 2, 556);

  // Stats in one row: label above value
  // Goalkeepers use different stat names in the same six slots:
  // pace=DIV, shooting=HAN, passing=KIC, dribbling=REF, defense=SPE, physical=POS
  const isGK = position === 'GK' || position === 'GKP';
  const labels = isGK
    ? ['DIV', 'HAN', 'KIC', 'REF', 'SPE', 'POS']
    : ['PAC', 'SHO', 'PAS', 'DRI', 'DEF', 'PHY'];
  const values = [stats.pace, stats.shooting, stats.passing,
    stats.dribbling, stats.defense, stats.physical];
  values.forEach((value, i) => {
    const x = 300 + (i - 2.5) * 76;
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.sub;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText(labels[i], x, 598);
    ctx.fillStyle = theme.text;
    ctx.font = `bold 38px ${FONT}`;
    ctx.fillText(String(value), x, 646);
  });

  // Icon row: nation flag, league, club (order set by BOTTOM_ORDER)
  const available = {
    nation: flag ? { img: flag, w: 58, h: 38, flag: true } : null,
    league: leagueIcon ? { img: leagueIcon, w: 46, h: 46 } : null,
    club: teamLogo ? { img: teamLogo, w: 46, h: 46 } : null,
  };
  const row = BOTTOM_ORDER.map((k) => available[k]).filter(Boolean);
  if (row.length) {
    const GAP = 24;
    const total = row.reduce((s, it) => s + it.w, 0) + GAP * (row.length - 1);
    let x = W / 2 - total / 2;
    const cy = 686;
    for (const it of row) {
      if (it.flag) drawFlag(ctx, it.img, x, cy - it.h / 2, it.w, it.h, theme.line);
      else drawContain(ctx, it.img, x, cy - it.h / 2, it.w, it.h);
      x += it.w + GAP;
    }
  }

  // Small brand print at the very bottom
  if (BRAND) {
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.sub;
    ctx.globalAlpha = 0.85;
    ctx.font = `bold 14px ${FONT}`;
    try { ctx.letterSpacing = '3px'; } catch { /* ignore */ }
    ctx.fillText(BRAND, W / 2, 723);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
    ctx.globalAlpha = 1;
  }

  return canvas.encode('png');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

const first = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v, def = '', max = 40) => {
  const s = String(first(v) ?? '').trim();
  return (s || def).slice(0, max);
};
const num = (v, def, min = 1, max = 99) => {
  const n = parseInt(first(v), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/card', async (req, res) => {
  try {
    const q = req.query;
    const ct = str(q.cardtype, 'gold', 10).toLowerCase();
    const type = ct === 'tots' || ct === 'totw' ? ct : 'gold';

    const png = await renderCard({
      type,
      color: parseColor(first(q.color)) || GOLD_RGB,
      roblox: str(q.roblox, '', 20),
      name: str(q.cardname, 'PLAYER', 24).toUpperCase(),
      rating: num(q.rating, 75),
      position: str(q.position, 'ST', 4).toUpperCase(),
      stats: {
        pace: num(q.pace, 70),
        shooting: num(q.shooting, 70),
        passing: num(q.passing, 70),
        dribbling: num(q.dribbling, 70),
        defense: num(q.defense, 40),
        physical: num(q.physical, 70),
      },
      teamLogoUrl: first(q.teamlogo),
      leagueIconUrl: first(q.leagueicon),
      nation: first(q.nation),
    });

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
    });
    res.send(png);
  } catch (err) {
    console.error('[card] render error:', err);
    res.status(500).json({ error: 'Failed to generate card' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Card server listening on :${PORT}`));
}

module.exports = app;
module.exports.parseColor = parseColor;
module.exports.renderCard = renderCard;
