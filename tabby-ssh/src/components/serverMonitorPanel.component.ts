import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core'
import { SSHSession } from '../session/ssh'
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

interface ServerStats {
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
    selector: 'server-monitor-panel',
    templateUrl: './serverMonitorPanel.component.pug',
    styleUrls: ['./serverMonitorPanel.component.scss'],
})
export class ServerMonitorPanelComponent implements OnInit, OnDestroy {
    @Input() session: SSHSession
    @Output() closed = new EventEmitter<void>()

    stats: ServerStats|null = null
    loading = true
    error: string|null = null
    private updateTimer: any
    private previousCPUStats: Map<number, CPUStats> = new Map()
    private previousNetworkStats: Map<string, { rxBytes: number, txBytes: number }> = new Map()

    async ngOnInit (): Promise<void> {
        await this.fetchStats()
        this.updateTimer = setInterval(() => this.fetchStats(), 3000)
    }

    ngOnDestroy (): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer)
        }
    }

    async fetchStats (): Promise<void> {
        try {
            // Execute all commands in parallel with allSettled to handle partial failures
            const results = await Promise.allSettled([
                this.executeCommand('cat /proc/stat'),
                this.executeCommand('cat /proc/meminfo'),
                this.executeCommand('df -h'),
                this.executeCommand('cat /proc/net/dev'),
                this.executeCommand('cat /proc/uptime'),
                this.executeCommand('cat /proc/loadavg'),
            ])

            const [cpuInfo, memInfo, diskInfo, netInfo, uptimeInfo, loadInfo] = results

            // Build new stats incrementally, keeping old values if a command fails
            const newStats: ServerStats = {
                cpu: cpuInfo.status === 'fulfilled'
                    ? this.parseCPUInfo(cpuInfo.value)
                    : (this.stats?.cpu ?? { usagePercent: 0, cores: 0 }),
                memory: memInfo.status === 'fulfilled'
                    ? this.parseMemoryInfo(memInfo.value)
                    : (this.stats?.memory ?? { total: 0, free: 0, available: 0, buffers: 0, cached: 0, used: 0, usagePercent: 0 }),
                disks: diskInfo.status === 'fulfilled'
                    ? this.parseDiskInfo(diskInfo.value)
                    : (this.stats?.disks ?? []),
                network: netInfo.status === 'fulfilled'
                    ? this.parseNetworkInfo(netInfo.value)
                    : (this.stats?.network ?? []),
                uptime: uptimeInfo.status === 'fulfilled'
                    ? this.parseUptime(uptimeInfo.value)
                    : (this.stats?.uptime ?? ''),
                loadAverage: loadInfo.status === 'fulfilled'
                    ? this.parseLoadAverage(loadInfo.value)
                    : (this.stats?.loadAverage ?? []),
            }

            this.stats = newStats
            this.loading = false
            this.error = null
        } catch (err) {
            this.error = err.message
            this.loading = false
        }
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
                    // Ignore stderr for these commands
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

            // Safety timeout - if channel doesn't close within 5s, resolve with what we have
            setTimeout(() => {
                if (!closed) {
                    closed = true
                    dataSub.unsubscribe()
                    extDataSub.unsubscribe()
                    closeSub.unsubscribe()
                    resolve(output)
                }
            }, 5000)
        })
    }

    private parseCPUInfo (data: string): { usagePercent: number, cores: number } {
        const lines = data.split('\n').filter(l => l.startsWith('cpu'))
        const totalCores = lines.length - 1 // exclude 'cpu' (aggregate)

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
                // Aggregate CPU - skip for per-core calculation
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
                    const usagePercent = Math.round(((totalDiff - idleDiff) / totalDiff) * 100)
                    totalUsagePercent += usagePercent
                    validCores++
                }
            }

            this.previousCPUStats.set(coreNum, stats)
        }

        const usagePercent = validCores > 0 ? Math.round(totalUsagePercent / validCores) : 0
        return { usagePercent, cores: totalCores }
    }

    private parseMemoryInfo (data: string): MemoryStats {
        const lines = data.split('\n')
        const values: Record<string, number> = {}

        for (const line of lines) {
            const match = line.match(/^(\w+):\s+(\d+)/)
            if (match) {
                values[match[1]] = parseInt(match[2], 10) * 1024 // Convert kB to bytes
            }
        }

        const total = values.MemTotal || 0
        const free = values.MemFree || 0
        const available = values.MemAvailable || 0
        const buffers = values.Buffers || 0
        const cached = values.Cached || 0
        const used = total - available
        const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0

        return { total, free, available, buffers, cached, used, usagePercent }
    }

    private parseDiskInfo (data: string): DiskInfo[] {
        const lines = data.split('\n').slice(1) // Skip header
        const disks: DiskInfo[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            // Handle filesystem names with spaces (they're usually at the start)
            const parts = trimmed.split(/\s+/)
            if (parts.length < 6) continue

            // The last field is the mount point, the one before last is usage %
            // The first field could be a filesystem name with spaces
            const usagePercentStr = parts[parts.length - 2]
            const usagePercent = parseInt(usagePercentStr.replace('%', ''), 10) || 0
            const mountedOn = parts.slice(5, parts.length - 1).join(' ') || parts[parts.length - 1]
            const filesystem = parts[0]
            const size = this.parseSize(parts[1])
            const used = this.parseSize(parts[2])
            const available = this.parseSize(parts[3])

            // Skip pseudo filesystems
            if (filesystem.includes('tmpfs') || filesystem.includes('devtmpfs') ||
                filesystem.includes('overlay') || filesystem.includes('squashfs')) {
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

    private parseNetworkInfo (data: string): NetworkInterface[] {
        const lines = data.split('\n').slice(2) // Skip headers
        const interfaces: NetworkInterface[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('lo:')) continue

            const match = trimmed.match(/^(\w+):\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/)
            if (!match) continue

            const name = match[1]
            const rxBytes = parseInt(match[2], 10)
            const rxPackets = parseInt(match[3], 10)
            const rxErrors = parseInt(match[4], 10)
            const txBytes = parseInt(match[10], 10)
            const txPackets = parseInt(match[11], 10)
            const txErrors = parseInt(match[12], 10)

            const prevStats = this.previousNetworkStats.get(name)
            let rxSpeed = 0
            let txSpeed = 0

            if (prevStats) {
                // Calculate rate per second (we update every 3s)
                rxSpeed = Math.max(0, rxBytes - prevStats.rxBytes) / 3
                txSpeed = Math.max(0, txBytes - prevStats.txBytes) / 3
            }

            this.previousNetworkStats.set(name, { rxBytes, txBytes })

            // Only show interfaces with traffic or if we have previous stats
            if (prevStats || rxBytes > 0 || txBytes > 0) {
                interfaces.push({
                    name,
                    rxSpeed: Math.round(rxSpeed),
                    txSpeed: Math.round(txSpeed),
                    rxBytes,
                    txBytes,
                    rxPackets,
                    txPackets,
                    rxErrors,
                    txErrors,
                })
            }
        }

        return interfaces
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

    close (): void {
        this.closed.emit()
    }
}
