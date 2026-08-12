import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// npm's registry can lag a successful publish by a few seconds — retry before
// declaring failure (pattern from cove-for-ynab's 0.2.0 release incident).
const ATTEMPTS = 8
const DELAY_MS = 10_000

function view(name, version) {
  try {
    return execSync(`npm view ${name}@${version} version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

for (const dir of ['packages/cove-fi']) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  let ok = false
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (view(pkg.name, pkg.version) === pkg.version) { ok = true; break }
    console.log(`attempt ${attempt}/${ATTEMPTS}: ${pkg.name}@${pkg.version} not visible yet — waiting ${DELAY_MS / 1000}s`)
    await sleep(DELAY_MS)
  }
  if (!ok) { console.error(`NOT PUBLISHED after ${ATTEMPTS} attempts: ${pkg.name}@${pkg.version}`); process.exit(1) }
  console.log(`ok: ${pkg.name}@${pkg.version}`)
}
