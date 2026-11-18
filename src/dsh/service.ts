import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import {
  applyPlan,
  createPlan,
  defaultRecipe,
  listRecipes,
  loadPlan,
  loadRecipe,
  recipeFromPlan,
  revisePlan,
  revisePlanRule,
  savePlan,
  saveRecipe,
  type ArchiveSpec,
  type Plan,
  type PlannedArtifact,
  type RuleRevision,
  type SidecarSpec,
  applySpecBatch,
  approveSpecSamples,
  createSpecBatch,
  countConfirmations,
  loadSpecBatch,
  reviseSpecBatch,
  saveSpecBatch,
  submitSpecDraft,
  type SpecBatch,
} from '../core/index.js'
import { canonicalPath, samePath } from '../core/paths.js'
import { contentHash, renderSidecarContent, reviewArtifact } from '../core/artifacts.js'
import { atomicWriteStateText, stateCategoryPath } from '../core/state-paths.js'
import { stableDigest } from '../core/recipe.js'
import { insideAnyRoot, insideWorkspace, overlaps, resolveConfig, type DshDittoConfig, type ResolvedConfig } from './config.js'
import { dittoSkill } from './skill.js'
import { fileTools } from './tools/files.js'
import { specTools } from './tools/spec.js'
import { diagnosticTools } from './tools/diagnostics.js'
import { withMutation } from './tools/shared.js'

export interface PlanView {
  plan: {
    id: string
    revision: number
    digest: string
    sourceRoot: string
    destinationRoot: string
    summary: Plan['summary']
    diagnostics: Plan['diagnostics']
    recipe: Pick<Plan['recipe'], 'id' | 'name' | 'version' | 'pattern' | 'classification'> & { match?: { regex: string; scope: 'basename' | 'relative-path'; flags: string } }
    artifacts: Array<Pick<PlannedArtifact, 'id' | 'kind' | 'destination' | 'bytes' | 'contentHash' | 'status'> & { reason?: string }>
    archive?: { kind: 'zip'; destination: string; status: 'ready' | 'applying' | 'applied' | 'failed'; contentHash?: string; bytes?: number; reason?: string }
  }
  items: Array<Pick<Plan['items'][number], 'id' | 'relativePath' | 'destination' | 'classification' | 'proposalDisposition' | 'exceptionCode' | 'exceptionDetails' | 'captures' | 'status' | 'reason'>>
  page: { offset: number; returned: number; total: number; nextOffset?: number }
}

export interface SpecBatchView {
  batch: {
    id: string
    revision: number
    digest: string
    sourceRoot: string
    outputRoot: string
    samples: string[]
    summary: SpecBatch['summary']
    instructions: string
    approvalRevision?: number
    approvedSampleCount: number
    discovery: SpecBatch['discovery']
  }
  items: Array<{
    id: string
    relativePath: string
    language: string
    outputPath: string
    status: string
    reason?: string
    evidenceCount: number
    hasDraft: boolean
    confirmations: number
  }>
  page: { offset: number; returned: number; total: number; nextOffset?: number }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshDitto: DshDitto
  }
}

/**
 * The Ditto plugin: one Cordis service that registers the Ditto skill and the
 * native tools on the host's public `skills` and `tools` services. Everything
 * it registers is a Cordis effect of this plugin's fiber, so unloading the
 * bundle (or reloading its patch layer) removes the skill and every tool.
 */
export class DshDitto extends Service<DshDittoConfig> {
  static inject = ['tools', 'skills']
  static provide = 'dshDitto'

  readonly config: ResolvedConfig
  /** The plugin's own context, exposed for the tool modules (host services such as `approval` are read from it at call time). */
  readonly host: Context
  private static readonly REVIEWS = 'reviews'

  constructor(ctx: Context, config: DshDittoConfig = {}) {
    super(ctx, 'dshDitto')
    this.host = ctx
    this.config = resolveConfig(config)
    ctx.skills.register(dittoSkill())
    for (const tool of [...fileTools(this), ...specTools(this), ...diagnosticTools(this)]) ctx.tools.register(tool)
  }

  // ---- File organisation ------------------------------------------------

