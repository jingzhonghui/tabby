/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, OperatorFunction, debounceTime, map } from 'rxjs'
import { ConfigProxy, ProfileGroup, Profile, ProfileProvider, PlatformService, TranslateService, PartialProfileGroup, ProfilesService, TAB_COLORS } from 'tabby-core'

const iconsData = require('../../../tabby-core/src/icons.json')
const iconsClassList = Object.keys(iconsData).map(
    icon => iconsData[icon].map(
        style => `fa${style[0]} fa-${icon}`,
    ),
).flat()

interface Hsv {
    h: number
    s: number
    v: number
}

interface Rgb {
    r: number
    g: number
    b: number
}

function parseHexColor (value: string|undefined|null): Rgb|null {
    if (!value) {
        return null
    }
    let hex = value.trim().replace(/^#/, '')
    if (hex.length === 3) {
        hex = hex.split('').map(x => x + x).join('')
    }
    if (!/^[0-9a-f]{6}$/i.test(hex)) {
        return null
    }
    return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
    }
}

function rgbToHsv ({ r, g, b }: Rgb): Hsv {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const diff = max - Math.min(rn, gn, bn)
    let h = 0
    if (diff !== 0) {
        if (max === rn) {
            h = ((gn - bn) / diff) % 6
        } else if (max === gn) {
            h = (bn - rn) / diff + 2
        } else {
            h = (rn - gn) / diff + 4
        }
        h *= 60
        if (h < 0) {
            h += 360
        }
    }
    return { h, s: max === 0 ? 0 : diff / max, v: max }
}

function hsvToHex ({ h, s, v }: Hsv): string {
    const chroma = v * s
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = v - chroma
    const sector = Math.floor(h / 60) % 6
    const channels = [
        [chroma, x, 0],
        [x, chroma, 0],
        [0, chroma, x],
        [0, x, chroma],
        [x, 0, chroma],
        [chroma, 0, x],
    ][sector]
    return '#' + channels
        .map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0'))
        .join('')
}

function clamp01 (value: number): number {
    return Math.min(1, Math.max(0, value))
}

/** @hidden */
@Component({
    templateUrl: './editProfileGroupModal.component.pug',
    styleUrls: ['./editProfileGroupModal.component.scss'],
})
export class EditProfileGroupModalComponent<G extends ProfileGroup> {
    @Input() group: G & ConfigProxy<G>
    @Input() providers: ProfileProvider<Profile>[]
    groups: PartialProfileGroup<ProfileGroup>[]
    parentSelection = ''

    getValidParents (groups: PartialProfileGroup<ProfileGroup>[], targetId: string): PartialProfileGroup<ProfileGroup>[] {
        // Build a quick lookup: parentGroupId -> [child groups]
        const childrenMap = new Map<string | null, string[]>()
        for (const group of groups) {
            const parent = group.parentGroupId ?? null
            if (!childrenMap.has(parent)) {
                childrenMap.set(parent, [])
            }
            childrenMap.get(parent)!.push(group.id)
        }

        // Depth-first search to find all descendants of target
        function getDescendants (id: string): Set<string> {
            const descendants = new Set<string>()
            const stack: string[] = [id]

            while (stack.length > 0) {
                const current = stack.pop()!
                const children = childrenMap.get(current)
                if (children) {
                    for (const child of children) {
                        if (!descendants.has(child)) {
                            descendants.add(child)
                            stack.push(child)
                        }
                    }
                }
            }
            return descendants
        }

        const descendants = getDescendants(targetId)

        // Valid parents = all groups that are not the target or its descendants
        return groups.filter((g) => g.id !== targetId && !descendants.has(g.id))
    }

    constructor (
        private modalInstance: NgbActiveModal,
        private profilesService: ProfilesService,
        private platform: PlatformService,
        private translate: TranslateService,
    ) { }

    async ngOnInit () {
        const groups = await this.profilesService.getProfileGroups()
        this.groups = this.getValidParents(groups, this.group.id)
        this.groups.sort((a, b) => this.getGroupLabel(a).localeCompare(this.getGroupLabel(b)))
        this.parentSelection = this.group.parentGroupId ?? ''
    }

    getGroupLabel (group: PartialProfileGroup<ProfileGroup>): string {
        const path = this.profilesService.resolveProfileGroupPath(group.id)
        return path.length ? path.join(' / ') : group.name
    }

