import { Injectable } from '@angular/core'
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap'

import { ProfileSelectorModalComponent, ProfileSelectorModalData } from '../components/profileSelectorModal.component'
import { SelectorModalComponent } from '../components/selectorModal.component'
import type { PartialProfile, Profile } from '../api/profileProvider'
import { SelectorOption } from '../api/selector'

@Injectable({ providedIn: 'root' })
export class SelectorService {
    private current: NgbModalRef|null = null

    get active (): boolean {
        return !!this.current
    }

    /** @hidden */
    private constructor (
        private ngbModal: NgbModal,
    ) { }

    show <T> (name: string, options: SelectorOption<T>[]): Promise<T> {
        const modal = this.ngbModal.open(SelectorModalComponent)
        this.current = modal
        modal.result.finally(() => {
            this.current = null
        })
        const instance: SelectorModalComponent<T> = modal.componentInstance
        instance.name = name
        instance.options = options
        return modal.result as Promise<T>
    }

    showProfileSelector (data: ProfileSelectorModalData): Promise<PartialProfile<Profile>|null> {
        const modal = this.ngbModal.open(ProfileSelectorModalComponent, {
            size: 'xl',
            centered: true,
            scrollable: true,
        })
        this.current = modal
        modal.result.finally(() => {
            this.current = null
        })
        const instance: ProfileSelectorModalComponent = modal.componentInstance
        instance.data = data
        return modal.result as Promise<PartialProfile<Profile>|null>
    }
}
