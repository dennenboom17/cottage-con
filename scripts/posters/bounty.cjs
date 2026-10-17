// A Gearwrights' League "bounty" poster with a crew member's photo (the League's answer to wanted.cjs). Run:
//   node scripts/posters/bounty.cjs --photo <jpg|png> [--alias "THE GREAT REFUSER"] [--crime "Line one|Line two"]
//                                   [--reward "500 SOVEREIGNS"] [--crop x,y,w,h] [--out posters-print/bounty.svg]
// Like wanted.cjs, the photo is embedded, so the result goes to the git-ignored posters-print/ folder, never public/.
// Render a PNG with: node scripts/posters/render-png.cjs posters-print/bounty.svg
const fs = require('fs');
const path = require('path');
const { gear, rays, grain, svg } = require('./lib.cjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.photo) { console.error('Usage: node scripts/posters/bounty.cjs --photo <image> [--alias ...] [--crime "a|b"] [--reward ...] [--crop x,y,w,h] [--out file.svg]'); process.exit(1); }

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const alias = (args.alias || 'THE GREAT REFUSER').toUpperCase();
const crimes = (args.crime || 'failing to share the toolbox|idling suspiciously through the whole shift').split('|');
const reward = (args.reward || '500 SOVEREIGNS').toUpperCase();
const [cx, cy, cw, ch] = (args.crop || '300,160,400,490').split(',').map(Number);
const out = args.out || path.join(__dirname, '..', '..', 'posters-print', 'bounty.svg');

const mime = /\.png$/i.test(args.photo) ? 'image/png' : 'image/jpeg';
const photo = `data:${mime};base64,${fs.readFileSync(args.photo).toString('base64')}`;

const c = { cream: '#efe2bf', black: '#15130f', green: '#1f8a66', dgreen: '#0f4a38', brass: '#c8962b', brassL: '#efc766', rust: '#b2472a', edge: '#15130f' };
const FONT = "font-family=\"Cinzel, Impact, Georgia, 'Times New Roman', serif\" font-weight=\"900\"";
const fit = (text, size, max) => Math.min(max, Math.round(text.length * size * 0.68));

const PW = 290, PH = Math.round(PW * (ch / cw)), PX = 155, PY = 244; // photo window, before the tilt

const defs = `
  <linearGradient id="wedge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.green}"/><stop offset="1" stop-color="${c.dgreen}"/></linearGradient>
  <radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></radialGradient>
  <radialGradient id="shade" cx="50%" cy="45%" r="70%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></radialGradient>
  <filter id="duotone" color-interpolation-filters="sRGB">
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer>
      <feFuncR type="table" tableValues="0.04 0.93"/><feFuncG type="table" tableValues="0.09 0.96"/><feFuncB type="table" tableValues="0.06 0.80"/>
    </feComponentTransfer>
  </filter>
  ${grain()}`;

const body = `
  <rect width="600" height="900" fill="${c.cream}"/>
  <g opacity=".3">${rays(300, 470, 44, 1000, c.brass, 2, 0.05)}</g>

  <!-- the bold diagonal band behind the photograph -->
  <path d="M0,262 L600,214 L600,650 L0,698 Z" fill="url(#wedge)"/>
  <path d="M0,262 L600,214 L600,232 L0,280 Z" fill="${c.black}"/>
  <path d="M0,680 L600,632 L600,650 L0,698 Z" fill="${c.black}"/>
  <path d="${gear(-24, 470, 150, 126, 18)}" fill="${c.black}" stroke="${c.brass}" stroke-width="5" stroke-linejoin="round"/>
  <circle cx="-24" cy="470" r="46" fill="${c.green}" stroke="${c.brass}" stroke-width="5"/>
  <path d="${gear(624, 430, 130, 108, 16)}" fill="${c.dgreen}" stroke="${c.brass}" stroke-width="5" stroke-linejoin="round"/>
  <circle cx="624" cy="430" r="40" fill="${c.black}" stroke="${c.brass}" stroke-width="5"/>

  <!-- banner and headline -->
  <g transform="rotate(-3 300 70)">
    <path d="M-20,30 H620 V104 H-20 Z" fill="${c.black}"/>
    <path d="M-20,30 H620" stroke="${c.brass}" stroke-width="5"/><path d="M-20,104 H620" stroke="${c.brass}" stroke-width="5"/>
    <text x="300" y="84" text-anchor="middle" ${FONT} font-size="38" fill="${c.cream}" textLength="520" lengthAdjust="spacingAndGlyphs">THE GEARWRIGHTS' LEAGUE</text>
  </g>
  <text x="300" y="196" text-anchor="middle" ${FONT} font-size="104" fill="${c.rust}" stroke="${c.black}" stroke-width="4" paint-order="stroke" textLength="470" lengthAdjust="spacingAndGlyphs">BOUNTY</text>

  <!-- the photograph, pinned slightly crooked -->
  <g transform="rotate(-2.5 ${PX + PW / 2} ${PY + PH / 2})">
    <rect x="${PX - 10}" y="${PY - 10}" width="${PW + 20}" height="${PH + 20}" fill="${c.cream}" stroke="${c.black}" stroke-width="5"/>
    <svg x="${PX}" y="${PY}" width="${PW}" height="${PH}" viewBox="${cx} ${cy} ${cw} ${ch}" preserveAspectRatio="xMidYMid slice">
      <image href="${photo}" x="0" y="0" width="1054" height="1492" filter="url(#duotone)"/>
    </svg>
    <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" fill="url(#shade)"/>
    <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" fill="none" stroke="${c.black}" stroke-width="3"/>
    ${[[PX + PW / 2, PY - 10]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="${c.brass}" stroke="${c.black}" stroke-width="3"/>`).join('')}
    <!-- the League's seal, stamped over a corner -->
    <g transform="translate(${PX + PW + 4},${PY + PH - 6}) rotate(10)" opacity=".95">
      <path d="${gear(0, 0, 48, 41, 16)}" fill="${c.green}" stroke="${c.black}" stroke-width="3" stroke-linejoin="round"/>
      <circle r="33" fill="${c.black}" stroke="${c.brass}" stroke-width="3"/>
      <path d="${gear(0, 0, 21, 16, 10)}" fill="${c.brass}" stroke="${c.black}" stroke-width="1.5"/><circle r="6" fill="${c.black}"/>
    </g>
  </g>

  <!-- who and why -->
  <text x="300" y="698" text-anchor="middle" ${FONT} font-size="12" fill="${c.black}" textLength="160" lengthAdjust="spacingAndGlyphs" letter-spacing="2">KNOWN ONLY AS</text>
  <text x="300" y="738" text-anchor="middle" ${FONT} font-size="38" fill="${c.black}" textLength="${fit(alias, 38, 480)}" lengthAdjust="spacingAndGlyphs">${esc(alias)}</text>
  ${crimes.map((t, i) => `<text x="300" y="${760 + i * 18}" text-anchor="middle" ${FONT} font-size="14" fill="${c.black}" textLength="${fit(t, 14, 460)}" lengthAdjust="spacingAndGlyphs">${i === 0 ? 'FOR ' : 'AND FOR '}${esc(t.toUpperCase())}.</text>`).join('')}

  <rect x="40" y="792" width="520" height="56" fill="${c.black}"/>
  <text x="300" y="808" text-anchor="middle" ${FONT} font-size="12" fill="${c.brassL}" textLength="110" lengthAdjust="spacingAndGlyphs" letter-spacing="3">THE LEAGUE PAYS</text>
  <text x="300" y="839" text-anchor="middle" ${FONT} font-size="32" fill="${c.cream}" textLength="${fit(reward, 32, 420)}" lengthAdjust="spacingAndGlyphs">${esc(reward)}</text>
  <text x="300" y="865" text-anchor="middle" ${FONT} font-size="10" fill="${c.black}" textLength="400" lengthAdjust="spacingAndGlyphs">THE ENGINES RUN ON US · COTTAGE CON · NOV 26–29</text>

  <rect x="14" y="14" width="572" height="872" fill="none" stroke="${c.black}" stroke-width="8"/>
  <rect x="26" y="26" width="548" height="848" fill="none" stroke="${c.brass}" stroke-width="2.5"/>
  <rect width="600" height="900" fill="url(#vig)"/>
  <rect width="600" height="900" filter="url(#grain)" opacity=".55" style="mix-blend-mode:multiply" pointer-events="none"/>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg({
  title: `Bounty from the Gearwrights' League: ${alias}`,
  desc: `Steampunk bounty poster issued by the Gearwrights' League for ${alias}, with a photograph, the charges and a reward of ${reward}, in the style of a Constructivist workers' poster.`,
  defs, body,
}));
console.log('wrote', path.relative(process.cwd(), out), `(${Math.round(fs.statSync(out).size / 1024)} KB)`);
