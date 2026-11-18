import { defineTool } from '@deepseek-ai/dsh-tools'
import { runDoctor } from '../../doctor.js'
import { TOOL_NAMES } from '../catalog.js'
import type { DshDitto } from '../service.js'
import { checkNotAborted, json, jsonOutput } from './shared.js'

/** Inspect the current plugin instance without starting subprocesses or another host. */
export function diagnosticTools(service: DshDitto) {
  return [defineTool({
    name: 'ditto_doctor',
    description: 'Diagnose the active Ditto plugin: DSH component versions, workspace and state configuration, approval policy, and actual registered tools and skill. Runs no shell commands and applies no plans. A temporary state-writability probe is removed immediately. Use this when installation, compatibility, or batch configuration fails.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      checkNotAborted(exec.signal)
      const profile = service.host.get('profileContext') as { name?: string; home?: string } | undefined
      const report = await runDoctor({
        ...service.config, skipMount: true, skipCommands: true,
        ...(typeof profile?.name === 'string' ? { profile: profile.name } : {}),
        ...(typeof profile?.home === 'string' ? { env: { ...process.env, DSH_HOME: profile.home } } : {}),
      })
      const names = service.host.tools.schemas().map(tool => tool.name)
      const missing = TOOL_NAMES.filter(name => !names.includes(name))
      const skill = await service.host.skills.get('ditto')
      const missingApproval = service.config.approval === 'host' && !service.host.get('approval')
      report.checks.push(
        { status: missing.length ? 'fail' : 'ok', label: `${TOOL_NAMES.length - missing.length} of ${TOOL_NAMES.length} tools registered`, ...(missing.length ? { detail: `Missing: ${missing.join(', ')}` } : {}) },
        { status: skill ? 'ok' : 'fail', label: skill ? 'skill "ditto" registered' : 'skill "ditto" missing' },
        { status: missingApproval ? 'warn' : 'ok', label: `approval ${service.config.approval}`, ...(missingApproval ? { detail: 'The host approval service is unavailable; writes fail closed unless the profile explicitly enables agent fallback.' } : {}) },
      )
      report.ok = report.checks.every(check => check.status !== 'fail')
      checkNotAborted(exec.signal)
      return json(report)
    },
  })]
}
