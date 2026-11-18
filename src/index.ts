/**
 * Library entry. The DSH plugin lives at `dsh-ditto/dsh`; this root export
 * exposes the deterministic core (planning, evidence, validation, rendering,
 * apply) plus the demo, doctor, and compatibility helpers.
 */
export * from './core/index.js'
export * from './dsh/index.js'
export { COMPATIBILITY, dittoVersion, dshSupportLevel, isSupportedNodeVersion } from './compat.js'
export { DEMO_MODULES, demoGenerator, runHeadlessDemo, writeDemoRepository, type HeadlessDemoResult } from './demo.js'
export { renderDoctorReport, runDoctor, type DoctorCheck, type DoctorOptions, type DoctorReport } from './doctor.js'
export { startLocalWorkbench, startSpecWorkbench, specView, type LocalWorkbench, type LocalWorkbenchOptions, type SpecWorkbenchServerOptions } from './server.js'
