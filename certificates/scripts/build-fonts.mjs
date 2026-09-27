// Builds src/fonts.css with woff2 fonts embedded as base64 (latin, latin-ext, cyrillic only).
import fs from 'node:fs';
import path from 'node:path';
const sets = [
  ['montserrat', ['400', '600', '700']],
  ['playfair-display', ['400', '700']],
  ['great-vibes', ['400']],
  ['lora', ['400', '400-italic']],
];
const keep = /-(latin|latin-ext|cyrillic)-\d+-(normal|italic)\.woff2/;
let out = '/* Fonts: SIL Open Font License, via @fontsource */\n';
for (const [pkg, weights] of sets) {
  const dir = path.join('node_modules/@fontsource', pkg);
  for (const w of weights) {
    const css = fs.readFileSync(path.join(dir, `${w}.css`), 'utf8');
    for (const block of css.split('@font-face').slice(1)) {
      const m = block.match(/url\(\.\/files\/([^)]+\.woff2)\)/);
      if (!m || !keep.test(m[1])) continue;
      const data = fs.readFileSync(path.join(dir, 'files', m[1])).toString('base64');
      const body = block
        .replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${data}) format('woff2');`)
        .replace(/\/\*[^*]*\*\/\s*$/, '');
      out += `@font-face${body.trim()}\n`;
    }
  }
}
fs.writeFileSync('src/fonts.css', out);
console.log('fonts.css', (out.length / 1024).toFixed(0), 'KB');
