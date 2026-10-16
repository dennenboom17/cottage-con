// Small SVG toolkit for the three faction posters (600 x 900).
const r2 = (n) => Math.round(n * 100) / 100;

// A gear outline as a closed polygon path.
function gear(cx, cy, ro, ri, teeth, inner = 0.3, outer = 0.18) {
  const step = (2 * Math.PI) / teeth;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    for (const [da, rad] of [[-step * inner, ri], [-step * outer, ro], [step * outer, ro], [step * inner, ri]]) {
      pts.push([cx + Math.cos(a + da) * rad, cy + Math.sin(a + da) * rad]);
    }
  }
  return 'M' + pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' L') + ' Z';
}

// A sunburst of thin wedges around (cx, cy).
function rays(cx, cy, count, radius, fill, every = 2, offset = 0) {
  const step = (2 * Math.PI) / count;
  let out = '';
  for (let i = 0; i < count; i += every) {
    const a0 = offset + i * step, a1 = offset + (i + 1) * step;
    out += `<path d="M${cx},${cy} L${r2(cx + Math.cos(a0) * radius)},${r2(cy + Math.sin(a0) * radius)} L${r2(cx + Math.cos(a1) * radius)},${r2(cy + Math.sin(a1) * radius)} Z" fill="${fill}"/>`;
  }
  return out;
}

// Circular text path (id) of radius r. dir "top" reads over the top, "bottom" along the bottom, both upright.
function arcPath(id, cx, cy, r, dir) {
  const sweep = dir === 'top' ? 1 : 0;
  return `<path id="${id}" fill="none" d="M${cx - r},${cy} a${r},${r} 0 1,${sweep} ${2 * r},0 a${r},${r} 0 1,${sweep} ${-2 * r},0"/>`;
}

function rivets(points, r, fill, stroke) {
  return points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`).join('');
}

// A small airship, centred on (x, y), facing right, scaled by s.
function airship(x, y, s, c) {
  const seams = [-90, -62, -34, -6, 22, 50, 78].map((dx) => `<path d="M${dx},${-Math.sqrt(Math.max(0, 1 - (dx / 130) ** 2)) * 46} Q${dx * 1.08},0 ${dx},${Math.sqrt(Math.max(0, 1 - (dx / 130) ** 2)) * 46}" stroke="${c.seam}" stroke-width="1.6" fill="none"/>`).join('');
  return `<g transform="translate(${x},${y}) scale(${s})">
    <path d="M-124,-8 L-168,-44 L-150,-6 L-168,34 L-124,12 Z" fill="${c.fin}" stroke="${c.line}" stroke-width="2.4" stroke-linejoin="round"/>
    <ellipse cx="0" cy="0" rx="130" ry="46" fill="${c.body}" stroke="${c.line}" stroke-width="3"/>
    <clipPath id="env${Math.round(x)}${Math.round(y)}"><ellipse cx="0" cy="0" rx="130" ry="46"/></clipPath>
    <g clip-path="url(#env${Math.round(x)}${Math.round(y)})">${seams}<rect x="-130" y="-6" width="260" height="12" fill="${c.band}" opacity=".9"/><ellipse cx="-28" cy="-24" rx="70" ry="12" fill="#fff" opacity=".13"/></g>
    <path d="M-60,40 L-70,62 M60,40 L70,62 M-20,45 L-24,62 M20,45 L24,62" stroke="${c.line}" stroke-width="2" fill="none"/>
    <rect x="-82" y="60" width="164" height="26" rx="8" fill="${c.gondola}" stroke="${c.line}" stroke-width="3"/>
    <g fill="${c.window}">${[-62, -40, -18, 4, 26, 48].map((wx) => `<rect x="${wx}" y="66" width="12" height="11" rx="3"/>`).join('')}</g>
    <circle cx="134" cy="12" r="6" fill="${c.line}"/><g stroke="${c.line}" stroke-width="3" stroke-linecap="round"><path d="M134,-8 L134,32"/><path d="M122,12 L146,12"/></g>
    <path d="M0,-46 L0,-66" stroke="${c.line}" stroke-width="2.4"/><path d="M0,-66 L24,-60 L0,-54 Z" fill="${c.flag}" stroke="${c.line}" stroke-width="1.5"/>
  </g>`;
}

const frame = (c, w = 600, h = 900) => `
  <rect x="14" y="14" width="${w - 28}" height="${h - 28}" fill="none" stroke="${c.gold}" stroke-width="7"/>
  <rect x="28" y="28" width="${w - 56}" height="${h - 56}" fill="none" stroke="${c.gold}" stroke-width="1.6"/>
  ${[[28, 28], [w - 28, 28], [28, h - 28], [w - 28, h - 28]].map(([x, y]) => `<g><path d="${gear(x, y, 21, 15, 10)}" fill="${c.gold}" stroke="${c.edge}" stroke-width="1.4"/><circle cx="${x}" cy="${y}" r="6" fill="${c.edge}"/></g>`).join('')}`;

const grain = (id = 'grain') => `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0.22"/></feComponentTransfer></filter>`;

const svg = ({ title, desc, defs, body }) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900" role="img" aria-labelledby="t d">
<title id="t">${title}</title>
<desc id="d">${desc}</desc>
<defs>${defs}</defs>
${body}
</svg>
`;

module.exports = { r2, gear, rays, arcPath, rivets, airship, frame, grain, svg };
