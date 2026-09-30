import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** This package's own version, read from package.json at runtime. */
export function dittoVersion(): string {
  return (require('../package.json') as { version: string }).version
}

/**
 * DSH releases Ditto is tested against. `supported` versions run the full CI
 * gate; `canary` versions run as a non-blocking job so an upstream breaking
 * change is noticed early. Keep docs/COMPATIBILITY.md in step with this table.
 */
export const COMPATIBILITY = {
  node: { minimum: 22, tested: [22, 24] },
  dsh: {
    supported: ['0.1.5-rc.3'],
    canary: ['0.1.7-alpha.2', '0.2.0-rc.2'],
    /** Ranges the plugin's peerDependencies accept. */
    peerRange: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '>=0.1.5-rc.1 <0.2.0' },
  },
  /** Host services Ditto uses: required at mount time, or optional and read at call time. */
  hostServices: { required: ['tools', 'skills'], optional: ['approval'] },
} as const

/** Whether a resolved DSH package version is one Ditto is tested against. */
export function dshSupportLevel(version: string): 'supported' | 'canary' | 'untested' {
  if ((COMPATIBILITY.dsh.supported as readonly string[]).includes(version)) return 'supported'
  if ((COMPATIBILITY.dsh.canary as readonly string[]).includes(version)) return 'canary'
  return 'untested'
}
