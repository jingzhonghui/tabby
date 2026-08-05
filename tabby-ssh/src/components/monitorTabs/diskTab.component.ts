import { Component, Input, OnInit, OnDestroy } from '@angular/core'
import { SSHSession } from '../../session/ssh'
import * as russh from 'russh'

interface DiskInfo {
    filesystem: string
    size: number
    used: number
    available: number
    usagePercent: number
    mountedOn: string
}

@Component({
    selector: 'disk-tab',
    templateUrl: './diskTab.component.pug',
    styleUrls: ['./diskTab.component.scss'],
})
export class DiskTabComponent implements OnInit, OnDestroy {
    @Input() session: SSHSession

    loading = true
    error: string|null = null
    fetching = false

    // 磁盘数据
    disks: DiskInfo[] = []
    totalSize = 0
    totalUsed = 0
    totalAvailable = 0
    totalUsagePercent = 0

    // 静态缓存
    private static cachedData: {
        disks: DiskInfo[]
        totalSize: number
        totalUsed: number
        totalAvailable: number
        totalUsagePercent: number
    }|null = null
    private static cachedAt = 0
    private static readonly CACHE_TTL = 30000

    private updateTimer: any

    private static readonly DISK_COMMAND = 'df -P -B1'

    async ngOnInit (): Promise<void> {
        // 如果有缓存且未过期，先显示缓存
        if (DiskTabComponent.cachedData &&
            Date.now() - DiskTabComponent.cachedAt < DiskTabComponent.CACHE_TTL) {
            const cache = DiskTabComponent.cachedData
            this.disks = [...cache.disks]
            this.totalSize = cache.totalSize
            this.totalUsed = cache.totalUsed
            this.totalAvailable = cache.totalAvailable
            this.totalUsagePercent = cache.totalUsagePercent
            this.loading = false
        }

        // 触发数据获取
        await this.fetchStats()
        this.updateTimer = setInterval(() => this.fetchStats(), 5000)
    }

    ngOnDestroy (): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer)
        }
    }

    async fetchStats (): Promise<void> {
        if (this.fetching) return
        this.fetching = true

        try {
            const output = await this.executeCommand(DiskTabComponent.DISK_COMMAND)
            this.disks = this.parseDiskInfo(output)

            // 计算总计
            this.totalSize = this.disks.reduce((sum, d) => sum + d.size, 0)
            this.totalUsed = this.disks.reduce((sum, d) => sum + d.used, 0)
            this.totalAvailable = this.disks.reduce((sum, d) => sum + d.available, 0)
            this.totalUsagePercent = this.totalSize > 0
                ? Math.round((this.totalUsed / this.totalSize) * 1000) / 10
                : 0

            this.loading = false
            this.error = null

            // 更新缓存
            DiskTabComponent.cachedData = {
                disks: [...this.disks],
                totalSize: this.totalSize,
                totalUsed: this.totalUsed,
                totalAvailable: this.totalAvailable,
                totalUsagePercent: this.totalUsagePercent,
            }
            DiskTabComponent.cachedAt = Date.now()
        } catch (err) {
            this.error = err.message
            this.loading = false
        } finally {
            this.fetching = false
        }
    }

    private parseDiskInfo (data: string): DiskInfo[] {
        const lines = data.split('\n').slice(1)
        const disks: DiskInfo[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            const parts = trimmed.split(/\s+/)
            if (parts.length < 6) continue

            const filesystem = parts[0]
            const size = this.parseSize(parts[1])
            const used = this.parseSize(parts[2])
            const available = this.parseSize(parts[3])
            const usagePercent = parseInt(parts[4].replace('%', ''), 10) || 0
            const mountedOn = parts.slice(5).join(' ')

            // 过滤掉虚拟文件系统
            if (filesystem.includes('tmpfs') || filesystem.includes('devtmpfs') ||
                filesystem.includes('overlay') || filesystem.includes('squashfs') ||
                filesystem.includes('proc') || filesystem.includes('sysfs')) {
                continue
            }

            disks.push({ filesystem, size, used, available, usagePercent, mountedOn })
        }

        return disks
    }

    private parseSize (sizeStr: string): number {
        if (!sizeStr) return 0
        const match = sizeStr.match(/^([\d.]+)([KMGTPE]?)$/)
        if (!match) return 0

        const value = parseFloat(match[1])
        const unit = match[2]
        const multipliers: Record<string, number> = {
            '': 1,
            'K': 1024,
            'M': 1024 ** 2,
            'G': 1024 ** 3,
            'T': 1024 ** 4,
            'P': 1024 ** 5,
            'E': 1024 ** 6,
        }

        return Math.round(value * (multipliers[unit] || 1))
    }

    formatBytes (bytes: number): string {
        if (bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
    }

    getProgressBarClass (percent: number): string {
        if (percent < 50) return 'bg-success'
        if (percent < 80) return 'bg-warning'
        return 'bg-danger'
    }

    private async executeCommand (command: string): Promise<string> {
        if (!(this.session.ssh instanceof russh.AuthenticatedSSHClient)) {
            throw new Error('SSH session not authenticated')
        }

        const newChannel = await this.session.ssh.openSessionChannel()
        const channel = await this.session.ssh.activateChannel(newChannel)
        await channel.requestExec(command)

        return new Promise((resolve, reject) => {
            let output = ''
            let closed = false

            const dataSub = channel.data$.subscribe({
                next: (data: Uint8Array) => {
                    output += Buffer.from(data).toString('utf-8')
                },
                error: (err: Error) => {
                    if (!closed) {
                        closed = true
                        reject(err)
                    }
                },
            })

            const extDataSub = channel.extendedData$.subscribe({
                next: ([_type, data]: [number, Uint8Array]) => {
                    // Ignore stderr
                },
            })

            const closeSub = channel.closed$.subscribe(() => {
                if (closed) return
                closed = true
                dataSub.unsubscribe()
                extDataSub.unsubscribe()
                closeSub.unsubscribe()
                resolve(output)
            })

            setTimeout(() => {
                if (!closed) {
                    closed = true
                    dataSub.unsubscribe()
                    extDataSub.unsubscribe()
                    closeSub.unsubscribe()
                    resolve(output)
                }
            }, 8000)
        })
    }
}