  async preview(input: { sourceRoot: string; destinationRoot: string; recipeName?: string; pattern?: string; classification?: 'folder-prefix' | 'none'; sidecars?: SidecarSpec[]; archive?: ArchiveSpec; maxItems?: number }): Promise<Plan> {
    const roots = await this.checkedFileRoots(input.sourceRoot, input.destinationRoot)
    const requested = input.maxItems ?? this.config.maxItems
    if (!Number.isInteger(requested) || requested < 1 || requested > this.config.maxItems) throw new Error(`max_items must be an integer from 1 to ${this.config.maxItems}`)
    const recipe = defaultRecipe(input.recipeName ?? 'Default rule')
    if (input.pattern !== undefined) recipe.pattern = input.pattern
    if (input.classification !== undefined) recipe.classification = { kind: input.classification }
    if (input.sidecars !== undefined) recipe.sidecars = input.sidecars
    if (input.archive !== undefined) recipe.archive = input.archive
    const plan = await createPlan({ sourceRoot: roots.sourceRoot, destinationRoot: roots.destinationRoot, recipe, maxFiles: requested, excludedRoots: [this.config.stateRoot] })
    await savePlan(plan, this.config.stateRoot)
    return plan
  }

  async revise(planId: string, revision: number, edits: Array<{ id: string; destination: string }>): Promise<Plan> {
    return withMutation(this.config.stateRoot, planId, async () => {
      const plan = await loadPlan(planId, this.config.stateRoot)
      await this.checkedPersistedPlanRoots(plan)
      if (!Number.isInteger(revision) || revision !== plan.revision) throw new Error('The plan changed after review; call ditto_status for its current revision before revising')
      const next = revisePlan(plan, edits)
      await savePlan(next, this.config.stateRoot)
      return next
    })
  }

  async reviseRule(planId: string, revision: number, rule: RuleRevision): Promise<Plan> {
    return withMutation(this.config.stateRoot, planId, async () => {
      const plan = await loadPlan(planId, this.config.stateRoot)
      await this.checkedPersistedPlanRoots(plan)
      if (!Number.isInteger(revision) || revision !== plan.revision) throw new Error('The plan changed after review; call ditto_status for its current revision before revising the rule')
      const next = revisePlanRule(plan, rule)
      await savePlan(next, this.config.stateRoot)
      return next
    })
  }

  async reviewApply(planId: string, revision: number, digest: string): Promise<Plan> {
    return this.loadForReview(planId, revision, digest)
  }

  async apply(planId: string, revision: number, digest: string): Promise<Awaited<ReturnType<typeof applyPlan>>> {
    const plan = await loadPlan(planId, this.config.stateRoot)
    await this.checkedPersistedPlanRoots(plan)
    return applyPlan(plan, { id: planId, revision, digest }, this.config.stateRoot)
  }

  async status(planId: string): Promise<Plan> {
    const plan = await loadPlan(planId, this.config.stateRoot)
    await this.checkedPersistedPlanRoots(plan)
    return plan
  }

  /**
   * Materialise the complete reviewed mapping as a downloadable document under
   * stateRoot. It requires the exact current identity so an exported file can
   * never be mistaken for a newer review, and it writes nothing into the output
   * folder.
   */
  async manifest(planId: string, revision: number, digest: string, format: 'csv' | 'json' | 'markdown' = 'csv'): Promise<{ path: string; format: string; bytes: number; sha256: string; rows: number; planId: string; revision: number }> {
    const plan = await this.status(planId)
    if (!Number.isInteger(revision) || plan.revision !== revision || plan.digest !== digest) throw new Error('The plan changed after review; call ditto_status and export the manifest for its current revision and digest')
    if (!['csv', 'json', 'markdown'].includes(format)) throw new Error("format must be 'csv', 'json', or 'markdown'")
    const spec = { kind: 'manifest' as const, destination: `review.${format === 'markdown' ? 'md' : format}`, format }
    const content = renderSidecarContent(spec, { planId: plan.id, revision: plan.revision, sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, items: plan.items })
    const leaf = `${plan.id}.r${plan.revision}.${format === 'markdown' ? 'md' : format}`
    await atomicWriteStateText(this.config.stateRoot, DshDitto.REVIEWS, leaf, content)
    const path = resolve(await stateCategoryPath(this.config.stateRoot, DshDitto.REVIEWS, true), leaf)
    return { path, format, bytes: Buffer.byteLength(content, 'utf8'), sha256: contentHash(content), rows: plan.items.length, planId: plan.id, revision: plan.revision }
  }

