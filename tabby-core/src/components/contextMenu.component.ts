import { Component, ElementRef, EventEmitter, Input, Output } from '@angular/core'
import { MenuItemOptions } from '../api/menu'

@Component({
    selector: 'tabby-context-menu',
    templateUrl: './contextMenu.component.pug',
    styleUrls: ['./contextMenu.component.scss'],
})
export class ContextMenuComponent {
    @Input() items: MenuItemOptions[] = []
    @Input() nested = false
    @Output() action = new EventEmitter<MenuItemOptions>()
    @Output() closeRequested = new EventEmitter<void>()
    @Output() backRequested = new EventEmitter<void>()

    openSubmenu: MenuItemOptions|null = null
    submenuOpensLeft = false
    submenuOffset = -6

    constructor (private element: ElementRef<HTMLElement>) { }

    isEnabled (item: MenuItemOptions): boolean {
        return item.enabled !== false
    }

    roleFor (item: MenuItemOptions): string {
        if (item.type === 'checkbox') {
            return 'menuitemcheckbox'
        }
        if (item.type === 'radio') {
            return 'menuitemradio'
        }
        return 'menuitem'
    }

    showSubmenu (item: MenuItemOptions, event: MouseEvent): void {
        if (!this.isEnabled(item) || !item.submenu?.length) {
            this.openSubmenu = null
            return
        }

        const row = event.currentTarget as HTMLElement
        const rect = row.getBoundingClientRect()
        const width = 240
        const height = Math.min(window.innerHeight - 16, item.submenu.length * 29 + 12)
        this.submenuOpensLeft = rect.right + width > window.innerWidth - 8
        this.submenuOffset = Math.max(-rect.top + 8, Math.min(-6, window.innerHeight - rect.top - height - 8))
        this.openSubmenu = item
    }

    activate (item: MenuItemOptions): void {
        if (!this.isEnabled(item)) {
            return
        }
        if (item.submenu?.length) {
            this.openSubmenu = item
            return
        }
        this.action.emit(item)
    }

    onKeyDown (event: KeyboardEvent): void {
        event.stopPropagation()
        const entries = this.enabledItems()
        const current = document.activeElement as HTMLElement
        let index = entries.indexOf(current)

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            index = (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
            entries[index]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            entries[event.key === 'Home' ? 0 : entries.length - 1]?.focus()
        } else if (event.key === 'ArrowRight') {
            const item = this.itemForElement(current)
            if (item?.submenu?.length) {
                event.preventDefault()
                this.openSubmenu = item
                setTimeout(() => {
                    const submenu = this.element.nativeElement.querySelector<HTMLElement>('tabby-context-menu.submenu')
                    submenu?.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus()
                })
            }
        } else if (event.key === 'ArrowLeft' && this.nested) {
            event.preventDefault()
            this.backRequested.emit()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            this.closeRequested.emit()
        }
    }

    private enabledItems (): HTMLElement[] {
        return Array.from(this.element.nativeElement.querySelectorAll<HTMLElement>(':scope > .menu-root > .menu-item-wrapper > .menu-item'))
            .filter(x => !x.hasAttribute('disabled'))
    }

    private itemForElement (element: HTMLElement): MenuItemOptions|undefined {
        const index = parseInt(element.dataset.index ?? '-1')
        return this.items[index]
    }
}
