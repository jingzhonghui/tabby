/**
 * A remote configuration store.
 *
 * Backends are registered as multi providers on `ConfigSyncBackend`, and the
 * backend selected in `config.configSync.backend` is used by `ConfigSyncService`.
 */

/** A configuration stored on the remote side. */
export interface SyncRemoteConfig {
    id: string|number
    name: string
    /** Serialized YAML configuration. May be empty when returned by `listConfigs()` for backends that omit it. */
    content: string
    created_at: Date
    modified_at: Date
    last_used_with_version?: string|null
}

export interface SyncConfigUpdate {
    name?: string
    content?: string
    last_used_with_version?: string
}

export interface SyncUser {
    name: string
}

export abstract class ConfigSyncBackend {
    abstract id: string
    abstract name: string

    /** Whether the user has to configure a server URL for this backend. */
    hostEditable = false

    /** Where the user can create an access token, if any. */
    tokenHelpUrl: string|null = null

    /** Whether the remote store can be read by anyone with the link, so that encryption should be encouraged. */
    publicReachable = false

    abstract checkAuth (): Promise<SyncUser>
    abstract listConfigs (): Promise<SyncRemoteConfig[]>
    abstract getConfig (id: string|number): Promise<SyncRemoteConfig>
    abstract createConfig (name: string, content: string): Promise<SyncRemoteConfig>
    abstract updateConfig (id: string|number, update: SyncConfigUpdate): Promise<SyncRemoteConfig>
    abstract deleteConfig (id: string|number): Promise<void>
}