  /** Render one reviewed sidecar's exact bytes, bounded, for the user to read before apply. */
  async artifactReview(planId: string, revision: number, digest: string, artifactId: string, offset = 0, limit = 4_000): Promise<{ artifact: { id: string; kind: string; destination: string; bytes: number; contentHash: string; status: string }; page: { offset: number; returned: number; total: number; nextOffset?: number }; content: string }> {
    const plan = await this.loadForReview(planId, revision, digest)
    const artifact = (plan.artifacts ?? []).find(candidate => candidate.id === artifactId)
    if (!artifact) throw new Error('Unknown sidecar id for this plan revision')
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    if (!Number.isInteger(limit) || limit < 1 || limit > 8_000) throw new Error('limit must be an integer from 1 to 8000')
    const content = reviewArtifact(artifact, { planId: plan.id, revision: plan.revision, sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, items: plan.items }, plan.recipe.sidecars)
    const page = content.slice(offset, offset + limit)
    return {
      artifact: { id: artifact.id, kind: artifact.kind, destination: artifact.destination, bytes: artifact.bytes, contentHash: artifact.contentHash, status: artifact.status },
      page: { offset, returned: page.length, total: content.length, ...(offset + page.length < content.length ? { nextOffset: offset + page.length } : {}) },
      content: page,
    }
  }

  private async loadForReview(planId: string, revision: number, digest: string): Promise<Plan> {
    const plan = await this.status(planId)
    if (!Number.isInteger(revision) || plan.revision !== revision || plan.digest !== digest) throw new Error('The plan changed after review; call ditto_status and retry with its current revision and digest')
    return plan
  }

  async saveRecipe(planId: string, name: string) {
    return withMutation(this.config.stateRoot, planId, async () => {
      const plan = await this.status(planId)
      const recipe = recipeFromPlan(plan, name)
      await saveRecipe(recipe, this.config.stateRoot)
      return recipe
    })
  }

  async getRecipe(recipeId: string) { return loadRecipe(recipeId, this.config.stateRoot) }
  async recipes() { return listRecipes(this.config.stateRoot) }

  // ---- Code to Spec -----------------------------------------------------

  /**
   * Ditto deliberately does not call `ctx.llm`. The host controls model
   * routing and approvals, so the agent obtains bounded evidence, generates a
   * JSON draft, and submits it for deterministic validation.
   */
  async createSpec(input: { sourceRoot: string; outputRoot: string; instructions?: string }): Promise<SpecBatch> {
    const roots = await this.checkedRoots(input.sourceRoot, input.outputRoot)
    const batch = await createSpecBatch({ sourceRoot: roots.sourceRoot, outputRoot: roots.destinationRoot, stateRoot: this.config.stateRoot, instructions: input.instructions })
    await saveSpecBatch(batch, this.config.stateRoot)
    return batch
  }

  async specStatus(batchId: string): Promise<SpecBatch> {
    const batch = await loadSpecBatch(batchId, this.config.stateRoot)
    await this.checkedPersistedSpecRoots(batch)
    return batch
  }

