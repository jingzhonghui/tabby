import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'

import { ConfigSyncBackend, SyncRemoteConfig, SyncConfigUpdate, SyncUser } from '../../api/configSyncBackend'
import { requestJson } from './http'

interface TabbyWebConfig {
    id: number
    name: string
    content: string
    last_used_with_version: string|null
    created_at: string
    modified_at: string
}

/**
 * Syncs against a self-hosted instance of the Tabby Web service, which is what
 * Tabby used before the hosted service was retired.
 */
@Injectable({ providedIn: 'root' })
export class TabbyWebSyncBackend extends ConfigSyncBackend {
    id = 'tabby-web'
    name = 'Tabby Web'
    hostEditable = true

    constructor (
        private platform: PlatformService,
        private config: ConfigService,
    ) {
        super()
    }

    async checkAuth (): Promise<SyncUser> {
        const user = await this.request('GET', '/api/1/user')
        return { name: user?.login ?? user?.email ?? `#${user?.id ?? '?'}` }
    }

    async listConfigs (): Promise<SyncRemoteConfig[]> {
        const configs: TabbyWebConfig[] = await this.request('GET', '/api/1/configs')
        return configs.map(x => this.mapConfig(x))
    }

    async getConfig (id: string|number): Promise<SyncRemoteConfig> {
        return this.mapConfig(await this.request('GET', `/api/1/configs/${id}`))
    }

    async createConfig (name: string, content: string): Promise<SyncRemoteConfig> {
        return this.mapConfig(await this.request('POST', '/api/1/configs', {
            name,
            content,
        }))
    }

    async updateConfig (id: string|number, update: SyncConfigUpdate): Promise<SyncRemoteConfig> {
        return this.mapConfig(await this.request('PATCH', `/api/1/configs/${id}`, update))
    }

    async deleteConfig (id: string|number): Promise<void> {
        await this.request('DELETE', `/api/1/configs/${id}`)
    }

    private mapConfig (config: TabbyWebConfig): SyncRemoteConfig {
        return {
            id: config.id,
            name: config.name,
            content: config.content,
            created_at: new Date(config.created_at),
            modified_at: new Date(config.modified_at),
            last_used_with_version: config.last_used_with_version,
        }
    }

    private async request (method: string, url: string, data?: any): Promise<any> {
        if (!this.config.store.configSync.host) {
            throw new Error('Sync host is not configured')
        }
        let host: string = this.config.store.configSync.host
        if (host.endsWith('/')) {
            host = host.slice(0, -1)
        }
        // Refuse to sync configuration over a plaintext channel. The remote
        // payload is parsed as YAML and merged into the local config (including
        // profiles whose `command`/`env` are later executed by the terminal),
        // so a network attacker able to MITM cleartext HTTP could achieve
        // arbitrary command execution on the next sync. Require HTTPS.
        if (!/^https:\/\//i.test(host)) {
            throw new Error(`Config sync host must use HTTPS (got: ${host})`)
        }
        return requestJson(this.platform, {
            url: host + url,
            method,
            headers: {
                Authorization: `Bearer ${this.config.store.configSync.token}`,
                ...data !== undefined ? { 'Content-Type': 'application/json' } : {},
            },
            body: data !== undefined ? JSON.stringify(data) : undefined,
        })
    }
}
