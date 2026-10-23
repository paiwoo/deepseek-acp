import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as ApiKeyProvider from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { createHarness } from './harness.js'
import { ensurePiAi } from '../src/composition/pi-ai.js'
import { realTempDir } from './temp-dir.js'
import { findSessionLog, readSessionLog } from './session-log.js'

describe('TC-UPGRADE-01 DSH 0.2 persistence and provider configuration', () => {
  it('commits a native v4 session before returning the prompt result', async () => {
    const root = realTempDir('dsacp-v4-')
    const h = await createHarness({ sessionsRoot: root })
    try {
      const session = await h.acp.request('session/new', { cwd: realTempDir('dsacp-ws-'), mcpServers: [] })
      h.llm.deltas = ['V4_DURABLE_MARKER']
      await h.acp.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
      const text = readSessionLog(root)!
      expect(JSON.parse(text.split('\n')[0]!).version).toBe(4)
      expect(text).toContain('V4_DURABLE_MARKER')
    } finally { await h.retire() }
  })

  it('restores configured routes on a fresh connection without a native profile', async () => {
    const home = realTempDir('dsacp-settings-reopen-')
    const h = await createHarness({ settings: home, launchEnvironment: {} })
    await h.acp.request('providers/set', {
      providerId: 'openai', apiType: 'openai-completions', baseUrl: 'https://fixture.invalid/v1',
    } as never)
    await h.retire()
    const reopened = await createHarness({ settings: home, launchEnvironment: {} })
    try {
      expect(reopened.ctx.llm.listProviders().map(route => route.id)).toContain('openai')
      const listed = await reopened.acp.request('providers/list', {} as never)
      expect(listed.providers).toContainEqual(expect.objectContaining({
        providerId: 'openai', current: { apiType: 'openai-completions', baseUrl: 'https://fixture.invalid/v1' },
      }))
    } finally { await reopened.retire() }
  })

  it('refuses invalid live settings without changing the document or active route', async () => {
    const home = realTempDir('dsacp-settings-invalid-')
    const h = await createHarness({ settings: home, launchEnvironment: {} })
    try {
      await h.acp.request('providers/set', {
        providerId: 'openai', apiType: 'openai-completions', baseUrl: 'https://fixture.invalid/v1',
      } as never)
      const before = readFileSync(join(home, 'settings.yaml'), 'utf8')
      await expect(h.ctx.acpSettings.update('llm-pi-ai', { providers: { openai: { api: 'invalid-protocol' } } })).rejects.toThrow()
      expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(before)
      expect(h.ctx.llm.listProviders().map(route => route.id)).toContain('openai')
    } finally { await h.retire() }
  })

  it('keeps the deployment-owned official provider read-only in ACP', async () => {
    const h = await createHarness({ settings: realTempDir('dsacp-settings-static-'), launchEnvironment: {} })
    try {
      await h.ctx.plugin(ApiKeyProvider, {})
      const listed = await h.acp.request('providers/list', {} as never)
      expect(listed.providers).toContainEqual(expect.objectContaining({ providerId: 'deepseek-official', required: true }))
      await expect(h.acp.request('providers/set', {
        providerId: 'deepseek-official', apiType: 'anthropic-messages', baseUrl: 'https://fixture.invalid',
      } as never)).rejects.toThrow(/not configurable/)
    } finally { await h.retire() }
  })

  it('loads the configurable catalog once for concurrent provider requests', async () => {
    const h = await createHarness()
    try {
      // Both callers can arrive before loader.create publishes the catalog.
      await Promise.all([ensurePiAi(h.ctx), ensurePiAi(h.ctx)])
      expect(h.ctx.llm.listConfigurableProviders().filter((p) => p.provider === 'openai')).toHaveLength(1)
    } finally { await h.retire() }
  })

  it('restores a released v3 log and preserves its source bytes while publishing v4', async () => {
    const root = realTempDir('dsacp-v3-upgrade-')
    const cwd = realTempDir('dsacp-v3-ws-')
    // Generated with unmodified dsh-session-persistence-jsonl@0.1.5-rc.1;
    // only the machine-specific cwd changes so workspace validation stays real.
    const source = readFileSync(new URL('./fixtures/upgrade-v3/session.v3.jsonl', import.meta.url), 'utf8')
      .replace('C:/fixture', cwd.replaceAll('\\', '/'))
    // Let the backend choose its project directory: user paths can contain
    // Unicode and platform separators that the storage codec escapes.
    const seed = await createHarness({ sessionsRoot: root })
    let project: string
    try {
      const session = await seed.acp.request('session/new', { cwd, mcpServers: [] })
      await seed.acp.request('session/prompt', {
        sessionId: session.sessionId, prompt: [{ type: 'text', text: 'seed path' }],
      })
      project = dirname(dirname(findSessionLog(root)!))
    } finally { await seed.retire() }
    const directory = join(project, 'upgrade-v3-fixture')
    mkdirSync(directory, { recursive: true })
    const legacy = join(directory, 'session.v3.jsonl')
    writeFileSync(legacy, source)
    const h = await createHarness({ sessionsRoot: root })
    try {
      const prepared = await h.ctx.sessionPersistence.open('upgrade-v3-fixture' as never, 'read')
      await prepared!.close()
      expect(existsSync(join(directory, 'session.v4.jsonl'))).toBe(false)
      await h.acp.request('session/load', { sessionId: 'upgrade-v3-fixture', cwd, mcpServers: [] })
      h.llm.deltas = ['MIGRATED_REPLY']
      await h.acp.request('session/prompt', {
        sessionId: 'upgrade-v3-fixture', prompt: [{ type: 'text', text: 'continue' }],
      })
      expect(h.llm.historiesUsed.at(-1)?.join('\n')).toContain('LEGACY_V3_MARKER')
      expect(readFileSync(legacy, 'utf8')).toBe(source)
      const current = readFileSync(join(directory, 'session.v4.jsonl'), 'utf8')
      expect(JSON.parse(current.split('\n')[0]!).version).toBe(4)
      expect(current).toContain('MIGRATED_REPLY')
    } finally { await h.retire() }
  })
})
