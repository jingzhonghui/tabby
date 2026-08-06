import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core'
import { SSHSession } from '../../session/ssh'
import * as russh from 'russh'

interface CPUStats {
    user: number
    nice: number
    system: number
    idle: number
    iowait: number
    irq: number
    softirq: number
    steal: number
    guest: number
    guestNice: number
}

interface MemoryStats {
    total: number
    free: number
    available: number
    buffers: number
    cached: number
    used: number
    usagePercent: number
}

interface DiskInfo {
    filesystem: string
    size: number
    used: number
    available: number
    usagePercent: number
    mountedOn: string
}

interface NetworkInterface {
    name: string
    rxSpeed: number
    txSpeed: number
    rxBytes: number
    txBytes: number
    rxPackets: number
    txPackets: number
    rxErrors: number
    txErrors: number
}

export interface ServerStats {
    cpu: {
        usagePercent: number
        cores: number
    }
    memory: MemoryStats
    disks: DiskInfo[]
    network: NetworkInterface[]
    uptime: string
    loadAverage: string[]
}

@Component({
    selector: 'overview-tab',
    templateUrl: './overviewTab.component.pug',
    styleUrls: ['./overviewTab.component.scss'],
})
export class OverviewTabComponent implements OnInit, OnDestroy {
    @Input() session: SSHSession
    @Output() statsChange = new EventEmitter<ServerStats>()

    stats: ServerStats|null = null
    loading = true
    error: string|null = null
    fetching = false
    private updateTimer: any
    private previousCPUStats: Map<number, CPUStats> = new Map()
    private previousNetworkStats: Map<string, { rxBytes: number, txBytes: number, timestamp: number }> = new Map()

    // 静态缓存
    private static cachedStats: ServerStats|null = null
    private static cachedAt = 0
    private static readonly CACHE_TTL = 300000 // 30秒缓存有效期

    private static readonly MONITOR_COMMAND = [
        'echo "@@TABBY_MON_STAT@@"; cat /proc/stat',
        'echo "@@TABBY_MON_MEM@@"; cat /proc/meminfo',
        'echo "@@TABBY_MON_DF@@"; df -P -B1',
        'echo "@@TABBY_MON_NET@@"; cat /proc/net/dev',
        'echo "@@TABBY_MON_UPTIME@@"; cat /proc/uptime',
        'echo "@@TABBY_MON_LOAD@@"; cat /proc/loadavg',
    ].join('; ')

