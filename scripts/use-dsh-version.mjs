// Repoint the DSH dev dependencies at another published version or dist-tag
// (used by the canary CI job): node scripts/use-dsh-version.mjs next
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const spec = process.argv[2]
if (!spec) { console.error('usage: node scripts/use-dsh-version.mjs <version|dist-tag>'); process.exit(2) }
const shell = process.platform === 'win32'
function npmView(field) {
  const result = spawnSync(shell ? 'npm.cmd' : 'npm', ['view', `@deepseek-ai/dsh-tools@${spec}`, field, '--json'], { encoding: 'utf8', shell })
  if (result.status !== 0) { console.error(`cannot resolve ${field} for @deepseek-ai/dsh-tools@${spec}: ${result.stderr}`); process.exit(1) }
  return JSON.parse(result.stdout)
}
const parsed = npmView('version')
const version = Array.isArray(parsed) ? parsed.at(-1) : parsed
const cordisRange = npmView('peerDependencies')['@deepseek-ai/cordis']
if (typeof cordisRange !== 'string') { console.error(`@deepseek-ai/dsh-tools@${version} does not declare a Cordis peer`); process.exit(1) }
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of Object.keys(manifest.devDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
manifest.devDependencies['@deepseek-ai/cordis'] = cordisRange
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(`DSH dev dependencies set to ${version}; Cordis set to ${cordisRange}. Next: npm install --no-package-lock && DITTO_DSH_VERSION=${version} npm test`)
