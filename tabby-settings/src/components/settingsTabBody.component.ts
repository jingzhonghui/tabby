import { Component, Input, ViewContainerRef, ViewChild, ComponentFactoryResolver, ComponentRef, HostBinding } from '@angular/core'
import { SettingsTabProvider } from '../api'

/** @hidden */
@Component({
    selector: 'settings-tab-body',
    template: '<ng-template #placeholder></ng-template>',
    styles: [`
        :host {
            display: block;
            padding-bottom: 20px;
            max-width: 600px;
        }

        :host(.full-width) {
            width: 100%;
            height: 100%;
            max-width: none;
            padding-bottom: 0;
            overflow: hidden;
        }
    `],
})
export class SettingsTabBodyComponent {
    @Input() provider: SettingsTabProvider
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef
    component: ComponentRef<unknown>

    @HostBinding('class.full-width') get fullWidth (): boolean {
        return this.provider.id === 'profiles'
    }

    constructor (private componentFactoryResolver: ComponentFactoryResolver) { }

    ngAfterViewInit (): void {
        // run after the change detection finishes
        setImmediate(() => {
            this.component = this.placeholder.createComponent(
                this.componentFactoryResolver.resolveComponentFactory(
                    this.provider.getComponentType(),
                ),
            )
        })
    }
}