    presetColors = TAB_COLORS.filter(x => x.value)

    customPanelOpen = false
    hsv: Hsv = rgbToHsv({ r: 2, g: 117, b: 216 })

    private areaEl: HTMLElement|null = null
    private hueEl: HTMLElement|null = null
    private dragging: 'area'|'hue'|null = null

    selectColor (value: string|null): void {
        this.group.color = value ?? undefined
        this.customPanelOpen = false
    }

    isSelectedColor (value: string|null): boolean {
        return (this.group.color ?? null) === value
    }

    isCustomColor (): boolean {
        const color = this.group.color
        if (!color || color === 'null') {
            return false
        }
        return !TAB_COLORS.some(x => x.value?.toLowerCase() === color.toLowerCase())
    }

    get hueColor (): string {
        return `hsl(${this.hsv.h.toFixed(1)}, 100%, 50%)`
    }

    toggleCustomPanel (): void {
        this.customPanelOpen = !this.customPanelOpen
        if (this.customPanelOpen) {
            const rgb = parseHexColor(this.group.color)
            if (rgb) {
                this.hsv = rgbToHsv(rgb)
            }
        }
    }

    onAreaPointerDown (event: PointerEvent): void {
        event.preventDefault()
        this.areaEl = event.currentTarget as HTMLElement
        this.dragging = 'area'
        this.updateFromArea(event)
        this.startTracking()
    }

    onHuePointerDown (event: PointerEvent): void {
        event.preventDefault()
        this.hueEl = event.currentTarget as HTMLElement
        this.dragging = 'hue'
        this.updateFromHue(event)
        this.startTracking()
    }

    onHexChange (value: string): void {
        this.group.color = value
        const rgb = parseHexColor(value)
        if (rgb) {
            const next = rgbToHsv(rgb)
            // a pure grey carries no hue - keep the slider where the user left it
            this.hsv = next.s === 0 ? { ...next, h: this.hsv.h } : next
        }
    }

    ngOnDestroy (): void {
        this.onPointerUp()
    }

    private startTracking (): void {
        document.addEventListener('pointermove', this.onPointerMove)
        document.addEventListener('pointerup', this.onPointerUp)
    }

    private onPointerMove = (event: PointerEvent): void => {
        if (this.dragging === 'area') {
            this.updateFromArea(event)
        } else if (this.dragging === 'hue') {
            this.updateFromHue(event)
        }
    }

    private onPointerUp = (): void => {
        this.dragging = null
        document.removeEventListener('pointermove', this.onPointerMove)
        document.removeEventListener('pointerup', this.onPointerUp)
    }

    private updateFromArea (event: PointerEvent): void {
        if (!this.areaEl) {
            return
        }
        const rect = this.areaEl.getBoundingClientRect()
        this.hsv = {
            ...this.hsv,
            s: clamp01((event.clientX - rect.left) / rect.width),
            v: 1 - clamp01((event.clientY - rect.top) / rect.height),
        }
        this.group.color = hsvToHex(this.hsv)
    }

    private updateFromHue (event: PointerEvent): void {
        if (!this.hueEl) {
            return
        }
        const rect = this.hueEl.getBoundingClientRect()
        this.hsv = { ...this.hsv, h: clamp01((event.clientX - rect.left) / rect.width) * 359.9 }
        this.group.color = hsvToHex(this.hsv)
    }

    iconSearch: OperatorFunction<string, string[]> = (text$: Observable<string>) =>
        text$.pipe(
            debounceTime(200),
            map(term => iconsClassList.filter(v => v.toLowerCase().includes(term.toLowerCase())).slice(0, 10)),
        )

    async save () {
        this.group.parentGroupId = this.parentSelection || undefined

        if (this.group.id === 'new') {
            await this.profilesService.newProfileGroup(this.group, { genId: true })
        }
        this.modalInstance.close({ group: this.group })
    }

    cancel () {
        this.modalInstance.dismiss()
    }

    editDefaults (provider: ProfileProvider<Profile>) {
        this.modalInstance.close({ group: this.group, provider })
    }

    async deleteDefaults (provider: ProfileProvider<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Restore settings to inherited defaults ?'),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete this.group.defaults?.[provider.id]
        }
    }
}

export interface EditProfileGroupModalComponentResult<G extends ProfileGroup> {
    group: G
    provider?: ProfileProvider<Profile>
}
