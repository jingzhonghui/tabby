import { ApplicationRef, ComponentFactoryResolver, ComponentRef, Injectable, Injector, NgZone } from '@angular/core'
import { MenuItemOptions } from '../api/menu'
import { ContextMenuComponent } from '../components/contextMenu.component'

@Injectable({ providedIn: 'root' })
export class ContextMenuService {
    private componentRef?: ComponentRef<ContextMenuComponent>
    private hostElement?: HTMLElement
    private outsidePointerHandler = (event: PointerEvent): void => {
        if (this.hostElement && !this.hostElement.contains(event.target as Node)) {
            this.close()
        }
    }

    private closeHandler = (): void => this.close()

    constructor (
        private appRef: ApplicationRef,
        private componentFactoryResolver: ComponentFactoryResolver,
        private injector: Injector,
        private zone: NgZone,
    ) { }

    open (items: MenuItemOptions[], event?: MouseEvent): void {
        this.close()

        const menu = this.cleanItems(items)
        if (!menu.length) {
            return
        }

        const factory = this.componentFactoryResolver.resolveComponentFactory(ContextMenuComponent)
        this.componentRef = factory.create(this.injector)
        this.componentRef.instance.items = menu
        this.componentRef.instance.action.subscribe(item => {
            this.close()
            this.zone.run(() => item.click?.())
        })
        this.componentRef.instance.closeRequested.subscribe(() => this.close())
        this.appRef.attachView(this.componentRef.hostView)

        this.hostElement = this.componentRef.location.nativeElement as HTMLElement
        this.hostElement.classList.add('tabby-context-menu-host')
        this.hostElement.style.position = 'fixed'
        this.hostElement.style.zIndex = '1100'
        this.hostElement.style.visibility = 'hidden'
        document.body.appendChild(this.hostElement)
        this.componentRef.changeDetectorRef.detectChanges()

        const point = this.getPoint(event)
        const rect = this.hostElement.getBoundingClientRect()
        const left = Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8))
        const top = Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8))
        this.hostElement.style.left = `${left}px`
        this.hostElement.style.top = `${top}px`
        this.hostElement.style.visibility = 'visible'
        this.hostElement.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus()

        setTimeout(() => document.addEventListener('pointerdown', this.outsidePointerHandler, true))
        window.addEventListener('blur', this.closeHandler)
        window.addEventListener('resize', this.closeHandler)
    }

    close (): void {
        document.removeEventListener('pointerdown', this.outsidePointerHandler, true)
        window.removeEventListener('blur', this.closeHandler)
        window.removeEventListener('resize', this.closeHandler)
        if (this.componentRef) {
            this.appRef.detachView(this.componentRef.hostView)
            this.componentRef.destroy()
        }
        this.hostElement?.remove()
        this.componentRef = undefined
        this.hostElement = undefined
    }

    private getPoint (event?: MouseEvent): { x: number, y: number } {
        if (event) {
            return { x: event.clientX, y: event.clientY }
        }
        const active = document.activeElement?.getBoundingClientRect()
        return {
            x: active?.left ?? window.innerWidth / 2,
            y: active?.bottom ?? window.innerHeight / 2,
        }
    }

    private cleanItems (items: MenuItemOptions[]): MenuItemOptions[] {
        const result: MenuItemOptions[] = []
        let separator = true

        for (const item of items) {
            if (item.type === 'separator') {
                if (!separator) {
                    result.push({ type: 'separator' })
                    separator = true
                }
                continue
            }

            const submenu = item.submenu ? this.cleanItems(item.submenu) : undefined
            if ((item.type === 'submenu' || item.submenu) && !submenu?.length) {
                continue
            }

            result.push({
                ...item,
                type: item.type ?? (submenu ? 'submenu' : 'normal'),
                submenu,
            })
            separator = false
        }

        if (result.at(-1)?.type === 'separator') {
            result.pop()
        }
        return result
    }
}
