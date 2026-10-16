const { gear, rays, rivets, grain, svg } = require('./lib.cjs');

const c = { cream: '#efe2bf', black: '#15130f', green: '#1f8a66', dgreen: '#0f4a38', brass: '#c8962b', brassL: '#efc766', rust: '#b2472a', edge: '#15130f' };
const FONT = "font-family=\"Cinzel, Impact, Georgia, 'Times New Roman', serif\" font-weight=\"900\"";

// a clenched fist (front view) gripping a spanner, centred on x=300
const fist = `
  <g transform="translate(0,40)">
    <!-- spanner: handle and open jaw -->
    <rect x="288" y="150" width="24" height="270" rx="6" fill="${c.brass}" stroke="${c.edge}" stroke-width="5"/>
    <path d="M286,78.4 A42,42 0 1,0 314,78.4 L314,108 L286,108 Z" fill="${c.brass}" stroke="${c.edge}" stroke-width="5" stroke-linejoin="round"/>
    <circle cx="300" cy="128" r="9" fill="${c.edge}"/>
    <path d="M294,200 L294,400" stroke="${c.brassL}" stroke-width="4" stroke-linecap="round" opacity=".8"/>
    <!-- sleeve and cuff -->
    <path d="M236,560 L230,650 H370 L364,560 Z" fill="${c.black}"/>
    <rect x="226" y="548" width="148" height="34" rx="6" fill="${c.brass}" stroke="${c.edge}" stroke-width="5"/>
    ${rivets([[246, 565], [274, 565], [300, 565], [326, 565], [354, 565]], 4.5, c.edge, c.brassL)}
    <!-- fingers: four stacked knuckles -->
    ${[372, 408, 444, 480].map((y, i) => `<rect x="${232 + (i % 2) * 2}" y="${y}" width="136" height="34" rx="17" fill="${c.black}" stroke="${c.cream}" stroke-width="2.5"/>
      <path d="M252,${y + 9} H348" stroke="${c.cream}" stroke-width="2" opacity=".45" stroke-linecap="round"/>`).join('')}
    <!-- thumb -->
    <rect x="214" y="396" width="46" height="128" rx="23" fill="${c.black}" stroke="${c.cream}" stroke-width="2.5" transform="rotate(-8 237 460)"/>
    <path d="M226,424 V500" stroke="${c.cream}" stroke-width="2" opacity=".45" stroke-linecap="round" transform="rotate(-8 237 460)"/>
    <!-- palm base joining the fist to the cuff -->
    <path d="M238,510 H362 L366,552 H234 Z" fill="${c.black}" stroke="${c.cream}" stroke-width="2.5" stroke-linejoin="round"/>
  </g>`;

const defs = `
  <linearGradient id="wedge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.green}"/><stop offset="1" stop-color="${c.dgreen}"/></linearGradient>
  <radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></radialGradient>
  ${grain()}`;

const body = `
  <rect width="600" height="900" fill="${c.cream}"/>
  <g opacity=".32">${rays(300, 640, 44, 1000, c.brass, 2, 0.05)}</g>

  <!-- the bold diagonal band -->
  <path d="M0,230 L600,90 L600,560 L0,700 Z" fill="url(#wedge)"/>
  <path d="M0,230 L600,90 L600,112 L0,252 Z" fill="${c.black}"/>
  <path d="M0,678 L600,538 L600,560 L0,700 Z" fill="${c.black}"/>

  <!-- gears biting into the band -->
  <path d="${gear(-26, 500, 190, 160, 20)}" fill="${c.black}" stroke="${c.brass}" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="-26" cy="500" r="62" fill="${c.green}" stroke="${c.brass}" stroke-width="6"/>
  <path d="${gear(630, 280, 150, 126, 18)}" fill="${c.dgreen}" stroke="${c.brass}" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="630" cy="280" r="48" fill="${c.black}" stroke="${c.brass}" stroke-width="6"/>

  ${fist}

  <!-- banner across the top -->
  <g transform="rotate(-3 300 70)">
    <path d="M-20,34 H620 V108 H-20 Z" fill="${c.black}"/>
    <path d="M-20,34 H620" stroke="${c.brass}" stroke-width="5"/><path d="M-20,108 H620" stroke="${c.brass}" stroke-width="5"/>
    <text x="300" y="88" text-anchor="middle" ${FONT} font-size="38" fill="${c.cream}" textLength="520" lengthAdjust="spacingAndGlyphs">THE GEARWRIGHTS' LEAGUE</text>
  </g>
  
  <!-- slogan -->
  <text x="300" y="738" text-anchor="middle" ${FONT} font-size="46" fill="${c.black}" textLength="500" lengthAdjust="spacingAndGlyphs">HANDS THAT BUILD</text>
  <text x="300" y="812" text-anchor="middle" ${FONT} font-size="86" fill="${c.rust}" stroke="${c.black}" stroke-width="4" paint-order="stroke" textLength="500" lengthAdjust="spacingAndGlyphs">THE WORLD</text>
  <rect x="40" y="824" width="520" height="30" fill="${c.black}"/>
  <text x="300" y="845" text-anchor="middle" ${FONT} font-size="16" fill="${c.brassL}" textLength="480" lengthAdjust="spacingAndGlyphs" letter-spacing="2">WORKERS · ENGINEERS · GEARWRIGHTS</text>
  <text x="300" y="869" text-anchor="middle" ${FONT} font-size="11" fill="${c.black}" textLength="420" lengthAdjust="spacingAndGlyphs">THE ENGINES RUN ON US · COTTAGE CON · NOV 26–29</text>

  <rect x="14" y="14" width="572" height="872" fill="none" stroke="${c.black}" stroke-width="8"/>
  <rect x="26" y="26" width="548" height="848" fill="none" stroke="${c.brass}" stroke-width="2.5"/>
  <rect width="600" height="900" fill="url(#vig)"/>
  <rect width="600" height="900" filter="url(#grain)" opacity=".55" style="mix-blend-mode:multiply" pointer-events="none"/>`;

module.exports = svg({
  title: "The Gearwrights' League: Hands That Build the World",
  desc: "Steampunk propaganda poster for the Gearwrights' League: a raised fist gripping a spanner across a bold green band, in the style of a Constructivist workers' poster.",
  defs, body,
});
