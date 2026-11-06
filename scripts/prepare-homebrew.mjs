import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'homebrew', 'local');
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, '.stage-'));
try {
  execFileSync('npm', ['run', 'build:observation'], { cwd: root, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const archive = join(output, `${pkg.name}-${pkg.version}.tar.gz`);
  const payload = join(stage, 'package');
  mkdirSync(payload);
  for (const name of ['dist', 'package.json', 'package-lock.json', 'README.md', 'doc', 'LICENSE', 'NOTICE']) {
    cpSync(join(root, name), join(payload, name), { recursive: true });
  }
  execFileSync('tar', ['-czf', archive, '-C', stage, 'package']);
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const template = readFileSync(join(root, 'homebrew', 'isimbot-mcp.rb.in'), 'utf8');
  const formula = template.replace('@ARCHIVE_URL@', pathToFileURL(archive).href)
    .replace('@VERSION@', pkg.version).replace('@SHA256@', sha);
  const target = join(root, 'homebrew', 'isimbot-mcp.rb');
  writeFileSync(target, formula);
  console.log(`Local archive: ${archive}\nSHA256: ${sha}\nFormula: ${target}`);
  console.log('No Homebrew packages or client configurations were installed or changed.');
} finally { rmSync(stage, { recursive: true, force: true }); }
