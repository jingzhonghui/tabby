import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'

import { ConfigSyncBackend, SyncRemoteConfig, SyncConfigUpdate, SyncUser } from '../../api/configSyncBackend'
import { requestJson } from './http'

const CONFIG_FILE = 'tabby-config.yaml'
const META_FILE = 'tabby-meta.json'

interface GistFile {
    filename: string
    content?: string
    truncated?: boolean
    raw_url?: string
    size?: number
}

interface Gist {
    id: string
    description: string|null
    files?: Record<string, GistFile|undefined>
    public: boolean
    created_at: string
    updated_at: string
}

interface GistMeta {
    app?: string
    name?: string
    version?: string
}

/**
 * Stores the configuration in a code snippet (Gist) on GitHub or Gitee.
 *
 * The configuration lives in a single `tabby-config.yaml` file so that it stays
 * a plain, diff-friendly YAML document, while bookkeeping lives in
 * `tabby-meta.json`. The snippet is always created as non-public.
 */
abstract class AbstractGistSyncBackend extends ConfigSyncBackend {
    hostEditable = false
    publicReachable = true

    abstract apiBase: string

    constructor (
        protected platform: PlatformService,
        protected config: ConfigService,
    ) {
        super()
    }

    protected abstract authHeaders (): Record<string, string>

    async checkAuth (): Promise<SyncUser> {
        const user = await this.request('GET', '/user')
        return { name: user?.login ?? user?.name ?? 'unknown' }
    }

    async listConfigs (): Promise<SyncRemoteConfig[]> {
        const gists: Gist[]|undefined = await this.request('GET', '/gists?per_page=100')
        return (gists ?? [])
            .filter(gist => !!gist.files?.[CONFIG_FILE])
            .map(gist => ({
                id: gist.id,
                name: this.gistName(gist),
                // The list endpoint omits file contents on purpose.
                content: '',
                created_at: new Date(gist.created_at),
                modified_at: new Date(gist.updated_at),
                last_used_with_version: null,
            }))
    }

    async getConfig (id: string|number): Promise<SyncRemoteConfig> {
        const gist: Gist = await this.request('GET', `/gists/${id}`)
        const file = gist.files?.[CONFIG_FILE]
        if (!file) {
            throw new Error(`Gist ${id} does not contain ${CONFIG_FILE}`)
        }

        let content = file.content ?? ''
        if (file.truncated && file.raw_url) {
            // `raw_url` points at a different host, so the token must not be sent along.
            const raw = await this.platform.httpRequest({ url: file.raw_url, timeoutMs: 30000 })
            content = raw.body
        }

        const meta = this.parseMeta(gist.files?.[META_FILE]?.content)
        return {
            id: gist.id,
            name: this.gistName(gist, meta),
            content,
            created_at: new Date(gist.created_at),
            modified_at: new Date(gist.updated_at),
            last_used_with_version: meta?.version ?? null,
        }
    }

    async createConfig (name: string, content: string): Promise<SyncRemoteConfig> {
        const gist: Gist = await this.request('POST', '/gists', {
            description: name,
            'public': false,
            files: {
                [CONFIG_FILE]: { content: content || '# Tabby configuration\n' },
                [META_FILE]: { content: this.serializeMeta({ app: 'tabby', name }) },
            },
        })
        return this.mapGist(gist, name)
    }

    async updateConfig (id: string|number, update: SyncConfigUpdate): Promise<SyncRemoteConfig> {
        const files: Record<string, { content: string }> = {}
        if (update.content !== undefined) {
            files[CONFIG_FILE] = { content: update.content }
        }
        if (update.last_used_with_version !== undefined) {
            // Only the version is bookkeeping here: the config name lives in the
            // gist description, so this rewrite must not carry a stale copy of
            // it (an older version of this code stored it as `meta.name`).
            files[META_FILE] = {
                content: this.serializeMeta({ app: 'tabby', version: update.last_used_with_version }),
            }
        }

        const body: any = {}
        if (Object.keys(files).length) {
            body.files = files
        }
        if (update.name !== undefined) {
            body.description = update.name
        }

        if (!Object.keys(body).length) {
            return this.getConfig(id)
        }

        const gist: Gist = await this.request('PATCH', `/gists/${id}`, body)
        return this.mapGist(gist, update.name)
    }

    async deleteConfig (id: string|number): Promise<void> {
        await this.request('DELETE', `/gists/${id}`)
    }

    private gistName (gist: Gist, meta?: GistMeta|null): string {
        // The gist description is what the user sees and edits on the snippet
        // site, so it is the primary source of truth. `meta.name` is only a
        // fallback for snippets created before the description was used.
        const description = gist.description?.trim()
        if (description) {
            return description
        }
        const metaName = meta?.name?.trim()
        if (metaName) {
            return metaName
        }
        // Signals "no name" to the UI instead of exposing the raw gist id.
        return ''
    }

    private mapGist (gist: Gist, name?: string): SyncRemoteConfig {
        return {
            id: gist.id,
            name: name ?? this.gistName(gist),
            content: gist.files?.[CONFIG_FILE]?.content ?? '',
            created_at: new Date(gist.created_at),
            modified_at: new Date(gist.updated_at),
            last_used_with_version: null,
        }
    }

    private parseMeta (content?: string): GistMeta|null {
        if (!content) {
            return null
        }
        try {
            return JSON.parse(content)
        } catch {
            return null
        }
    }

    private serializeMeta (meta: GistMeta): string {
        return JSON.stringify(meta, null, 2)
    }

    protected async request (method: string, path: string, data?: any): Promise<any> {
        if (!this.config.store.configSync.token) {
            throw new Error('Access token is not configured')
        }
        return requestJson(this.platform, {
            url: this.apiBase + path,
            method,
            headers: {
                ...this.authHeaders(),
                Accept: 'application/json',
                ...data !== undefined ? { 'Content-Type': 'application/json' } : {},
            },
            body: data !== undefined ? JSON.stringify(data) : undefined,
        })
    }
}

@Injectable()
export class GitHubGistSyncBackend extends AbstractGistSyncBackend {
    id = 'github-gist'
    name = 'GitHub Gist'
    apiBase = 'https://api.github.com'
    tokenHelpUrl = 'https://github.com/settings/tokens'

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        platform: PlatformService,
        config: ConfigService,
    ) {
        super(platform, config)
    }

    protected authHeaders (): Record<string, string> {
        return {
            Authorization: `Bearer ${this.config.store.configSync.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        }
    }
}

@Injectable()
export class GiteeGistSyncBackend extends AbstractGistSyncBackend {
    id = 'gitee-gist'
    name = 'Gitee 代码片段'
    apiBase = 'https://gitee.com/api/v5'
    tokenHelpUrl = 'https://gitee.com/profile/personal_access_tokens'

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        platform: PlatformService,
        config: ConfigService,
    ) {
        super(platform, config)
    }

    protected authHeaders (): Record<string, string> {
        return {
            Authorization: `token ${this.config.store.configSync.token}`,
        }
    }
}
