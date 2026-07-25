import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import slugify from 'slugify'
import { Component, Inject, Optional, TemplateRef, ViewChild } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, HostAppService, Profile, SelectorService, ProfilesService, PlatformService, BaseComponent, PartialProfile, ProfileProvider, TranslateService, Platform, ProfileGroup, PartialProfileGroup, QuickConnectProfileProvider, ProfileTransferProvider, NotificationsService } from 'tabby-core'
import { EditProfileModalComponent } from './editProfileModal.component'
import { EditProfileGroupModalComponent, EditProfileGroupModalComponentResult } from './editProfileGroupModal.component'

_('Filter')
_('Ungrouped')

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

/** @hidden */
@Component({
    templateUrl: './profilesSettingsTab.component.pug',
    styleUrls: ['./profilesSettingsTab.component.scss'],
})
export class ProfilesSettingsTabComponent extends BaseComponent {
    builtinProfiles: PartialProfile<Profile>[] = []
    profiles: PartialProfile<Profile>[] = []
    templateProfiles: PartialProfile<Profile>[] = []
    customProfiles: PartialProfile<Profile>[] = []
    profileGroups: PartialProfileGroup<CollapsableProfileGroup>[]
    rootGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    visibleProfiles: PartialProfile<Profile>[] = []
    selectedProfileCount = 0
    groupProfileCounts = new Map<string, number>()
    @ViewChild('advancedSettingsModal') advancedSettingsModal: TemplateRef<unknown>
    @ViewChild('deleteGroupConfirmModal') deleteGroupConfirmModal: TemplateRef<unknown>

    deleteGroupConfirmTitle = ''
    deleteGroupConfirmMessage = ''

