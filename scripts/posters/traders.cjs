const { rays, airship, frame, grain, svg } = require('./lib.cjs');

const c = { sky1: '#0c3040', sky2: '#14586a', sun: '#f2a93b', sunL: '#ffd56a', cream: '#f6ead0', ink: '#14110e', coin: '#e8b730', coinD: '#8d6a12', cloud: '#f3dfb8', gold: '#e8b730', edge: '#14110e' };
const FONT = "font-family=\"Cinzel, Georgia, 'Times New Roman', serif\" font-weight=\"700\"";
const ship = { body: '#f4e3bd', fin: '#d2bd8a', line: c.ink, seam: '#b8a470', band: '#c4452b', gondola: '#8a6a3a', window: '#ffd56a', flag: '#c4452b' };

// stacked clouds
const cloud = (x, y, s, o = 1) => `<g transform="translate(${x},${y}) scale(${s})" opacity="${o}" fill="${c.cloud}">
  <ellipse cx="0" cy="0" rx="70" ry="22"/><ellipse cx="-40" cy="-12" rx="34" ry="22"/><ellipse cx="22" cy="-18" rx="40" ry="26"/><ellipse cx="62" cy="-4" rx="28" ry="18"/></g>`;

// a pair of balance scales centred on (0,0)
const scales = `<g>
  <path d="M0,-70 V60" stroke="${c.ink}" stroke-width="9" stroke-linecap="round"/>
  <path d="M-30,64 H30 M-18,52 H18" stroke="${c.ink}" stroke-width="9" stroke-linecap="round"/>
  <path d="M-84,-52 H84" stroke="${c.ink}" stroke-width="8" stroke-linecap="round"/>
  <circle cx="0" cy="-70" r="11" fill="${c.coin}" stroke="${c.ink}" stroke-width="5"/>
  ${[-84, 84].map((x) => `<path d="M${x},-52 L${x - 34},2 M${x},-52 L${x + 34},2" stroke="${c.ink}" stroke-width="3.5"/><path d="M${x - 40},2 H${x + 40} Q${x + 36},30 ${x},32 Q${x - 36},30 ${x - 40},2 Z" fill="${c.coin}" stroke="${c.ink}" stroke-width="5" stroke-linejoin="round"/>`).join('')}
  <circle cx="-84" cy="-4" r="13" fill="${c.coin}" stroke="${c.ink}" stroke-width="4"/><circle cx="-60" cy="-8" r="13" fill="${c.coin}" stroke="${c.ink}" stroke-width="4"/>
  <rect x="72" y="-30" width="26" height="28" fill="#8a6a3a" stroke="${c.ink}" stroke-width="4"/><rect x="92" y="-22" width="22" height="20" fill="#b88a4a" stroke="${c.ink}" stroke-width="4"/>
</g>`;

// crates hanging from the airship on a net
const cargo = `<g>
  <path d="M-52,70 L-40,128 M52,70 L40,128 M0,70 V128" stroke="${c.ink}" stroke-width="3"/>
  <rect x="-58" y="124" width="46" height="40" fill="#b88a4a" stroke="${c.ink}" stroke-width="4"/><path d="M-58,124 L-12,164 M-12,124 L-58,164" stroke="${c.ink}" stroke-width="2.4"/>
  <rect x="-8" y="124" width="36" height="40" fill="#c4452b" stroke="${c.ink}" stroke-width="4"/><path d="M-8,144 H28" stroke="${c.ink}" stroke-width="2.4"/>
  <rect x="32" y="130" width="34" height="34" fill="#8a6a3a" stroke="${c.ink}" stroke-width="4"/><path d="M32,147 H66" stroke="${c.ink}" stroke-width="2.4"/>
</g>`;

const defs = `
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.sky1}"/><stop offset=".55" stop-color="${c.sky2}"/><stop offset="1" stop-color="#e98a3a"/></linearGradient>
  <radialGradient id="sun" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${c.sunL}"/><stop offset=".7" stop-color="${c.sun}"/><stop offset="1" stop-color="#e0702a"/></radialGradient>
  <radialGradient id="vig" cx="50%" cy="50%" r="72%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>
  <linearGradient id="goldg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d672"/><stop offset=".5" stop-color="${c.gold}"/><stop offset="1" stop-color="${c.coinD}"/></linearGradient>
  ${grain()}`;

const body = `
  <rect width="600" height="900" fill="url(#sky)"/>
  <g opacity=".16">${rays(300, 330, 36, 800, c.sunL, 2, 0.04)}</g>

  <!-- the setting sun -->
  <circle cx="300" cy="330" r="200" fill="${c.sun}" opacity=".25"/>
  <circle cx="300" cy="330" r="160" fill="url(#sun)"/>
  ${[0, 1, 2, 3, 4].map((i) => `<rect x="130" y="${372 + i * 22}" width="340" height="${5 + i * 2.4}" fill="#e98a3a" opacity=".55"/>`).join('')}
  ${cloud(104, 232, 0.9, 0.9)}${cloud(504, 190, 0.7, 0.8)}${cloud(486, 462, 1.1, 0.95)}${cloud(92, 505, 1.0, 0.95)}

  <!-- the airship, dropping its cargo -->
  ${airship(300, 322, 1.45, ship)}
  <g transform="translate(300,378.5) scale(0.95)">${cargo}</g>

  <!-- cloud bank and scales -->
  <path d="M0,690 Q80,650 170,672 T330,664 T500,676 T600,660 V900 H0 Z" fill="${c.cloud}"/>
  <path d="M0,720 Q100,690 200,708 T400,702 T600,712 V900 H0 Z" fill="#e8cf9c"/>
  <g transform="translate(300,718) scale(0.7)">${scales}</g>

  ${frame({ gold: c.gold, edge: c.edge })}

  <!-- header -->
  <path d="M60,60 H540 L554,86 L540,112 H60 L46,86 Z" fill="${c.cream}" stroke="${c.gold}" stroke-width="4"/>
  <text x="300" y="97" text-anchor="middle" ${FONT} font-size="26" fill="${c.ink}" textLength="420" lengthAdjust="spacingAndGlyphs">THE FREE TRADERS</text>
  <text x="300" y="138" text-anchor="middle" ${FONT} font-size="13" fill="${c.cream}" textLength="300" lengthAdjust="spacingAndGlyphs" letter-spacing="2">COTTAGE CON · NOV 26–29</text>

  <!-- slogan -->
  <rect x="44" y="788" width="512" height="84" fill="${c.ink}" opacity=".9" stroke="${c.gold}" stroke-width="3"/>
  <text x="300" y="827" text-anchor="middle" ${FONT} font-size="38" fill="${c.cream}" textLength="470" lengthAdjust="spacingAndGlyphs">FREE TRADE FLIES</text>
  <text x="300" y="862" text-anchor="middle" ${FONT} font-size="33" fill="${c.gold}" textLength="470" lengthAdjust="spacingAndGlyphs">UNDER ANY FLAG</text>

  <rect width="600" height="900" fill="url(#vig)"/>
  <rect width="600" height="900" filter="url(#grain)" opacity=".5" style="mix-blend-mode:multiply" pointer-events="none"/>`;

module.exports = svg({
  title: 'The Free Traders: Free Trade Flies Under Any Flag',
  desc: 'Steampunk propaganda poster for the Free Traders: a cargo airship crossing a setting sun above a bank of clouds, with a pair of balance scales, in the style of a vintage travel poster.',
  defs, body,
});
