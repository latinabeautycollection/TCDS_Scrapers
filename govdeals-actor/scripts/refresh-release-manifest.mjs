import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'release', 'RELEASE_MANIFEST.json');
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (absolute !== manifestPath) files.push(absolute);
  }
}

await walk(root);
files.sort();
const records = await Promise.all(files.map(async (absolute) => {
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
  const content = await readFile(absolute);
  return [relative, createHash('sha256').update(content).digest('hex')];
}));
const testFiles = records.filter(([name]) => name.startsWith('certification-tests/'));
const actor = JSON.parse(await readFile(path.join(root, '.actor', 'actor.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const staticReport = JSON.parse(await readFile(path.join(root, 'release', 'STATIC_CERTIFICATION_REPORT.json'), 'utf8'));
const manifest = {
  actor: actor.name,
  actor_version: actor.version,
  actor_build_tag: actor.buildTag,
  package_name: pkg.name,
  package_version: pkg.version,
  propertyroom_golden_baseline: true,
  files_sha256: Object.fromEntries(records),
  certification_tests_sha256: createHash('sha256').update(JSON.stringify(testFiles)).digest('hex'),
  certification_test_files: testFiles.map(([name]) => name),
  static_certification_status: staticReport.status,
  final_live_certification: 'PENDING_APIFY_RUNTIME_GATES',
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Manifest updated: ${records.length} files; static=${staticReport.status}`);