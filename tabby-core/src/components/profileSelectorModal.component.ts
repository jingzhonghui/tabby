import { Component, Input, OnInit } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

import { ConnectableProfile, PartialProfile, PartialProfileGroup, Profile, ProfileGroup, QuickConnectProfileProvider } from '../api/profileProvider'
import { NotificationsService } from '../services/notifications.service'

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

export interface ProfileSelectorEntry {
    key: string
    profile: PartialProfile<Profile>
    description: string|null
    groupPath: string
    typeLabel: string
}

export interface ProfileSelectorModalData {
    entries: ProfileSelectorEntry[]
    recentEntries: ProfileSelectorEntry[]
    groups: PartialProfileGroup<ProfileGroup>[]
    quickConnectProviders: QuickConnectProfileProvider<ConnectableProfile>[]
    defaultQuickConnectProvider: string|null
    manageProfiles: () => void
    clearRecentProfiles: () => void
}

/** @hidden */
@Component({
    templateUrl: './profileSelectorModal.component.pug',
    styleUrls: ['./profileSelectorModal.component.scss'],
})
export class ProfileSelectorModalComponent implements OnInit {
    @Input() data: ProfileSelectorModalData

    profileGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    rootGroups: PartialProfileGroup<CollapsableProfileGroup>[] = []
    visibleEntries: ProfileSelectorEntry[] = []
    selectedEntryCount = 0
    selectedGroupId = 'all'
    filter = ''
    quickConnectQuery = ''
    quickConnectProviderId = ''
    private entriesByKey = new Map<string, ProfileSelectorEntry>()

    constructor (
        public modalInstance: NgbActiveModal,
        private notifications: NotificationsService,
    ) { }

    ngOnInit (): void {
        this.entriesByKey = new Map(this.data.entries.map(entry => [entry.key, entry]))
        this.profileGroups = this.prepareGroups(this.data.groups)
        this.rootGroups = this.buildGroupTree(this.profileGroups)
        this.quickConnectProviderId = this.getInitialQuickConnectProviderId()
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

    selectEntry (entry: ProfileSelectorEntry): void {
        this.modalInstance.close(entry.profile)
    }

    selectFirstVisible (): void {
        if (this.visibleEntries.length === 1) {
            this.selectEntry(this.visibleEntries[0])
        }
    }

    connectQuick (): void {
        const query = this.quickConnectQuery.trim()
        if (!query) {
            return
        }

        const selected = this.data.quickConnectProviders.find(provider => provider.id === this.quickConnectProviderId)
        const providers = selected
            ? [selected, ...this.data.quickConnectProviders.filter(provider => provider !== selected)]
            : this.data.quickConnectProviders

        for (const provider of providers) {
            const profile = provider.quickConnect(query)
            if (profile) {
                this.modalInstance.close(profile)
                return
            }
        }

        this.notifications.error(`Could not parse "${query}"`)
    }

    manageProfiles (): void {
        this.modalInstance.close(null)
        setTimeout(() => this.data.manageProfiles())
    }

    clearRecentProfiles (): void {
        this.data.clearRecentProfiles()
        this.data.recentEntries = []
        if (this.selectedGroupId === 'recent') {
            this.selectedGroupId = 'all'
        }
        this.refreshProfileView()
    }

    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        const collapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        collapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(collapsed)
    }

    getSelectedGroupName (): string {
        if (this.selectedGroupId === 'all') {
            return '全部主机'
        }
        if (this.selectedGroupId === 'recent') {
            return '最近使用'
        }
        const group = this.getSelectedGroup()
        return group ? this.getGroupName(group) : '全部主机'
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

    getGroupEntryCount (group: PartialProfileGroup<CollapsableProfileGroup>): number {
        return this.getEntriesInGroup(group).length
    }

    getQuickConnectProviderName (provider: QuickConnectProfileProvider<ConnectableProfile>): string {
        return provider.name || provider.id.toUpperCase()
    }

    private refreshProfileView (): void {
        let entries = this.data.entries
        if (this.selectedGroupId === 'recent') {
            entries = this.data.recentEntries
        } else if (this.selectedGroupId !== 'all') {
            const group = this.getSelectedGroup()
            entries = group ? this.getEntriesInGroup(group) : []
        }

        this.selectedEntryCount = entries.length
        const filter = this.filter.trim().toLowerCase()
        if (filter) {
            entries = entries.filter(entry => [
                entry.profile.name,
                entry.description,
                entry.groupPath,
                entry.typeLabel,
            ].filter(Boolean).join('$').toLowerCase().includes(filter))
        }
        this.visibleEntries = entries
    }

    private prepareGroups (groups: PartialProfileGroup<ProfileGroup>[]): PartialProfileGroup<CollapsableProfileGroup>[] {
        const collapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        return groups.map(group => ({
            ...group,
            collapsed: collapsed[group.id] ?? false,
            children: [],
        }))
    }

    private buildGroupTree (groups: PartialProfileGroup<CollapsableProfileGroup>[]): PartialProfileGroup<CollapsableProfileGroup>[] {
        const byId = new Map(groups.map(group => [group.id, group]))
        const roots: PartialProfileGroup<CollapsableProfileGroup>[] = []

        for (const group of groups) {
            const parent = group.parentGroupId ? byId.get(group.parentGroupId) : null
            if (parent) {
                parent.children!.push(group)
            } else {
                roots.push(group)
            }
        }
        return roots
    }

    private getSelectedGroup (): PartialProfileGroup<CollapsableProfileGroup>|null {
        return this.profileGroups.find(group => group.id === this.selectedGroupId) ?? null
    }

    private getEntriesInGroup (group: PartialProfileGroup<CollapsableProfileGroup>): ProfileSelectorEntry[] {
        const keys = new Set<string>()
        const collect = (current: PartialProfileGroup<CollapsableProfileGroup>): void => {
            for (const profile of current.profiles ?? []) {
                keys.add(ProfileSelectorModalComponent.getProfileKey(profile))
            }
            for (const child of current.children ?? []) {
                collect(child)
            }
        }
        collect(group)
        return [...keys].map(key => this.entriesByKey.get(key)).filter((entry): entry is ProfileSelectorEntry => !!entry)
    }

    private getInitialQuickConnectProviderId (): string {
        const preferred = this.data.quickConnectProviders.find(provider => provider.id === this.data.defaultQuickConnectProvider)
        if (preferred) {
            return preferred.id
        }
        return this.data.quickConnectProviders.length ? this.data.quickConnectProviders[0].id : ''
    }

    static getProfileKey (profile: PartialProfile<Profile>): string {
        return profile.id ?? `${profile.type}:${profile.name}`
    }
}
