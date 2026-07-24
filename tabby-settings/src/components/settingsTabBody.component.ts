import { Component, Input, ViewContainerRef, ViewChild, ComponentFactoryResolver, ComponentRef, HostBinding } from '@angular/core'
import { SettingsTabProvider } from '../api'

/** @hidden */
@Component({
    selector: 'settings-tab-body',
    template: '<ng-template #placeholder></ng-template>',
    styles: [`
        :host {
            display: block;
            width: 100%;
            padding-bottom: 20px;
            margin-inline: auto;
            container-name: settings-content;
            container-type: inline-size;
            --settings-control-width: 20rem;
        }

        :host(.settings-layout-compact) {
            max-width: 46rem;
            --settings-content-width: 46rem;
        }

        :host(.settings-layout-form) {
            max-width: 56rem;
            --settings-content-width: 56rem;
        }

        :host(.settings-layout-wide) {
            max-width: 72rem;
            --settings-content-width: 72rem;
        }

        :host(.settings-layout-workspace) {
            height: 100%;
            max-width: none;
            padding-bottom: 0;
            overflow: hidden;
            --settings-content-width: none;
        }
    `],
})
export class SettingsTabBodyComponent {
    @Input() provider: SettingsTabProvider
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef
    component: ComponentRef<unknown>

    @HostBinding('class') get layoutClass (): string {
        return `settings-layout-${this.provider.layout}`
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