  async submitSpec(batchId: string, revision: number, digest: string, moduleId: string, draft: unknown, metadata?: Record<string, string>): Promise<SpecBatch> {
    return withMutation(this.config.stateRoot, `spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      const next = submitSpecDraft(batch, { moduleId, draft, metadata, generatorId: 'dsh-agent-driven' })
      await saveSpecBatch(next, this.config.stateRoot)
      return next
    })
  }

  async approveSpec(batchId: string, revision: number, digest: string): Promise<SpecBatch> {
    return withMutation(this.config.stateRoot, `spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      const next = approveSpecSamples(batch)
      await saveSpecBatch(next, this.config.stateRoot)
      return next
    })
  }

  async reviseSpec(batchId: string, revision: number, digest: string, input: { sampleEdits?: Array<{ moduleId: string; markdown: string }>; instructions?: string }): Promise<SpecBatch> {
    return withMutation(this.config.stateRoot, `spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      const next = reviseSpecBatch(batch, input)
      await saveSpecBatch(next, this.config.stateRoot)
      return next
    })
  }

  async reviewSpecApply(batchId: string, revision: number, digest: string): Promise<SpecBatch> {
    const batch = await this.specStatus(batchId)
    assertSpecIdentity(batch, revision, digest)
    return batch
  }

  async applySpec(batchId: string, revision: number, digest: string) {
    return withMutation(this.config.stateRoot, `spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      return applySpecBatch(batch, { id: batchId, revision, digest }, this.config.stateRoot)
    })
  }

  // ---- Bounded views ----------------------------------------------------

  view(plan: Plan, offset = 0, limit = this.config.resultItems): PlanView {
    this.checkPage(offset, limit)
    const items = plan.items.slice(offset, offset + limit).map(item => ({
      id: item.id,
      relativePath: item.relativePath,
      destination: item.destination,
      classification: item.classification,
      proposalDisposition: item.proposalDisposition,
      ...(item.exceptionCode === undefined ? {} : { exceptionCode: item.exceptionCode }),
      ...(item.exceptionDetails === undefined ? {} : { exceptionDetails: item.exceptionDetails }),
      ...(item.captures === undefined ? {} : { captures: item.captures }),
      status: item.status,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    }))
    return {
      plan: {
        id: plan.id,
        revision: plan.revision,
        digest: plan.digest,
        sourceRoot: plan.sourceRoot,
        destinationRoot: plan.destinationRoot,
        summary: plan.summary,
        diagnostics: plan.diagnostics,
        recipe: { id: plan.recipe.id, name: plan.recipe.name, version: plan.recipe.version, pattern: plan.recipe.pattern, classification: plan.recipe.classification, ...(plan.recipe.version === 2 && plan.recipe.match ? { match: plan.recipe.match } : {}) },
        artifacts: (plan.artifacts ?? []).map(artifact => ({ id: artifact.id, kind: artifact.kind, destination: artifact.destination, bytes: artifact.bytes, contentHash: artifact.contentHash, status: artifact.status, ...(artifact.reason === undefined ? {} : { reason: artifact.reason }) })),
        ...(plan.archive === undefined ? {} : { archive: { ...plan.archive, ...(plan.archiveState ?? { status: 'ready' as const }) } }),
      },
      items,
      page: { offset, returned: items.length, total: plan.items.length, ...(offset + items.length < plan.items.length ? { nextOffset: offset + items.length } : {}) },
    }
  }

  specView(batch: SpecBatch, offset = 0, limit = this.config.resultItems): SpecBatchView {
    this.checkPage(offset, limit)
    const items = batch.items.slice(offset, offset + limit).map(item => ({
      id: item.id, relativePath: item.relativePath, language: item.language, outputPath: item.outputPath, status: item.status,
      ...(item.reason === undefined ? {} : { reason: item.reason }), evidenceCount: item.evidence.length, hasDraft: Boolean(item.draft),
      confirmations: countConfirmations(item.approvedMarkdown ?? item.renderedMarkdown),
    }))
    return {
      batch: {
        id: batch.id, revision: batch.revision, digest: batch.digest, sourceRoot: batch.sourceRoot, outputRoot: batch.outputRoot,
        samples: batch.samples, summary: batch.summary, instructions: batch.recipe.instructions,
        ...(batch.recipe.approvalRevision === undefined ? {} : { approvalRevision: batch.recipe.approvalRevision }),
        approvedSampleCount: batch.recipe.approvedSamples.length,
        discovery: batch.discovery,
      },
      items,
      page: { offset, returned: items.length, total: batch.items.length, ...(offset + items.length < batch.items.length ? { nextOffset: offset + items.length } : {}) },
    }
  }

  checkPage(offset: number, limit: number): void {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.resultItems) throw new Error(`limit must be an integer from 1 to ${this.config.resultItems}`)
  }

  /** Code-to-Spec stays strictly inside workspaceRoot; the file allowlists never widen it. */
  private async checkedRoots(sourceInput: string, destinationInput: string): Promise<{ sourceRoot: string; destinationRoot: string }> {
    if (typeof sourceInput !== 'string' || typeof destinationInput !== 'string') throw new Error('Source and destination folders are required')
    const sourceRoot = await realpath(resolve(this.config.workspaceRoot, sourceInput))
    const destinationRoot = await canonicalPath(resolve(this.config.workspaceRoot, destinationInput))
    if (!insideWorkspace(this.config.workspaceRoot, sourceRoot) || !insideWorkspace(this.config.workspaceRoot, destinationRoot)) throw new Error(`Folders must stay inside the Ditto workspace (${this.config.workspaceRoot})`)
    if (overlaps(destinationRoot, this.config.stateRoot)) throw new Error('The output folder must not include Ditto state metadata; choose a separate output folder')
    return { sourceRoot, destinationRoot }
  }

  /**
   * File-organisation roots. A relative path is always anchored to the
   * workspace and may not escape into an external allowlisted root; an
   * external root is only reachable with an absolute path, and only when the
   * profile owner listed it for that exact role.
   */
  private async checkedFileRoots(sourceInput: string, destinationInput: string): Promise<{ sourceRoot: string; destinationRoot: string }> {
    if (typeof sourceInput !== 'string' || typeof destinationInput !== 'string' || sourceInput.trim() === '' || destinationInput.trim() === '') throw new Error('Source and destination folders are required')
    const sourceRoot = await this.resolveRoleRoot(sourceInput, this.config.allowedSourceRoots, 'source')
    const destinationRoot = await this.resolveRoleRoot(destinationInput, this.config.allowedDestinationRoots, 'destination')
    assertSeparateTrees(sourceRoot, destinationRoot)
    if (overlaps(destinationRoot, this.config.stateRoot)) throw new Error('The output folder must not overlap Ditto state metadata; choose a separate output folder')
    if (insideWorkspace(this.config.stateRoot, sourceRoot)) throw new Error('The source folder must not live inside Ditto state metadata')
    return { sourceRoot, destinationRoot }
  }

  private async resolveRoleRoot(input: string, allowlist: readonly string[], role: 'source' | 'destination'): Promise<string> {
    const absolute = isAbsolute(input)
    const target = absolute ? await canonicalPath(input) : await canonicalPath(resolve(this.config.workspaceRoot, input))
    if (!absolute && !insideWorkspace(this.config.workspaceRoot, target)) throw new Error(`A relative ${role} folder cannot leave the Ditto workspace (${this.config.workspaceRoot})`)
    if (!insideAnyRoot(allowlist, target)) {
      throw new Error(`The ${role} folder is not authorised for Ditto because it is not inside the Ditto workspace (${this.config.workspaceRoot}) or any configured allowed${role === 'source' ? 'Source' : 'Destination'}Roots entry. Add it to allowed${role === 'source' ? 'Source' : 'Destination'}Roots in the Ditto profile configuration. Authorised roots: ${allowlist.join(', ')}`)
    }
    return target
  }

  private async checkedPersistedPlanRoots(plan: Plan): Promise<void> {
    const sourceRoot = await canonicalPath(plan.sourceRoot)
    const destinationRoot = await canonicalPath(plan.destinationRoot)
    if (!samePath(sourceRoot, plan.sourceRoot) || !samePath(destinationRoot, plan.destinationRoot)) throw new Error('The saved plan roots changed on disk after review; run ditto_preview again')
    if (!insideAnyRoot(this.config.allowedSourceRoots, sourceRoot) || !insideAnyRoot(this.config.allowedDestinationRoots, destinationRoot)) throw new Error('The saved plan roots are no longer authorised; update the Ditto profile configuration or run ditto_preview again')
    if (overlaps(destinationRoot, this.config.stateRoot) || insideWorkspace(this.config.stateRoot, sourceRoot)) throw new Error('The saved plan roots now overlap Ditto state metadata')
  }

  private async checkedPersistedSpecRoots(batch: SpecBatch): Promise<void> {
    const sourceRoot = await realpath(batch.sourceRoot)
    if (sourceRoot !== batch.sourceRoot || !insideWorkspace(this.config.workspaceRoot, sourceRoot) || !insideWorkspace(this.config.workspaceRoot, resolve(batch.outputRoot)) || overlaps(batch.outputRoot, this.config.stateRoot)) throw new Error('The saved specification batch roots are outside the Ditto workspace')
  }
}

export function assertSpecIdentity(batch: SpecBatch, revision: number, digest: string): void {
  if (!Number.isInteger(revision) || batch.revision !== revision || typeof digest !== 'string' || batch.digest !== digest) throw new Error('The specification batch changed after review; call ditto_spec_status and retry with its current revision and digest')
}

/** Source and destination must be disjoint in both directions, at any depth. */
export function assertSeparateTrees(sourceRoot: string, destinationRoot: string): void {
  if (overlaps(sourceRoot, destinationRoot)) throw new Error('The output folder must be separate from and outside the source folder')
}
