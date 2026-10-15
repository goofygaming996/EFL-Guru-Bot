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

// Optional: drop a .ttf/.otf (e.g. Montserrat-Bold.ttf) in ./fonts and it is
// registered automatically. Useful on minimal Linux hosts with no system fonts.
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

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
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

function drawPlaceholderAvatar(ctx, x, y, w, h, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h * 0.38, w * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h * 0.88, w * 0.36, h * 0.28, 0, Math.PI, 0);
  ctx.fill();
  ctx.restore();
}

function drawCornerAccents(ctx, inset, gold, cyan) {
  const corners = [
    [inset, inset, 1, 1],
    [W - inset, inset, -1, 1],
    [inset, H - inset, 1, -1],
    [W - inset, H - inset, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    // filled gold triangle
    ctx.fillStyle = gold;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sx * 46, cy);
    ctx.lineTo(cx, cy + sy * 46);
    ctx.closePath();
    ctx.fill();
    // cyan inner chevron
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cyan;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + sx * 56, cy + sy * 8);
    ctx.lineTo(cx + sx * 8, cy + sy * 8);
    ctx.lineTo(cx + sx * 8, cy + sy * 56);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------
const THEMES = {
  gold: {
    ratingColor: '#2b2100',
    positionColor: '#2b2100',
    nameColor: '#2b2100',
    statValue: '#2b2100',
    statLabel: '#5c4700',
    divider: 'rgba(43,33,0,0.55)',
    panelFill: 'rgba(255,255,255,0.22)',
    panelStroke: 'rgba(255,255,255,0.8)',
    placeholder: '#2b2100',
  },
  tots: {
    ratingColor: '#F5D060',
    positionColor: '#00E5FF',
    nameColor: '#F5D060',
    statValue: '#F5D060',
    statLabel: '#00E5FF',
    divider: 'rgba(0,229,255,0.7)',
    panelFill: 'rgba(0,229,255,0.07)',
    panelStroke: 'rgba(0,229,255,0.6)',
    placeholder: '#00E5FF',
  },
};

function drawBackground(ctx, type) {
  if (type === 'tots') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#001335');
    g.addColorStop(1, '#000A1A');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // outer gold frame
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 5;
    roundRectPath(ctx, 14, 14, W - 28, H - 28, 22);
    ctx.stroke();

    // inner cyan frame
    ctx.strokeStyle = '#00E5FF';
    ctx.lineWidth = 2;
    roundRectPath(ctx, 28, 28, W - 56, H - 56, 14);
    ctx.stroke();

    drawCornerAccents(ctx, 14, '#D4AF37', '#00E5FF');
  } else {
    ctx.fillStyle = '#D4AF37';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 10;
    roundRectPath(ctx, 15, 15, W - 30, H - 30, 20);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Card renderer
// ---------------------------------------------------------------------------
async function renderCard(opts) {
  const { type, name, rating, position, stats, roblox, teamLogoUrl, leagueIconUrl } = opts;
  const t = THEMES[type];

  // Fetch all remote images in parallel; each helper is crash-safe.
  const [avatar, teamLogo, leagueIcon] = await Promise.all([
    fetchRobloxHeadshot(roblox),
    safeLoadImage(teamLogoUrl),
    safeLoadImage(leagueIconUrl),
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  drawBackground(ctx, type);

  // Team logo (top-left) & league icon (top-right)
  if (teamLogo) drawContain(ctx, teamLogo, 48, 48, 90, 90);
  if (leagueIcon) drawContain(ctx, leagueIcon, W - 48 - 90, 48, 90, 90);

  // Rating + position (left column)
  ctx.textAlign = 'center';
  ctx.fillStyle = t.ratingColor;
  ctx.font = `bold 84px ${FONT}`;
  ctx.fillText(String(rating), 100, 245);
  ctx.fillStyle = t.positionColor;
  fitFont(ctx, position, 110, 38);
  ctx.fillText(position, 100, 292);

  // Avatar panel
  const px = 180, py = 150, pw = 280, ph = 300;
  ctx.save();
  roundRectPath(ctx, px, py, pw, ph, 24);
  ctx.fillStyle = t.panelFill;
  ctx.fill();
  ctx.clip();
  if (avatar) {
    drawCover(ctx, avatar, px, py, pw, ph);
  } else {
    drawPlaceholderAvatar(ctx, px, py, pw, ph, t.placeholder);
  }
  ctx.restore();
  ctx.strokeStyle = t.panelStroke;
  ctx.lineWidth = 2;
  roundRectPath(ctx, px, py, pw, ph, 24);
  ctx.stroke();

  // Player name
  ctx.textAlign = 'center';
  ctx.fillStyle = t.nameColor;
  fitFont(ctx, name, 500, 46);
  ctx.fillText(name, W / 2, 510);

  // Divider
  ctx.strokeStyle = t.divider;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(110, 535);
  ctx.lineTo(W - 110, 535);
  ctx.stroke();

  // Stats grid (2 rows x 3 columns)
  const grid = [
    ['PAC', stats.pace], ['SHO', stats.shooting], ['PAS', stats.passing],
    ['DRI', stats.dribbling], ['DEF', stats.defense], ['PHY', stats.physical],
  ];
  const colX = [130, 300, 470];
  const rowValueY = [592, 672];
  const rowLabelY = [622, 702];
  grid.forEach(([label, value], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    ctx.fillStyle = t.statValue;
    ctx.font = `bold 44px ${FONT}`;
    ctx.fillText(String(value), colX[col], rowValueY[row]);
    ctx.fillStyle = t.statLabel;
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText(label, colX[col], rowLabelY[row]);
  });

  // TOTS footer tag
  if (type === 'tots') {
    const bx = 130, by = 724, bw = 340, bh = 40;
    const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    bg.addColorStop(0, '#B8921F');
    bg.addColorStop(0.5, '#F5D060');
    bg.addColorStop(1, '#B8921F');
    roundRectPath(ctx, bx, by, bw, bh, 10);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = '#001335';
    ctx.font = `bold 22px ${FONT}`;
    try { ctx.letterSpacing = '2px'; } catch { /* unsupported, ignore */ }
    ctx.fillText('TEAM OF THE SEASON', W / 2, by + 28);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
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
    const type = str(q.cardtype, 'gold', 10).toLowerCase() === 'tots' ? 'tots' : 'gold';

    const png = await renderCard({
      type,
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
