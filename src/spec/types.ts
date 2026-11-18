import type { LanguageAdapter } from './languages/types.js'

/** Ditto's persisted, non-executable code-to-specification batch format. */
export type SpecItemStatus = 'pending' | 'sample-ready' | 'approved' | 'ready' | 'applied' | 'needs-review' | 'rejected' | 'failed'

export interface EvidenceChunk {
  id: string
  relativePath: string
  startLine: number
  endLine: number
  contentHash: string
  text: string
}

export interface StructuralFacts {
  exports: string[]
  imports: string[]
  lineCount: number
}

export interface CitedText { text: string; citations: string[] }
export interface PublicApiFact extends CitedText { kind: 'function' | 'class' | 'type' | 'value'; name: string; parameters?: string[] }
/** A question, never an unsupported statement. Evidence is optional context, not proof of an answer. */
export interface Confirmation { question: string; relatedEvidenceIds?: string[] }

/** This is the only accepted generator response shape. Paths and executable content are intentionally absent. */
export interface SpecDraft {
  version: 1
  moduleId: string
  title?: CitedText
  purpose?: CitedText
  responsibilities?: CitedText[]
  publicApi?: PublicApiFact[]
  dependencies?: CitedText[]
  errors?: CitedText[]
  confirmations?: Confirmation[]
}

export interface SpecModule {
  id: string
  source: string
  relativePath: string
  /** Language adapter id that claimed this module. */
  language: string
  sourceHash: string
  outputPath: string
  evidence: EvidenceChunk[]
  facts: StructuralFacts
  status: SpecItemStatus
  reason?: string
  draft?: SpecDraft
  renderedMarkdown?: string
  renderedHash?: string
  approvedMarkdown?: string
  generation?: { generatorId: string; sourceHash: string; recipeDigest: string; cached: boolean; metadata?: Record<string, string> }
}

export interface SpecRecipe {
  version: 1
  instructions: string
  approvedSamples: Array<{ moduleId: string; markdown: string }>
  /** Set only by the explicit approval transition; it binds examples to this revision. */
  approvalRevision?: number
  /** Reviewed style examples; these never approve the new batch or supply its evidence. */
  guidance?: SpecGuidance
}

export interface SpecGuidance { id: string; name: string; digest: string; examples: Array<{ moduleId: string; markdown: string }> }

export interface SpecBatchSummary { total: number; pending: number; sampleReady: number; approved: number; ready: number; applied: number; needsReview: number; rejected: number; failed: number }
export interface SpecExclusion { relativePath: string; reason: 'ignored-folder' | 'state-folder' | 'non-code' | 'declaration-file' | 'generated' | 'too-large' | 'symlink' }
export interface SpecDiscovery { inScope: number; excludedTotal: number; excludedByReason: Record<SpecExclusion['reason'], number>; excluded: SpecExclusion[] }

export interface SpecBatch {
  version: 'm1'
  id: string
  revision: number
  digest: string
  createdAt: string
  /** Dependency/environment identity captured for conservative cross-batch reuse. */
  environmentHash?: string
  sourceRoot: string
  outputRoot: string
  recipe: SpecRecipe
  discovery: SpecDiscovery
  samples: string[]
  items: SpecModule[]
  summary: SpecBatchSummary
}

/** Smallest batch that still has something to "ditto": three samples plus at least one remaining module. */
export const MIN_SPEC_MODULES = 4
/** Upper bound for one reviewed batch. Larger repositories are processed as several batches. */
export const MAX_SPEC_MODULES = 50

export interface CreateSpecBatchOptions {
  sourceRoot: string
  outputRoot: string
  stateRoot?: string
  instructions?: string
  environmentHash?: string
  guidance?: SpecGuidance
  minModules?: number
  maxModules?: number
  /** Language adapters to discover with; defaults to the adapters shipped with Ditto. */
  adapters?: readonly LanguageAdapter[]
}

export interface SpecGenerationRequest {
  module: Pick<SpecModule, 'id' | 'relativePath' | 'language' | 'sourceHash' | 'evidence' | 'facts'>
  instructions: string
  approvedSamples: Array<{ moduleId: string; markdown: string }>
}
export interface SpecGenerationResponse { draft: SpecDraft; metadata?: Record<string, string> }
export interface SpecGenerator { id: string; generate(request: SpecGenerationRequest): Promise<SpecGenerationResponse> }
export interface GenerateSpecOptions { only?: 'samples' | 'remaining'; stateRoot?: string }
export interface SpecSampleEdit { moduleId: string; markdown: string }
export interface SpecBatchEdit { sampleEdits?: SpecSampleEdit[]; instructions?: string }
export interface SpecApplyExpectation { id: string; revision: number; digest: string }
export interface SpecApplyResult { batchId: string; revision: number; digest: string; items: SpecModule[]; summary: SpecBatchSummary }
