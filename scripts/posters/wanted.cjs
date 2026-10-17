// An Admiralty "wanted" poster with a crew member's photo. Run:
//   node scripts/posters/wanted.cjs --photo <jpg|png> [--alias "THE DEFIANT REFUSAL"] [--crime "Line one|Line two"]
//                                   [--reward "500 SOVEREIGNS"] [--crop x,y,w,h] [--out posters-print/wanted.svg]
// The photo is embedded in the SVG, so the result is written to the git-ignored posters-print/ folder, never to
// public/posters/ (which is deployed and committed). Render a PNG with: node scripts/posters/render-png.cjs <that svg>
const fs = require('fs');
const path = require('path');
const { gear, frame, grain, svg } = require('./lib.cjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.photo) { console.error('Usage: node scripts/posters/wanted.cjs --photo <image> [--alias ...] [--crime "a|b"] [--reward ...] [--crop x,y,w,h] [--out file.svg]'); process.exit(1); }

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const alias = (args.alias || 'THE DEFIANT REFUSAL').toUpperCase();
const crimes = (args.crime || 'refusing a lawful order of the fleet|insolent gestures toward an officer').split('|');
const reward = (args.reward || '500 SOVEREIGNS').toUpperCase();
const [cx, cy, cw, ch] = (args.crop || '300,160,400,490').split(',').map(Number);
const out = args.out || path.join(__dirname, '..', '..', 'posters-print', 'wanted.svg');

const mime = /\.png$/i.test(args.photo) ? 'image/png' : 'image/jpeg';
const photo = `data:${mime};base64,${fs.readFileSync(args.photo).toString('base64')}`;

const c = { paper1: '#ead9a6', paper2: '#cbb27a', ink: '#1a1410', crimson: '#8f1d2c', navy: '#13203c', gold: '#b98a1d', edge: '#1a1410' };
const FONT = "font-family=\"Cinzel, Georgia, 'Times New Roman', serif\" font-weight=\"700\"";
// textLength keeps the lettering inside its box whatever font is available
const fit = (text, size, max) => Math.min(max, Math.round(text.length * size * 0.66));

const PX = 140, PY = 226, PW = 320, PH = Math.round(PW * (ch / cw)); // photo window

const defs = `
  <radialGradient id="paper" cx="50%" cy="45%" r="80%"><stop offset="0" stop-color="${c.paper1}"/><stop offset="1" stop-color="${c.paper2}"/></radialGradient>
  <radialGradient id="vig" cx="50%" cy="50%" r="70%"><stop offset=".55" stop-color="#3a2208" stop-opacity="0"/><stop offset="1" stop-color="#3a2208" stop-opacity=".55"/></radialGradient>
  <radialGradient id="shade" cx="50%" cy="45%" r="70%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
  <filter id="duotone" color-interpolation-filters="sRGB">
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer>
      <feFuncR type="table" tableValues="0.10 0.98"/><feFuncG type="table" tableValues="0.07 0.88"/><feFuncB type="table" tableValues="0.05 0.64"/>
    </feComponentTransfer>
  </filter>
  ${grain()}`;

const body = `
  <rect width="600" height="900" fill="url(#paper)"/>
  <rect width="600" height="900" fill="url(#vig)"/>
  ${frame({ gold: c.crimson, edge: c.edge })}

  <text x="300" y="76" text-anchor="middle" ${FONT} font-size="20" fill="${c.crimson}" textLength="380" lengthAdjust="spacingAndGlyphs" letter-spacing="3">BY ORDER OF THE ADMIRALTY</text>
  <text x="300" y="196" text-anchor="middle" ${FONT} font-size="124" fill="${c.ink}" textLength="470" lengthAdjust="spacingAndGlyphs">WANTED</text>
  <path d="M70,206 H530" stroke="${c.ink}" stroke-width="4"/><path d="M70,213 H530" stroke="${c.ink}" stroke-width="1.5"/>

  <!-- the photograph -->
  <rect x="${PX - 10}" y="${PY - 10}" width="${PW + 20}" height="${PH + 20}" fill="${c.ink}"/>
  <rect x="${PX - 5}" y="${PY - 5}" width="${PW + 10}" height="${PH + 10}" fill="none" stroke="${c.gold}" stroke-width="2"/>
  <svg x="${PX}" y="${PY}" width="${PW}" height="${PH}" viewBox="${cx} ${cy} ${cw} ${ch}" preserveAspectRatio="xMidYMid slice">
    <image href="${photo}" x="0" y="0" width="1054" height="1492" filter="url(#duotone)"/>
  </svg>
  <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" fill="url(#shade)"/>
  ${[[PX - 10, PY - 10], [PX + PW + 10, PY - 10], [PX - 10, PY + PH + 10], [PX + PW + 10, PY + PH + 10]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="${c.gold}" stroke="${c.edge}" stroke-width="1.5"/>`).join('')}

  <!-- the Admiralty seal, stamped over the corner of the photograph -->
  <g transform="translate(${PX + PW + 6},${PY + PH - 8}) rotate(-12)" opacity=".92">
    <path d="${gear(0, 0, 50, 43, 18)}" fill="${c.crimson}" stroke="${c.edge}" stroke-width="2"/>
    <circle r="35" fill="none" stroke="${c.paper1}" stroke-width="2"/>
    <path d="M-28,0 Q0,-22 28,0 Q0,22 -28,0 Z" fill="${c.paper1}" stroke="${c.edge}" stroke-width="1.5"/>
    <circle r="9" fill="${c.navy}"/><circle cx="-2" cy="-2" r="2.5" fill="#fff"/>
  </g>

  <!-- who and why -->
  <text x="300" y="${PY + PH + 38}" text-anchor="middle" ${FONT} font-size="13" fill="${c.ink}" textLength="170" lengthAdjust="spacingAndGlyphs" letter-spacing="2">KNOWN ONLY AS</text>
  <text x="300" y="${PY + PH + 76}" text-anchor="middle" ${FONT} font-size="38" fill="${c.crimson}" textLength="${fit(alias, 38, 480)}" lengthAdjust="spacingAndGlyphs">${esc(alias)}</text>
  ${crimes.map((t, i) => `<text x="300" y="${PY + PH + 104 + i * 21}" text-anchor="middle" ${FONT} font-size="15" fill="${c.ink}" textLength="${fit(t, 15, 460)}" lengthAdjust="spacingAndGlyphs">${i === 0 ? 'For ' : 'And '}${esc(t)}.</text>`).join('')}

  <path d="M60,${PY + PH + 150} H540" stroke="${c.ink}" stroke-width="1.5"/>
  <text x="300" y="${PY + PH + 176}" text-anchor="middle" ${FONT} font-size="14" fill="${c.ink}" textLength="120" lengthAdjust="spacingAndGlyphs" letter-spacing="3">REWARD</text>
  <text x="300" y="${PY + PH + 214}" text-anchor="middle" ${FONT} font-size="40" fill="${c.crimson}" textLength="${fit(reward, 40, 400)}" lengthAdjust="spacingAndGlyphs">${esc(reward)}</text>
  <text x="300" y="868" text-anchor="middle" ${FONT} font-size="10" fill="${c.ink}" opacity=".85" textLength="440" lengthAdjust="spacingAndGlyphs">COTTAGE CON · NOV 26–29 · PRINTED BY AUTHORITY OF THE LORD HIGH ADMIRAL</text>
  <rect width="600" height="900" filter="url(#grain)" opacity=".6" style="mix-blend-mode:multiply" pointer-events="none"/>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg({
  title: `Wanted by the Admiralty: ${alias}`,
  desc: `Steampunk wanted poster issued by the Admiralty for ${alias}, with a sepia photograph, the charges and a reward of ${reward}.`,
  defs, body,
}));
console.log('wrote', path.relative(process.cwd(), out), `(${Math.round(fs.statSync(out).size / 1024)} KB)`);
