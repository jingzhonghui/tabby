/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, HostBinding, Inject, Optional } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseComponent, ConfigService, PromptModalComponent, HostAppService, PlatformService, NotificationsService, TranslateService } from 'tabby-core'
import { ConfigSyncBackend, SyncRemoteConfig } from '../api/configSyncBackend'
import { ConfigSyncService } from '../services/configSync.service'


/** @hidden */
@Component({
    selector: 'config-sync-settings-tab',
    templateUrl: './configSyncSettingsTab.component.pug',
    styleUrls: ['./configSyncSettingsTab.component.scss'],
})
export class ConfigSyncSettingsTabComponent extends BaseComponent {
    connectionSuccessful: boolean|null = null
    connectionError: Error|null = null
    configs: SyncRemoteConfig[]|null = null

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public platform: PlatformService,
        private configSync: ConfigSyncService,
        private hostApp: HostAppService,
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        private translate: TranslateService,
        @Optional() @Inject(ConfigSyncBackend) public backends: ConfigSyncBackend[]|null,
    ) {
        super()
    }

    ngOnInit () {
        this.testConnection()
        this.loadConfigs()
    }

    get availableBackends (): ConfigSyncBackend[] {
        return this.backends ?? []
    }

    get activeBackend (): ConfigSyncBackend|null {
        return this.configSync.getBackend()
    }

    get needsHost (): boolean {
        return !!this.activeBackend?.hostEditable
    }

    get canConnect (): boolean {
        if (!this.config.store.configSync.token) {
            return false
        }
        return !this.needsHost || !!this.config.store.configSync.host
    }

    async onBackendChange () {
        // A config ID from one backend is meaningless to another, and so is its
        // access token - forwarding a token to the wrong service would leak it.
        this.config.store.configSync.configID = null
        this.config.store.configSync.token = null
        this.config.save()
        this.connectionSuccessful = null
        this.connectionError = null
        this.configs = null
        await this.testConnection()
    }

    async testConnection () {
        if (!this.canConnect) {
            this.connectionSuccessful = null
            this.configs = null
            return
        }
        this.connectionSuccessful = null
        try {
            await this.configSync.getUser()
            this.connectionSuccessful = true
            await this.loadConfigs()
        } catch (e) {
            this.connectionSuccessful = false
            this.connectionError = e as Error
            this.configs = null
        }
    }

    async loadConfigs () {
        if (!this.connectionSuccessful) {
            return
        }
        try {
            this.configs = await this.configSync.getConfigs()
        } catch (e) {
            this.connectionSuccessful = false
            this.connectionError = e as Error
            this.configs = null
        }
    }

    async uploadAsNew () {
        let name = this.translate.instant('New config on {platform}', this.hostApp)
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.translate.instant('Name for the new config')
        modal.componentInstance.value = name
        name = (await modal.result.catch(() => null))?.value
        if (!name) {
            return
        }
        const cfg = await this.configSync.createNewConfig(name)
        await this.loadConfigs()
        await this.uploadAndSync(cfg)
    }

    async uploadAndSync (cfg: SyncRemoteConfig) {
        if (this.config.store.configSync.configID !== cfg.id) {
            if ((await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('Overwrite the config on the remote side and start syncing?'),
                buttons: [
                    this.translate.instant('Overwrite remote and sync'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 1,
                cancelId: 1,
            })).response === 1) {
                return
            }
        }
        this.configSync.setConfig(cfg)
        await this.configSync.upload()
        await this.loadConfigs()
        this.notifications.info(this.translate.instant('Config uploaded'))
    }

    async downloadAndSync (cfg: SyncRemoteConfig) {
        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Overwrite the local config and start syncing?'),
            buttons: [
                this.translate.instant('Overwrite local and sync'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 1,
            cancelId: 1,
        })).response === 1) {
            return
        }
        this.configSync.setConfig(cfg)
        await this.configSync.download()
        this.notifications.info(this.translate.instant('Config downloaded'))
    }

    async delete (cfg: SyncRemoteConfig) {
        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Delete the config on the remote side?'),
            buttons: [
                this.translate.instant('Delete'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 1,
            cancelId: 1,
        })).response === 1) {
            return
        }
        await this.configSync.delete(cfg)
        await this.loadConfigs()
        this.notifications.info(this.translate.instant('Config deleted'))
    }

    hasMatchingRemoteConfig () {
        return !!this.configs?.find(c => this.isActiveConfig(c))
    }

    isActiveConfig (c: SyncRemoteConfig) {
        return c.id === this.config.store.configSync.configID
    }

    openSyncHost () {
        if (!this.config.store.configSync.host) {
            return
        }
        if (this.config.store.configSync.host === 'https://api.tabby.sh') {
            this.platform.openExternal('https://app.tabby.sh')
        } else {
            this.platform.openExternal(this.config.store.configSync.host)
        }
    }

    openTokenHelp () {
        if (this.activeBackend?.tokenHelpUrl) {
            this.platform.openExternal(this.activeBackend.tokenHelpUrl)
        }
    }

    openTabbyWebInfo () {
        this.platform.openExternal('https://github.com/Eugeny/tabby-web')
    }

}
