import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/** @hidden */
@Component({
    templateUrl: './remoteCWDIntegrationModal.component.pug',
})
export class RemoteCWDIntegrationModalComponent {
    constructor (
        private modalInstance: NgbActiveModal,
    ) { }

    enableOnce (): void {
        this.modalInstance.close(0)
    }

    enablePermanently (): void {
        this.modalInstance.close(1)
    }

    cancel (): void {
        this.modalInstance.close(2)
    }
}
