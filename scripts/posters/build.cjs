// Regenerates public/posters/*.svg (the three faction propaganda posters). Run: node scripts/posters/build.cjs
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', '..', 'public', 'posters');
fs.mkdirSync(out, { recursive: true });
for (const name of ['admiralty', 'league', 'traders']) {
  fs.writeFileSync(path.join(out, `${name}.svg`), require(`./${name}.cjs`));
  console.log('wrote', `public/posters/${name}.svg`);
}
