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
    fetching = false
    private updateTimer: any
    private previousCPUStats: Map<number, CPUStats> = new Map()
    private previousNetworkStats: Map<string, { rxBytes: number, txBytes: number, timestamp: number }> = new Map()

    // 单条命令拿全部数据，用分隔符切分各段，避免每轮开 6 个 SSH channel。
    // 分隔符必须加引号且不以 = 开头：zsh 会对开头的 = 做命令路径展开，
    // 展开失败会中止整条命令；stderr 无需重定向，channel 层已忽略。
    private static readonly MONITOR_COMMAND = [
        'echo "@@TABBY_MON_STAT@@"; cat /proc/stat',
        'echo "@@TABBY_MON_MEM@@"; cat /proc/meminfo',
        'echo "@@TABBY_MON_DF@@"; df -P -B1',
        'echo "@@TABBY_MON_NET@@"; cat /proc/net/dev',
        'echo "@@TABBY_MON_UPTIME@@"; cat /proc/uptime',
        'echo "@@TABBY_MON_LOAD@@"; cat /proc/loadavg',
    ].join('; ')

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
        // 避免慢速 SSH 请求与下一轮轮询重叠。
        if (this.fetching) return
        this.fetching = true

        try {
            const output = await this.executeCommand(ServerMonitorPanelComponent.MONITOR_COMMAND)
            const sections = this.parseSections(output)
            const prev = this.stats

            // 整段缺失说明远端 shell 没按预期执行，输出到控制台便于排查。
            if (!sections.stat && !sections.mem) {
                console.warn('[server-monitor] 无法解析监控输出:', output.slice(0, 500))
            }

            const parsedDisks = sections.df ? this.parseDiskInfo(sections.df) : []
            const parsedNetwork = sections.net ? this.parseNetworkInfo(sections.net) : []

            // 某一段缺失、为空或解析不出有效条目（输出被超时截断）时，保留上一次的有效数据。
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

            // Safety timeout - if channel doesn't close within 8s, resolve with what we have
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
                values[match[1]] = parseInt(match[2], 10) * 1024 // Convert kB to bytes
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
        const lines = data.split('\n').slice(1) // Skip header
        const disks: DiskInfo[] = []

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            // Handle filesystem names with spaces (they're usually at the start)
            const parts = trimmed.split(/\s+/)
            if (parts.length < 6) continue

            // df -P -B1 输出为字节数，用字节计算百分比可保留一位小数；
            // 与 df 的 Capacity 口径一致：used / (used + available)。
            const mountedOn = parts.slice(5, parts.length - 1).join(' ') || parts[parts.length - 1]
            const filesystem = parts[0]
            const size = this.parseSize(parts[1])
            const used = this.parseSize(parts[2])
            const available = this.parseSize(parts[3])
            const usagePercent = used + available > 0
                ? Math.round(1000 * used / (used + available)) / 10
                : parseInt(parts[parts.length - 2].replace('%', ''), 10) || 0

            // Skip pseudo filesystems
            if (filesystem.includes('tmpfs') || filesystem.includes('devtmpfs') ||
                filesystem.includes('overlay') || filesystem.includes('squashfs')) {
                continue
            }

            // 仅显示主分区、引导分区和 /mnt 下的数据分区。
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
        const lines = data.split('\n').slice(2) // Skip headers
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

    close (): void {
        this.closed.emit()
    }
}