    async ngOnInit (): Promise<void> {
        // 如果有缓存且未过期，先显示缓存
        if (OverviewTabComponent.cachedStats &&
            Date.now() - OverviewTabComponent.cachedAt < OverviewTabComponent.CACHE_TTL) {
            this.stats = OverviewTabComponent.cachedStats
            this.loading = false
            this.statsChange.emit(this.stats)
        }

        // 触发数据获取（后台刷新）
        await this.fetchStats()
        this.updateTimer = setInterval(() => this.fetchStats(), 3000)
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
            const output = await this.executeCommand(OverviewTabComponent.MONITOR_COMMAND)
            const sections = this.parseSections(output)
            const prev = this.stats

            if (!sections.stat && !sections.mem) {
                console.warn('[server-monitor] 无法解析监控输出:', output.slice(0, 500))
            }

            const parsedDisks = sections.df ? this.parseDiskInfo(sections.df) : []
            const parsedNetwork = sections.net ? this.parseNetworkInfo(sections.net) : []

            this.stats = {
                cpu: sections.stat
                    ? this.parseCPUInfo(sections.stat)
                    : (prev?.cpu ?? { usagePercent: 0, cores: 0 }),
                memory: sections.mem && /^MemTotal:\s+\d+/m.test(sections.mem)
                    ? this.parseMemoryInfo(sections.mem)
                    : (prev?.memory ?? { total: 0, free: 0, available: 0, buffers: 0, cached: 0, used: 0, usagePercent: 0 }),
                disks: parsedDisks.length > 0
                    ? parsedDisks
                    : (prev?.disks ?? []),
                network: parsedNetwork.length > 0
                    ? parsedNetwork
                    : (prev?.network ?? []),
                uptime: sections.uptime
                    ? this.parseUptime(sections.uptime)
                    : (prev?.uptime ?? ''),
                loadAverage: sections.load
                    ? this.parseLoadAverage(sections.load)
                    : (prev?.loadAverage ?? []),
            }

            this.statsChange.emit(this.stats)
            // 更新缓存
            OverviewTabComponent.cachedStats = this.stats
            OverviewTabComponent.cachedAt = Date.now()
            this.loading = false
            this.error = null
        } catch (err) {
            this.error = err.message
            this.loading = false
        } finally {
            this.fetching = false
        }
    }

    private parseSections (output: string): Record<string, string> {
        const sections: Record<string, string> = {}
        let current: string|null = null

        for (const line of output.split('\n')) {
            const match = /^@@TABBY_MON_(\w+)@@\s*$/.exec(line)
            if (match) {
                current = match[1].toLowerCase()
                sections[current] = ''
            } else if (current) {
                sections[current] += line + '\n'
            }
        }

        return sections
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

    private parseCPUInfo (data: string): { usagePercent: number, cores: number } {
        const lines = data.split('\n').filter(l => l.startsWith('cpu'))
        const totalCores = lines.length - 1

        let totalUsagePercent = 0
        let validCores = 0

        for (const line of lines) {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 8) continue

            const coreId = parts[0]
            const stats: CPUStats = {
                user: parseInt(parts[1], 10) || 0,
                nice: parseInt(parts[2], 10) || 0,
                system: parseInt(parts[3], 10) || 0,
                idle: parseInt(parts[4], 10) || 0,
                iowait: parseInt(parts[5], 10) || 0,
                irq: parseInt(parts[6], 10) || 0,
                softirq: parseInt(parts[7], 10) || 0,
                steal: parseInt(parts[8], 10) || 0,
                guest: parseInt(parts[9], 10) || 0,
                guestNice: parseInt(parts[10], 10) || 0,
            }

            if (coreId === 'cpu') {
                continue
            }

            const coreNum = parseInt(coreId.replace('cpu', ''), 10)
            const prevStats = this.previousCPUStats.get(coreNum)

            if (prevStats) {
                const prevTotal = prevStats.user + prevStats.nice + prevStats.system + prevStats.idle + prevStats.iowait + prevStats.irq + prevStats.softirq + prevStats.steal
                const currTotal = stats.user + stats.nice + stats.system + stats.idle + stats.iowait + stats.irq + stats.softirq + stats.steal
                const totalDiff = currTotal - prevTotal
                const idleDiff = stats.idle - prevStats.idle

                if (totalDiff > 0) {
                    const usagePercent = ((totalDiff - idleDiff) / totalDiff) * 100
                    totalUsagePercent += usagePercent
                    validCores++
                }
            }

            this.previousCPUStats.set(coreNum, stats)
        }

        const usagePercent = validCores > 0 ? Math.round((totalUsagePercent / validCores) * 10) / 10 : 0
        return { usagePercent, cores: totalCores }
    }

    private parseMemoryInfo (data: string): MemoryStats {
        const lines = data.split('\n')
        const values: Record<string, number> = {}

        for (const line of lines) {
            const match = line.match(/^(\w+):\s+(\d+)/)
            if (match) {
                values[match[1]] = parseInt(match[2], 10) * 1024
            }
        }

        const total = values.MemTotal || 0
        const free = values.MemFree || 0
        const available = values.MemAvailable || 0
        const buffers = values.Buffers || 0
        const cached = values.Cached || 0
        const used = total - available
        const usagePercent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0

        return { total, free, available, buffers, cached, used, usagePercent }
    }

    private parseDiskInfo (data: string): DiskInfo[] {
        const lines = data.split('\n').slice(1)
        const disks: DiskInfo[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            const parts = trimmed.split(/\s+/)
            if (parts.length < 6) continue

            const mountedOn = parts.slice(5, parts.length - 1).join(' ') || parts[parts.length - 1]
            const filesystem = parts[0]
            const size = this.parseSize(parts[1])
            const used = this.parseSize(parts[2])
            const available = this.parseSize(parts[3])
            const usagePercent = used + available > 0
                ? Math.round(1000 * used / (used + available)) / 10
                : parseInt(parts[parts.length - 2].replace('%', ''), 10) || 0

            if (filesystem.includes('tmpfs') || filesystem.includes('devtmpfs') ||
                filesystem.includes('overlay') || filesystem.includes('squashfs')) {
                continue
            }

            if (mountedOn !== '/' && mountedOn !== '/boot' &&
                !mountedOn.startsWith('/mnt/')) continue

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

    private parseNetworkInfo (data: string): NetworkInterface[] {
        const lines = data.split('\n').slice(2)
        let rxBytes = 0
        let txBytes = 0
        let rxPackets = 0
        let txPackets = 0
        let rxErrors = 0
        let txErrors = 0
        let hasInterface = false

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('lo:')) continue

            const match = trimmed.match(/^(\w+):\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/)
            if (!match) continue

            hasInterface = true
            rxBytes += parseInt(match[2], 10) || 0
            rxPackets += parseInt(match[3], 10) || 0
            rxErrors += parseInt(match[4], 10) || 0
            txBytes += parseInt(match[10], 10) || 0
            txPackets += parseInt(match[11], 10) || 0
            txErrors += parseInt(match[12], 10) || 0
        }

        if (!hasInterface) return []

        const previous = this.previousNetworkStats.get('total')
        const elapsedSeconds = previous ? Math.max((Date.now() - previous.timestamp) / 1000, 1) : 0
        const rxSpeed = previous ? Math.max(0, rxBytes - previous.rxBytes) / elapsedSeconds : 0
        const txSpeed = previous ? Math.max(0, txBytes - previous.txBytes) / elapsedSeconds : 0
        this.previousNetworkStats.set('total', { rxBytes, txBytes, timestamp: Date.now() })

        return [{
            name: '总计',
            rxSpeed: Math.round(rxSpeed),
            txSpeed: Math.round(txSpeed),
            rxBytes,
            txBytes,
            rxPackets,
            txPackets,
            rxErrors,
            txErrors,
        }]
    }

    private parseUptime (data: string): string {
        const seconds = parseFloat(data.trim().split(' ')[0])
        if (isNaN(seconds)) return ''

        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)

        const parts: string[] = []
        if (days > 0) parts.push(`${days}天`)
        if (hours > 0) parts.push(`${hours}小时`)
        if (minutes > 0) parts.push(`${minutes}分钟`)

        return parts.join(' ') || '< 1分钟'
    }

    private parseLoadAverage (data: string): string[] {
        return data.trim().split(' ').slice(0, 3)
    }

    formatBytes (bytes: number): string {
        if (bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
    }

    formatBytesPerSecond (bytes: number): string {
        return `${this.formatBytes(bytes)}/s`
    }

    getProgressBarClass (percent: number): string {
        if (percent < 50) return 'bg-success'
        if (percent < 80) return 'bg-warning'
        return 'bg-danger'
    }
}