    filter = ''
    selectedGroupId = 'all'
    Platform = Platform
    private descriptionCache = new Map<string, string|null>()
    private hiddenProfileGroupIds = new Set<string>(JSON.parse(window.localStorage.hiddenProfileGroupIds ?? '[]'))

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        @Inject(ProfileProvider) public profileProviders: ProfileProvider<Profile>[],
        private profilesService: ProfilesService,
        private selector: SelectorService,
        private ngbModal: NgbModal,
        private platform: PlatformService,
        private translate: TranslateService,
        private notifications: NotificationsService,
        @Optional() @Inject(ProfileTransferProvider) private profileTransferProviders: ProfileTransferProvider[]|null,
    ) {
        super()
        this.profileProviders.sort((a, b) => a.name.localeCompare(b.name))
    }

    async ngOnInit (): Promise<void> {
        await this.refreshProfileGroups()
        await this.refreshProfiles()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refreshProfileGroups())
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refreshProfiles())
    }

    async refreshProfiles (): Promise<void> {
        const allProfiles = (await this.profilesService.getProfiles()).map(profile => this.detachProfileFromHiddenGroup(profile))
        this.profiles = allProfiles.filter(x => !x.isTemplate)
        this.builtinProfiles = allProfiles.filter(x => x.isBuiltin && !x.isTemplate)
        this.templateProfiles = allProfiles.filter(x => x.isBuiltin && x.isTemplate)
        this.customProfiles = allProfiles.filter(x => !x.isBuiltin)

        this.descriptionCache.clear()
        for (const p of allProfiles) {
            if (p.id) {
                this.descriptionCache.set(p.id, this.profilesService.getDescription(p))
            }
        }
        this.refreshProfileView()
    }

    async importProfiles (): Promise<void> {
        const provider = await this.selectProfileTransferProvider()
        if (!provider) {
            return
        }
        const uploads = await this.platform.startUpload({ multiple: false })
        if (!uploads.length) {
            return
        }

        try {
            const result = await provider.importProfiles(await uploads[0].readAll())
            await this.refreshProfileGroups()
            await this.refreshProfiles()
            const chineseSummary = `已导入 ${result.imported} 项，跳过重复 ${result.skipped} 项，失败 ${result.errors.length} 项`
            if (result.errors.length) {
                this.notifications.error(chineseSummary, result.errors.join('\n'))
            } else {
                this.notifications.info(chineseSummary)
            }
        } catch (e) {
            this.notifications.error('无法导入配置', this.errorMessage(e))
        } finally {
            uploads[0].close()
        }
    }

    async exportProfiles (includeSecrets: boolean): Promise<void> {
        const provider = await this.selectProfileTransferProvider()
        if (!provider) {
            return
        }
        if (includeSecrets && (await this.platform.showMessageBox({
            type: 'warning',
            message: '是否以明文导出密码和私钥？',
            detail: '任何能够访问导出 CSV 文件的人都可以读取其中的敏感信息。',
            buttons: [
                '导出',
                '取消',
            ],
            defaultId: 1,
            cancelId: 1,
        })).response !== 0) {
            return
        }

        try {
            const result = await provider.exportProfiles(includeSecrets)
            const download = await this.platform.startDownload(result.name, includeSecrets ? 0o600 : 0o644, result.content.length)
            if (!download) {
                return
            }
            try {
                await download.write(result.content)
            } finally {
                download.close()
            }
            const summary = `已导出 ${result.exported} 项配置`
            if (result.warnings.length) {
                this.notifications.info(summary, result.warnings.join('\n'))
            } else {
                this.notifications.info(summary)
            }
        } catch (e) {
            this.notifications.error('无法导出配置', this.errorMessage(e))
        }
    }

    openAdvancedSettings (): void {
        this.ngbModal.open(this.advancedSettingsModal, { size: 'lg', ariaLabelledBy: 'advanced-settings-title' })
    }

    private async selectProfileTransferProvider (): Promise<ProfileTransferProvider|null> {
        if (!this.profileTransferProviders?.length) {
            this.notifications.error('当前没有可用的配置导入器')
            return null
        }
        if (this.profileTransferProviders.length === 1) {
            return this.profileTransferProviders[0]
        }
        return this.selector.show(
            '选择配置文件格式',
            this.profileTransferProviders.map(provider => ({ name: provider.name, result: provider })),
        ).catch(() => null)
    }

    private errorMessage (error: unknown): string {
        return error instanceof Error ? error.message : `${error}`
    }

    launchProfile (profile: PartialProfile<Profile>): void {
        this.profilesService.openNewTabForProfile(profile)
    }

    async newProfile (base?: PartialProfile<Profile>): Promise<void> {
        const useSelectedGroup = !base
        if (!base) {
            let profiles = await this.profilesService.getProfiles()
            profiles = profiles.filter(x => !this.isProfileBlacklisted(x))
            base = await this.selector.show(
                this.translate.instant('Select a base profile to use as a template'),
                profiles.map(p => ({
                    icon: p.icon ?? undefined,
                    description: this.profilesService.getDescription(p) ?? undefined,
                    name: p.group ? `${this.profilesService.resolveProfileGroupName(p.group)} / ${p.name}` : p.name,
                    group: p.isTemplate ? this.translate.instant('Template') : this.translate.instant('Duplicate an existing profile'),
                    result: p,
                    weight: p.isTemplate ? 0 : 1,
                })),
            ).catch(() => undefined)
            if (!base) {
                return
            }
        }
        const baseProfile: PartialProfile<Profile> = deepClone(base)
        delete baseProfile.id
        if (base.isTemplate) {
            baseProfile.name = ''
        } else if (!base.isBuiltin) {
            baseProfile.name = this.translate.instant('{name} copy', base)
        }
        baseProfile.isBuiltin = false
        baseProfile.isTemplate = false
        if (useSelectedGroup) {
            const selectedGroup = this.getSelectedGroup()
            if (selectedGroup?.editable) {
                baseProfile.group = selectedGroup.id
            } else {
                delete baseProfile.group
            }
        }
        const result = await this.showProfileEditModal(baseProfile)
        if (!result) {
            return
        }
        if (!result.name) {
            const cfgProxy = this.profilesService.getConfigProxyForProfile(result)
            result.name = this.profilesService.providerForProfile(result)?.getSuggestedName(cfgProxy) ?? this.translate.instant('{name} copy', base)
        }
        await this.profilesService.newProfile(result)
        await this.config.save()
    }

    async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        const result = await this.showProfileEditModal(profile)
        if (!result) {
            return
        }
        await this.profilesService.writeProfile(result)
        await this.config.save()
    }

    async showProfileEditModal (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) {
            throw new Error('Cannot edit a profile without a provider')
        }
        modal.componentInstance.partialProfile = deepClone(profile)
        modal.componentInstance.profileProvider = provider

        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }

        result.type = provider.id
        return result
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', profile),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            await this.profilesService.deleteProfile(profile)
            await this.config.save()
        }
    }

    async newProfileGroup (): Promise<void> {
        this.editProfileGroup({
            id: 'new',
            name: '',
            icon: 'far fa-folder',
        })
    }

    async editProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const result = await this.showProfileGroupEditModal(group)
        if (!result) {
            return
        }

        await this.profilesService.writeProfileGroup(ProfilesSettingsTabComponent.collapsableIntoPartialProfileGroup(result))
        await this.config.save()
    }

    async showProfileGroupEditModal (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<PartialProfileGroup<CollapsableProfileGroup>|null> {
        const modal = this.ngbModal.open(
            EditProfileGroupModalComponent,
            { size: 'lg' },
        )

        modal.componentInstance.group = deepClone(group)
        modal.componentInstance.providers = this.profileProviders

        const result: EditProfileGroupModalComponentResult<CollapsableProfileGroup> | null = await modal.result.catch(() => null)
        if (!result) {
            return null
        }

        if (result.provider) {
            return this.editProfileGroupDefaults(result.group, result.provider)
        }

        return result.group
    }

    private async editProfileGroupDefaults (group: PartialProfileGroup<CollapsableProfileGroup>, provider: ProfileProvider<Profile>): Promise<PartialProfileGroup<CollapsableProfileGroup>|null> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'group'

        const result = await modal.result.catch(() => null)
        if (result) {
            // Fully replace the config
            for (const k in model) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete model[k]
            }
            Object.assign(model, result)
            if (!group.defaults) {
                group.defaults = {}
            }
            group.defaults[provider.id] = model
        }
        return this.showProfileGroupEditModal(group)
    }

    canDeleteProfileGroup (group: PartialProfileGroup<ProfileGroup>): boolean {
        return group.id !== 'built-in'
    }

    async deleteProfileGroup (group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        if (!this.canDeleteProfileGroup(group)) {
            return
        }

        const groupName = group.id === 'ungrouped' ? '未分组' : group.name
        if (!await this.confirmProfileGroupDeletion(
            '删除分组',
            `确定要删除分组“${groupName}”吗？`,
        )) {
            return
        }

        const profileCount = group.profiles?.length ?? 0
        if (profileCount > 0) {
            const message = group.id === 'ungrouped'
                ? `“未分组”下有 ${profileCount} 个配置。删除该分组入口后，配置仍会保留在“全部主机”中。是否继续？`
                : `分组“${group.name}”下有 ${profileCount} 个配置。删除分组后，这些配置将移动到“未分组”。是否继续？`
            if (!await this.confirmProfileGroupDeletion('分组中仍有配置', message)) {
                return
            }
        }

        if (this.isPersistedProfileGroup(group)) {
            await this.profilesService.deleteProfileGroup(group)
            await this.config.save()
        } else {
            this.hideVirtualProfileGroup(group)
            await this.refreshProfileGroups()
            await this.refreshProfiles()
        }

        if (this.selectedGroupId === group.id || this.getDescendantGroupIds(group).has(this.selectedGroupId)) {
            this.selectedGroupId = 'all'
        }
    }

    private async confirmProfileGroupDeletion (title: string, message: string): Promise<boolean> {
        this.deleteGroupConfirmTitle = title
        this.deleteGroupConfirmMessage = message

        const modal = this.ngbModal.open(this.deleteGroupConfirmModal, {
            centered: true,
            ariaLabelledBy: 'delete-group-confirm-title',
        })
        const result = await modal.result.catch(() => false)
        return result === true
    }

    private isPersistedProfileGroup (group: PartialProfileGroup<ProfileGroup>): boolean {
        return (this.config.store.groups ?? []).some(candidate => candidate.id === group.id)
    }

    private hideVirtualProfileGroup (group: PartialProfileGroup<ProfileGroup>): void {
        this.hiddenProfileGroupIds.add(group.id)
        window.localStorage.hiddenProfileGroupIds = JSON.stringify([...this.hiddenProfileGroupIds])
    }

    private detachProfileFromHiddenGroup (profile: PartialProfile<Profile>): PartialProfile<Profile> {
        if (!profile.group || !this.hiddenProfileGroupIds.has(slugify(profile.group))) {
            return profile
        }
        const detachedProfile = deepClone(profile)
        delete detachedProfile.group
        return detachedProfile
    }

    async refreshProfileGroups (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        let groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })
        const detachedProfiles = groups
            .filter(group => group.id !== 'ungrouped' && this.hiddenProfileGroupIds.has(group.id))
            .flatMap(group => (group.profiles ?? []).map(profile => this.detachProfileFromHiddenGroup(profile)))
        groups = groups.filter(group => !this.hiddenProfileGroupIds.has(group.id))
        const ungrouped = groups.find(group => group.id === 'ungrouped')
        if (ungrouped && detachedProfiles.length) {
            ungrouped.profiles = [...ungrouped.profiles ?? [], ...detachedProfiles]
        }
        groups.sort((a, b) => a.name.localeCompare(b.name))
        groups.sort((a, b) => (a.id === 'built-in' || !a.editable ? 1 : 0) - (b.id === 'built-in' || !b.editable ? 1 : 0))
        groups.sort((a, b) => (a.id === 'ungrouped' ? 0 : 1) - (b.id === 'ungrouped' ? 0 : 1))
        this.profileGroups = groups.map(g => ProfilesSettingsTabComponent.intoPartialCollapsableProfileGroup(g, profileGroupCollapsed[g.id] ?? false))
        this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
        if (this.selectedGroupId !== 'all' && !this.profileGroups.some(group => group.id === this.selectedGroupId)) {
            this.selectedGroupId = 'all'
        }
        this.refreshProfileView()
    }

    selectGroup (groupId: string): void {
        this.selectedGroupId = groupId
        this.filter = ''
        this.refreshProfileView()
    }

    onFilterChange (): void {
        this.refreshProfileView()
    }

    private refreshProfileView (): void {
        this.groupProfileCounts.clear()
        for (const group of this.profileGroups) {
            this.groupProfileCounts.set(group.id, this.getProfilesInGroup(group).length)
        }

        let profiles = this.profiles
        if (this.selectedGroupId !== 'all') {
            const group = this.getSelectedGroup()
            profiles = group ? this.getProfilesInGroup(group) : []
        }
        this.selectedProfileCount = profiles.length

        const filter = this.filter.trim().toLowerCase()
        if (filter) {
            profiles = profiles.filter(profile => [
                profile.name,
                this.getDescription(profile),
                this.getProfileGroupPath(profile),
                this.getTypeLabel(profile),
            ].filter(Boolean).join('$').toLowerCase().includes(filter))
        }
        this.visibleProfiles = profiles
    }

    getSelectedGroupName (): string {
        if (this.selectedGroupId === 'all') {
            return '全部主机'
        }
        const group = this.getSelectedGroup()
        return group ? this.getGroupName(group) : '未分组'
    }

    getGroupName (group: PartialProfileGroup<CollapsableProfileGroup>): string {
        if (group.id === 'ungrouped') {
            return '未分组'
        }
        if (group.id === 'built-in') {
            return '内置配置'
        }
        return group.name || '未分组'
    }

    getGroupProfileCount (group: PartialProfileGroup<CollapsableProfileGroup>): number {
        return this.groupProfileCounts.get(group.id) ?? 0
    }

    getGroupToggleLabel (group: PartialProfileGroup<CollapsableProfileGroup>): string {
        const action = group.collapsed ? '展开' : '折叠'
        return `${action}${this.getGroupName(group)}`
    }

    canCreateProfileInSelectedGroup (): boolean {
        return this.selectedGroupId === 'all' || this.selectedGroupId === 'ungrouped' || !!this.getSelectedGroup()?.editable
    }

    getProfileGroupPath (profile: PartialProfile<Profile>): string {
        if (!profile.group) {
            return '未分组'
        }
        return this.profilesService.resolveProfileGroupPath(profile.group).join(' / ')
    }

    getDescription (profile: PartialProfile<Profile>): string|null {
        if (profile.id) {
            return this.descriptionCache.get(profile.id) ?? null
        }
        return this.profilesService.getDescription(profile)
    }

    getTypeLabel (profile: PartialProfile<Profile>): string {
        return {
            ssh: 'SSH',
            serial: '串口',
            telnet: 'Telnet',
            'split-layout': '拆分布局',
        }[profile.type] ?? (profile.type === 'local' ? '' : '未知')
    }

    getProviderName (provider: ProfileProvider<Profile>): string {
        return {
            ssh: 'SSH',
            serial: '串口',
            telnet: 'Telnet',
            local: '本地终端',
            'split-layout': '拆分布局',
        }[provider.id] ?? provider.name
    }

    getTypeColorClass (profile: PartialProfile<Profile>): string {
        return {
            ssh: 'secondary',
            serial: 'success',
            telnet: 'info',
            'split-layout': 'primary',
        }[this.profilesService.providerForProfile(profile)?.id ?? ''] ?? 'warning'
    }

    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        this.saveProfileGroupCollapse(group)
    }

    private getSelectedGroup (): PartialProfileGroup<CollapsableProfileGroup>|null {
        return this.profileGroups.find(group => group.id === this.selectedGroupId) ?? null
    }

    private getProfilesInGroup (group: PartialProfileGroup<CollapsableProfileGroup>): PartialProfile<Profile>[] {
        const profileIds = new Set<string>()
        const collect = (current: PartialProfileGroup<CollapsableProfileGroup>): void => {
            for (const profile of current.profiles ?? []) {
                if (!profile.isTemplate) {
                    profileIds.add(profile.id ?? `${profile.type}:${profile.name}`)
                }
            }
            for (const child of current.children ?? []) {
                collect(child)
            }
        }
        collect(group)
        return this.profiles.filter(profile => profileIds.has(profile.id ?? `${profile.type}:${profile.name}`))
    }

    private getDescendantGroupIds (group: PartialProfileGroup<CollapsableProfileGroup>): Set<string> {
        const result = new Set<string>()
        for (const child of group.children ?? []) {
            result.add(child.id)
            for (const id of this.getDescendantGroupIds(child)) {
                result.add(id)
            }
        }
        return result
    }

    async editDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = this.profilesService.getProviderDefaults(provider)
        model.type = provider.id
        modal.componentInstance.partialProfile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'enabled'
        const result = await modal.result.catch(() => null)
        if (result) {
            // Fully replace the config
            for (const k in model) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete model[k]
            }
            Object.assign(model, result)
            this.profilesService.setProviderDefaults(provider, model)
            await this.config.save()
        }
    }

    async deleteDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Restore settings to defaults ?'),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            this.profilesService.setProviderDefaults(provider, {})
            await this.config.save()
        }
    }

    blacklistProfile (profile: PartialProfile<Profile>): void {
        this.config.store.profileBlacklist = [...this.config.store.profileBlacklist, profile.id]
        this.config.save()
    }

    unblacklistProfile (profile: PartialProfile<Profile>): void {
        this.config.store.profileBlacklist = this.config.store.profileBlacklist.filter(x => x !== profile.id)
        this.config.save()
    }

    isProfileBlacklisted (profile: PartialProfile<Profile>): boolean {
        return profile.id && this.config.store.profileBlacklist.includes(profile.id)
    }

    getQuickConnectProviders (): ProfileProvider<Profile>[] {
        return this.profileProviders.filter(x => x instanceof QuickConnectProfileProvider)
    }

    /**
    * Save ProfileGroup collapse state in localStorage
    */
    private saveProfileGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    private static collapsableIntoPartialProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): PartialProfileGroup<ProfileGroup> {
        const g: any = { ...group }
        delete g.collapsed
        delete g.children
        return g
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        const collapsableGroup = {
            ...group,
            collapsed,
        }
        return collapsableGroup
    }
}
