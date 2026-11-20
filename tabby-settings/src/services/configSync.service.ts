import * as yaml from 'js-yaml'
import { Inject, Injectable, Optional } from '@angular/core'
import { ConfigService, HostAppService, Logger, LogService, Platform, PlatformService } from 'tabby-core'

import { ConfigSyncBackend, SyncRemoteConfig } from '../api/configSyncBackend'

export type { ConfigSyncBackend, SyncRemoteConfig } from '../api/configSyncBackend'

const OPTIONAL_CONFIG_PARTS = ['hotkeys', 'appearance', 'vault']

export const DEFAULT_CONFIG_SYNC_BACKEND = 'tabby-web'

@Injectable({ providedIn: 'root' })
export class ConfigSyncService {
    private logger: Logger
    private lastRemoteChange = new Date(0)
    /** Set while a remote config is being written to the local one, to avoid echoing it straight back up. */
    private applyingRemote = false

    constructor (
        log: LogService,
        private platform: PlatformService,
        private hostApp: HostAppService,
        private config: ConfigService,
        @Optional() @Inject(ConfigSyncBackend) private backends: ConfigSyncBackend[] | null,
    ) {
        this.logger = log.create('configSync')
        config.ready$.toPromise().then(() => {
            this.autoSync()
            config.changed$.subscribe(() => {
                if (this.applyingRemote) {
                    return
                }
                if (this.isEnabled() && this.config.store.configSync.auto) {
                    this.upload()
                }
            })
        })
    }

    getBackends (): ConfigSyncBackend[] {
        return this.backends ?? []
    }

    /** The backend currently selected in the settings. */
    getBackend (): ConfigSyncBackend|null {
        const backends = this.getBackends()
        const selected = this.config.store.configSync.backend ?? DEFAULT_CONFIG_SYNC_BACKEND
        const matched = backends.find(x => x.id === selected)
        if (matched) {
            return matched
        }
        return backends.length ? backends[0] : null
    }

    isAvailable (): boolean {
        return this.hostApp.platform !== Platform.Web
    }

    isEnabled (): boolean {
        const backend = this.getBackend()
        if (!this.isAvailable() || !backend) {
            return false
        }
        if (!this.config.store.configSync.token) {
            return false
        }
        if (this.config.store.configSync.configID === null || this.config.store.configSync.configID === undefined) {
            return false
        }
        if (backend.hostEditable && !this.config.store.configSync.host) {
            return false
        }
        return true
    }

    async getConfigs (): Promise<SyncRemoteConfig[]> {
        return this.requireBackend().listConfigs()
    }

    async getConfig (id: string|number): Promise<SyncRemoteConfig> {
        return this.requireBackend().getConfig(id)
    }

    async updateConfig (id: string|number, data: Partial<SyncRemoteConfig>): Promise<SyncRemoteConfig> {
        return this.requireBackend().updateConfig(id, {
            name: data.name,
            content: data.content,
            last_used_with_version: data.last_used_with_version ?? undefined,
        })
    }

    async getUser (): Promise<{ name: string }> {
        return this.requireBackend().checkAuth()
    }

    async createNewConfig (name: string): Promise<SyncRemoteConfig> {
        return this.requireBackend().createConfig(name, '')
    }

    async deleteConfig (id: string|number): Promise<void> {
        return this.requireBackend().deleteConfig(id)
    }

    setConfig (config: SyncRemoteConfig): void {
        this.config.store.configSync.configID = config.id
        this.config.save()
        this.lastRemoteChange = new Date(config.modified_at)
    }

    async upload (): Promise<void> {
        if (!this.isEnabled()) {
            return
        }
        try {
            const data = await this.readConfigDataForSync()
            const remote = await this.getConfig(this.config.store.configSync.configID)
            const remoteData = (yaml.load(remote.content || '{}') ?? {}) as any
            for (const part of OPTIONAL_CONFIG_PARTS) {
                if (!this.config.store.configSync.parts[part]) {
                    data[part] = remoteData[part]
                }
            }
            const content = yaml.dump(data)
            const result = await this.updateConfig(this.config.store.configSync.configID, {
                content,
                last_used_with_version: this.platform.getAppVersion(),
            })
            this.lastRemoteChange = new Date(result.modified_at)
            this.logger.debug('Config uploaded')
        } catch (error) {
            this.logger.error('Upload failed:', error)
            throw error
        }
    }

    async download (): Promise<void> {
        if (!this.isEnabled()) {
            return
        }
        try {
            const config = await this.getConfig(this.config.store.configSync.configID)
            const data = (yaml.load(config.content || '{}') ?? {}) as any

            const localData = yaml.load(this.config.readRaw()) as any
            data.configSync = localData.configSync

            if (!data.encrypted) {
                for (const part of OPTIONAL_CONFIG_PARTS) {
                    if (!this.config.store.configSync.parts[part]) {
                        data[part] = localData[part]
                    }
                }
            }

            await this.writeConfigDataFromSync(data)
            this.lastRemoteChange = new Date(config.modified_at)
            this.logger.debug('Config downloaded')
        } catch (error) {
            this.logger.error('Download failed:', error)
            throw error
        }
    }

    async delete (config: SyncRemoteConfig): Promise<void> {
        try {
            await this.deleteConfig(config.id)
            this.logger.debug('Config deleted')
        } catch (error) {
            this.logger.error('Delete failed:', error)
            throw error
        }
    }

    private requireBackend (): ConfigSyncBackend {
        const backend = this.getBackend()
        if (!backend) {
            throw new Error('No config sync backend is available')
        }
        return backend
    }

    private async readConfigDataForSync (): Promise<any> {
        const data = yaml.load(await this.platform.loadConfig()) as any
        delete data.configSync
        return data
    }

    private async writeConfigDataFromSync (data: any) {
        // Applying a remote config saves it locally, which in turn emits
        // `changed$`. Without this guard the automatic upload would push the
        // freshly downloaded config straight back, bumping the remote timestamp
        // and making two syncing machines overwrite each other in a loop.
        this.applyingRemote = true
        try {
            await this.platform.saveConfig(yaml.dump(data))
            await this.config.load()
            await this.config.save()
        } finally {
            this.applyingRemote = false
        }
    }

    private async autoSync () {
        while (true) {
            try {
                if (this.isEnabled() && this.config.store.configSync.auto) {
                    const cfg = await this.getConfig(this.config.store.configSync.configID)
                    if (new Date(cfg.modified_at) > this.lastRemoteChange) {
                        this.logger.info('Remote config changed, downloading')
                        // download() records the remote timestamp itself so that
                        // a failed download is simply retried on the next tick.
                        await this.download()
                    }
                }
            } catch (error) {
                this.logger.debug('Recovering from autoSync network error')
            }
            await new Promise(resolve => setTimeout(resolve, 60000))
        }
    }
}
