import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || tag !== `v${pkg.version}`) {
  throw new Error(`Tag must match package version v${pkg.version}; received ${tag || '(none)'}`);
}
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error('package.json and package-lock.json versions must match');
}
const repository = process.env.GITHUB_REPOSITORY || 'wei0121/iSimBot-mcp';
if (repository !== 'wei0121/iSimBot-mcp') throw new Error('Unexpected release repository');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const heading = `## ${pkg.version}\n`;
const start = changelog.indexOf(heading);
if (start < 0) throw new Error(`Missing changelog entry for ${pkg.version}`);
const section = changelog.slice(start + heading.length).split('\n## ')[0].trim();
if (!section) throw new Error(`Empty changelog entry for ${pkg.version}`);
if (process.argv.includes('--check')) {
  console.log(`Release version verified: ${tag}`);
} else {
  execFileSync(process.execPath, [join(root, 'scripts/prepare-homebrew.mjs')], { cwd: root, stdio: 'inherit' });
  const output = join(root, 'homebrew/local');
  const archiveName = `${pkg.name}-${pkg.version}.tar.gz`;
  const sha = createHash('sha256').update(readFileSync(join(output, archiveName))).digest('hex');
  const url = `https://github.com/${repository}/releases/download/${tag}/${archiveName}`;
  const formula = readFileSync(join(root, 'homebrew/isimbot-mcp.rb.in'), 'utf8')
    .replace('# Local test formula. Regenerate with npm run brew:prepare; do not edit generated values.',
      '# Release asset includes compiled code. Update URL, version and SHA256 together.')
    .replace('@ARCHIVE_URL@', url).replace('@VERSION@', pkg.version).replace('@SHA256@', sha);
  writeFileSync(join(output, 'isimbot-mcp.rb'), formula);
  writeFileSync(join(output, 'SHA256SUMS'), `${sha}  ${archiveName}\n`);
  writeFileSync(join(output, 'release-notes.md'), `${section}\n\nSHA256: \`${sha}\`\n`);
  console.log(`Release assets ready for ${tag}. Copy the published isimbot-mcp.rb asset to the tap after publication.`);
}
