const { gear, rays, arcPath, airship, frame, grain, svg } = require('./lib.cjs');

const c = { bg1: '#b02a3b', bg2: '#33080e', cream: '#f3e6c4', gold: '#e2b43a', goldDark: '#8f6c14', navy: '#13203c', steel: '#d3d9e2', edge: '#2a1a05' };
const FONT = "font-family=\"Cinzel, Georgia, 'Times New Roman', serif\" font-weight=\"700\"";
const ship = { body: c.cream, fin: '#d9c898', line: c.navy, seam: '#b9a878', band: '#b02a3b', gondola: '#bfae82', window: c.navy, flag: c.gold };

const eyeLashes = Array.from({ length: 13 }, (_, i) => {
  const a = Math.PI + (i / 12) * Math.PI; // across the top
  const x1 = Math.cos(a) * 66, y1 = Math.sin(a) * 40 - 6, x2 = Math.cos(a) * 92, y2 = Math.sin(a) * 62 - 8;
  return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}" stroke="${c.gold}" stroke-width="3" stroke-linecap="round"/>`;
}).join('');

const compass = [0, 90, 180, 270].map((deg) =>
  `<path d="M0,-104 L8,-90 L-8,-90 Z" transform="rotate(${deg})" fill="${c.gold}" stroke="${c.edge}" stroke-width="1"/>`).join('');

const defs = `
  <radialGradient id="bg" cx="50%" cy="44%" r="75%"><stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></radialGradient>
  <radialGradient id="vig" cx="50%" cy="50%" r="72%"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d672"/><stop offset=".5" stop-color="${c.gold}"/><stop offset="1" stop-color="${c.goldDark}"/></linearGradient>
  <radialGradient id="disc" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#22345e"/><stop offset="1" stop-color="#0a1226"/></radialGradient>
  ${arcPath('arcTop', 300, 385, 140, 'top')}
  ${arcPath('arcBot', 300, 385, 157, 'bottom')}
  ${grain()}`;

const body = `
  <rect width="600" height="900" fill="url(#bg)"/>
  <g opacity=".07">${rays(300, 400, 40, 800, '#fff', 2)}</g>
  <rect width="600" height="900" fill="url(#vig)"/>
  ${frame(c)}

  <!-- header plaque -->
  <path d="M70,62 H530 L548,84 L530,106 H70 L52,84 Z" fill="${c.cream}" stroke="${c.gold}" stroke-width="4"/>
  <text x="300" y="93" text-anchor="middle" ${FONT} font-size="24" fill="${c.navy}" textLength="400" lengthAdjust="spacingAndGlyphs">BY ORDER OF THE ADMIRALTY</text>

  <text x="300" y="130" text-anchor="middle" ${FONT} font-size="13" fill="${c.gold}" textLength="300" lengthAdjust="spacingAndGlyphs" letter-spacing="2">COTTAGE CON · NOV 26–29</text>

  <!-- the watching gear -->
  <path d="${gear(300, 385, 204, 178, 30)}" fill="url(#gold)" stroke="${c.edge}" stroke-width="3.5" stroke-linejoin="round"/>
  <circle cx="300" cy="385" r="170" fill="${c.navy}" stroke="${c.edge}" stroke-width="3"/>
  <circle cx="300" cy="385" r="164" fill="none" stroke="${c.gold}" stroke-width="2"/>
  ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<circle cx="${(300 + Math.cos(a * Math.PI / 180) * 175).toFixed(1)}" cy="${(385 + Math.sin(a * Math.PI / 180) * 175).toFixed(1)}" r="3.2" fill="${c.edge}"/>`).join('')}
  <text ${FONT} font-size="19" fill="${c.gold}" letter-spacing="2"><textPath href="#arcTop" startOffset="25%" text-anchor="middle" textLength="390" lengthAdjust="spacingAndGlyphs">THE ADMIRALTY WATCHES THE SKIES</textPath></text>
  <text ${FONT} font-size="16" fill="${c.cream}" letter-spacing="3"><textPath href="#arcBot" startOffset="25%" text-anchor="middle" textLength="330" lengthAdjust="spacingAndGlyphs">ORDER · DUTY · VIGILANCE</textPath></text>
  <circle cx="300" cy="385" r="118" fill="url(#disc)" stroke="${c.gold}" stroke-width="3"/>
  <g transform="translate(300,385)">
    ${compass}
    ${eyeLashes}
    <path d="M-92,0 Q0,-70 92,0 Q0,70 -92,0 Z" fill="${c.cream}" stroke="${c.gold}" stroke-width="4"/>
    <path d="M-92,0 Q0,-70 92,0" fill="none" stroke="${c.edge}" stroke-width="2" opacity=".5"/>
    <circle r="36" fill="${c.bg1}" stroke="${c.edge}" stroke-width="2.5"/>
    <path d="${gear(0, 0, 33, 26, 18)}" fill="url(#gold)" stroke="${c.edge}" stroke-width="1.6"/>
    <circle r="16" fill="${c.navy}"/>
    <circle cx="-6" cy="-7" r="5" fill="#fff" opacity=".9"/>
  </g>

  <!-- the fleet -->
  ${airship(104, 150, 0.27, ship)}
  ${airship(498, 160, 0.27, ship)}
  ${airship(300, 622, 0.34, ship)}
  ${airship(112, 618, 0.2, ship)}
  ${airship(488, 618, 0.2, ship)}

  <!-- slogan -->
  <rect x="44" y="660" width="512" height="184" fill="#0b1226" opacity=".92" stroke="${c.gold}" stroke-width="3"/>
  <rect x="52" y="668" width="496" height="168" fill="none" stroke="${c.gold}" stroke-width="1" opacity=".7"/>
  <text x="300" y="727" text-anchor="middle" ${FONT} font-size="64" fill="${c.cream}" textLength="440" lengthAdjust="spacingAndGlyphs">A TIGHT SHIP</text>
  <text x="300" y="788" text-anchor="middle" ${FONT} font-size="62" fill="${c.gold}" textLength="440" lengthAdjust="spacingAndGlyphs">IS A SAFE SHIP</text>
  <text x="300" y="820" text-anchor="middle" ${FONT} font-size="15" fill="${c.steel}" textLength="440" lengthAdjust="spacingAndGlyphs">Report loose lips and unlisted cargo to the nearest officer.</text>
  <text x="300" y="862" text-anchor="middle" ${FONT} font-size="11" fill="${c.cream}" opacity=".85" textLength="300" lengthAdjust="spacingAndGlyphs">PRINTED BY AUTHORITY OF THE LORD HIGH ADMIRAL</text>
  <rect width="600" height="900" filter="url(#grain)" opacity=".5" style="mix-blend-mode:multiply" pointer-events="none"/>`;

module.exports = svg({
  title: 'The Admiralty: A Tight Ship Is a Safe Ship',
  desc: 'Steampunk propaganda poster for the Admiralty: a great brass gear holding a watchful eye over a fleet of airships, in crimson and gold.',
  defs, body,
});
