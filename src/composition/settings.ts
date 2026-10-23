/** ACP-owned legacy document; DSH 0.2 settings forms require a native profile. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service, resolveConfig } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import Schema from '@deepseek-ai/schemastery'
import { parse, stringify } from 'yaml'
import { redactSecrets } from '@deepseek-ai/dsh-settings'

type Document = Record<string, Record<string, unknown>>
type PathOp = { op: 'unset'; path: readonly string[] }
declare module '@deepseek-ai/cordis' {
  interface Context { acpSettings: AcpSettings }
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('ACP settings must be a mapping')
  return value as Record<string, unknown>
}
function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const child = record(target[key])
      target[key] = child
      merge(child, record(value))
    } else target[key] = structuredClone(value)
  }
}

/** Keep ACP provider edits out of the user's unrelated native DSH profile. */
export class AcpSettings extends Service {
  static inject = ['loader']
  static Config = Schema.object({ path: Schema.string() })
  readonly documentPath: string
  readonly writable = true
  constructor(ctx: Context, config: { path?: string } = {}) {
    super(ctx, 'acpSettings')
    this.documentPath = config.path ?? join(resolveDshHome(), 'settings.yaml')
  }
  private read(): Document {
    try { return record(parse(readFileSync(this.documentPath, 'utf8'))) as Document }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  section(ns: string): Record<string, unknown> { return structuredClone(this.read()[ns] ?? {}) }
  describe(_options: { redactSecrets: boolean }): { ns: string; value: unknown }[] {
    // Credentials are always stored by providers/set through ctx.credentials;
    // only a credential reference is admitted to this document by that path.
    return Object.entries(this.read()).flatMap(([ns, value]) => {
      if (ns !== 'llm-pi-ai') return []
      const entry = [...(this.ctx.get('loader')?.entries() ?? [])].find(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
      const schema = (entry?.moduleNamespace as { Config?: Schema<never> } | undefined)?.Config
      return schema === undefined ? [] : [{ ns, value: redactSecrets(schema, value).value }]
    })
  }
  private async edit(ns: string, change: (section: Record<string, unknown>) => void): Promise<void> {
    if (ns !== 'llm-pi-ai') throw new Error(`ACP settings namespace "${ns}" is not writable`)
    await withFileLock(this.documentPath, async () => {
      const document = this.read()
      const section = record(document[ns])
      document[ns] = section
      change(section)
      const loader = this.ctx.get('loader')
      if (loader === undefined) throw new Error('Provider loader is not available')
      const entry = [...loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
      // Let the upstream Config and serviceability hook reject the candidate
      // before either the document or the live model routes change.
      const fiber = entry?.fiber
      if (entry === undefined || fiber === undefined) throw new Error('Provider configuration is not loaded')
      const candidate = fiber.ctx.waterfall(fiber, 'internal/config', section, () => section)
      resolveConfig(fiber.runtime!, candidate)
      const before = structuredClone(entry.options.config ?? {})
      try {
        await loader.update(entry.id, { config: section })
        await loader.await()
        await writeFileAtomic(this.documentPath, stringify(document), { mode: 0o600 })
      } catch (error) {
        await loader.update(entry.id, { config: before })
        await loader.await()
        throw error
      }
    })
  }
  async update(ns: string, patch: object): Promise<void> {
    await this.edit(ns, section => merge(section, record(patch)))
  }
  async mutate(ns: string, ops: readonly PathOp[]): Promise<void> {
    await this.edit(ns, section => {
      for (const op of ops) {
        let node = section
        for (const segment of op.path.slice(0, -1)) node = record(node[segment])
        const key = op.path.at(-1)
        if (key !== undefined) delete node[key]
      }
    })
  }
}
