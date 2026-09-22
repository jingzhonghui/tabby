/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Observable, OperatorFunction, debounceTime, map, distinctUntilChanged } from 'rxjs'
import { Component, Input, ViewChild, ViewContainerRef, ComponentFactoryResolver, Injector } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { PartialProfileGroup, Profile, ProfileProvider, ProfileSettingsComponent, ProfilesService, TAB_COLORS, ProfileGroup, ConnectableProfileProvider, FullyDefined, ConfigProxy } from 'tabby-core'

const iconsData = require('../../../tabby-core/src/icons.json')
const iconsClassList = Object.keys(iconsData).map(
    icon => iconsData[icon].map(
        style => `fa${style[0]} fa-${icon}`,
    ),
).flat()

/** @hidden */
@Component({
    templateUrl: './editProfileModal.component.pug',
})
export class EditProfileModalComponent<P extends Profile, PP extends ProfileProvider<P>> {
    @Input('profile') partialProfile: P
    @Input() profileProvider: PP
    @Input() settingsComponent: new () => ProfileSettingsComponent<P, PP>
    @Input() defaultsMode: 'enabled'|'group'|'disabled' = 'disabled'
    groups: PartialProfileGroup<ProfileGroup>[]
    groupSelection = ''
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef

    protected profile: FullyDefined<P> & ConfigProxy<FullyDefined<P>>
    private settingsComponentInstance?: ProfileSettingsComponent<P, PP>

    constructor (
        private injector: Injector,
        private componentFactoryResolver: ComponentFactoryResolver,
        private profilesService: ProfilesService,
        private modalInstance: NgbActiveModal,
    ) {
        if (this.defaultsMode === 'disabled') {
            this.profilesService.getProfileGroups().then(groups => {
                this.groupSelection = this.partialProfile.group ?? ''
                if (this.groupSelection && !groups.some(g => g.id === this.groupSelection)) {
                    groups = [
                        { id: this.groupSelection, name: this.profilesService.resolveProfileGroupName(this.groupSelection) },
                        ...groups,
                    ]
                }
                groups.sort((a, b) => this.getGroupLabel(a).localeCompare(this.getGroupLabel(b)))
                this.groups = groups
            })
        }
    }

    getGroupLabel (group: PartialProfileGroup<ProfileGroup>): string {
        const path = this.profilesService.resolveProfileGroupPath(group.id)
        return path.length ? path.join(' / ') : group.name
    }

    colorsAutocomplete = text$ => text$.pipe(
        debounceTime(200),
        distinctUntilChanged(),
        map((q: string) =>
            TAB_COLORS
                .filter(x => !q || x.name.toLowerCase().startsWith(q.toLowerCase()))
                .map(x => x.value),
        ),
    )

    colorsFormatter = value => {
        return TAB_COLORS.find(x => x.value === value)?.name ?? value
    }

    ngOnInit () {
        this.profile = this.profilesService.getConfigProxyForProfile<P>(this.partialProfile, { skipGlobalDefaults: this.defaultsMode === 'enabled', skipGroupDefaults: this.defaultsMode === 'group' })
    }

    ngAfterViewInit () {
        const componentType = this.profileProvider.settingsComponent
        if (componentType) {
            setTimeout(() => {
                const componentFactory = this.componentFactoryResolver.resolveComponentFactory(componentType)
                const componentRef = componentFactory.create(this.injector)
                this.settingsComponentInstance = componentRef.instance
                this.settingsComponentInstance.profile = this.profile
                this.placeholder.insert(componentRef.hostView)
            })
        }
    }

    iconSearch: OperatorFunction<string, string[]> = (text$: Observable<string>) =>
        text$.pipe(
            debounceTime(200),
            map(term => iconsClassList.filter(v => v.toLowerCase().includes(term.toLowerCase())).slice(0, 10)),
        )

    save () {
        this.profile.group = this.groupSelection || ''

        this.settingsComponentInstance?.save?.()
        this.profile.__cleanup()
        this.modalInstance.close(this.partialProfile)
    }

    cancel () {
        this.modalInstance.dismiss()
    }

    isConnectable (): boolean {
        return this.profileProvider instanceof ConnectableProfileProvider
    }

}
