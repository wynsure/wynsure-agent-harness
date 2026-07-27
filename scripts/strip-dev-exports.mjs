import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const pkgUrl = new URL('../package.json', import.meta.url);
const backupUrl = new URL('../package.json.dev.bak', import.meta.url);

const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));

copyFileSync(pkgUrl, backupUrl);

const dotExport = pkg.exports?.['.'];
if (dotExport?.development) {
  delete dotExport.development;
  writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[prepack] stripped "development" export condition from package.json');
} else {
  console.log('[prepack] no "development" export condition found, nothing to strip');
}
