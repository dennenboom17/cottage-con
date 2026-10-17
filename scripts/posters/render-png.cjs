// Renders public/posters/*.svg to print-size PNGs in posters-print/ (git-ignored) (1800 x 2700) with a headless Chrome or Edge.
// Run: node scripts/posters/render-png.cjs [file.svg ...]   (no arguments: the three faction posters; set CHROME=/path/to/chrome if it isn't found)
// Regenerate the SVGs first (node scripts/posters/build.cjs) if you've changed a poster.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const SCALE = 3; // 600 x 900 SVG units -> 1800 x 2700 pixels
const root = path.join(__dirname, '..', '..');
const dir = path.join(root, 'public', 'posters');
const out = path.join(root, 'posters-print');
fs.mkdirSync(out, { recursive: true });

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = candidates.find((p) => fs.existsSync(p));
if (!chrome) { console.error('No Chrome or Edge found. Set the CHROME environment variable to its path.'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-poster-'));
let failed = false;
const jobs = process.argv.length > 2
  ? process.argv.slice(2).map((p) => ({ svg: path.resolve(p), png: path.join(out, path.basename(p).replace(/\.svg$/i, '') + '.png') }))
  : ['admiralty', 'league', 'traders'].map((name) => ({ svg: path.join(dir, `${name}.svg`), png: path.join(out, `${name}.png`) }));
for (const { svg, png } of jobs) {
  const name = path.basename(svg);
  if (fs.existsSync(png)) fs.unlinkSync(png);
  spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`,
    `--force-device-scale-factor=${SCALE}`, '--window-size=600,900', '--virtual-time-budget=8000',
    `--screenshot=${png}`, pathToFileURL(svg).href,
  ], { stdio: 'ignore' });
  if (fs.existsSync(png)) console.log('wrote', path.relative(process.cwd(), png), `${Math.round(fs.statSync(png).size / 1024)} KB`);
  else { console.error('FAILED', name); failed = true; }
}
fs.rmSync(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
