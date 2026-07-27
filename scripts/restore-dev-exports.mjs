import { existsSync, rmSync, copyFileSync } from 'node:fs';

const pkgUrl = new URL('../package.json', import.meta.url);
const backupUrl = new URL('../package.json.dev.bak', import.meta.url);

if (existsSync(backupUrl)) {
  copyFileSync(backupUrl, pkgUrl);
  rmSync(backupUrl);
  console.log('[postpack] restored package.json (with "development" export condition) from backup');
} else {
  console.log('[postpack] no backup found, nothing to restore');
}
