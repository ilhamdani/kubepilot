// One-shot rebrand: Lens identifiers -> KubePilot.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) files.push(full);
  }
})(root);

const replacements = [
  [/'lens:/g, "'kubepilot:"],
  [/exposeInMainWorld\('lens'/g, "exposeInMainWorld('kube'"],
  [/window\.lens/g, 'window.kube'],
  [/LensApi/g, 'KubeApi'],
  [/lens: KubeApi/g, 'kube: KubeApi'],
  [/lens-dark/g, 'kubepilot-dark'],
  [/lens-light/g, 'kubepilot-light'],
];

let touched = 0;
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of replacements) after = after.replace(re, to);
  if (after !== before) {
    fs.writeFileSync(file, after);
    touched += 1;
    console.log('updated', path.relative(path.join(__dirname, '..'), file));
  }
}
console.log('files touched:', touched);
