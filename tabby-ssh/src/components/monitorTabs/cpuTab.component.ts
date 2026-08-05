import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core'
import { SSHSession } from '../../session/ssh'
import * as russh from 'russh'

interface CPUHistoryPoint {
    timestamp: number
    usagePercent: number
}

interface ProcessInfo {
    pid: number
    user: string
    cpu: number
    mem: number
    command: string
}

@Component({
    selector: 'cpu-tab',
    templateUrl: './cpuTab.component.pug',
    styleUrls: ['./cpuTab.component.scss'],
})
export class CpuTabComponent implements OnInit, OnDestroy, AfterViewInit {
    @Input() session: SSHSession
    @ViewChild('trendCanvas') trendCanvasRef: ElementRef<HTMLCanvasElement>

    loading = true
    error: string|null = null
    fetching = false

    // CPU数据
    cores = 0
    usagePercent = 0
    loadAverage: string[] = []
    temperature: string|null = null
    userProcesses = 0
    systemProcesses = 0
    totalProcesses = 0

    // 进程列表
    topProcesses: ProcessInfo[] = []

    // 历史数据（60秒）
    history: CPUHistoryPoint[] = []
    private maxHistoryPoints = 60

    // 静态缓存
    private static cachedData: {
        cores: number
        usagePercent: number
        loadAverage: string[]
        temperature: string|null
        userProcesses: number
        systemProcesses: number
        totalProcesses: number
        history: CPUHistoryPoint[]
        previousCPUStats: Map<number, {
            user: number, nice: number, system: number, idle: number,
            iowait: number, irq: number, softirq: number, steal: number
        }>
        topProcesses: ProcessInfo[]
    }|null = null
    private static cachedAt = 0
    private static readonly CACHE_TTL = 30000

    private updateTimer: any
    private previousCPUStats: Map<number, {
        user: number, nice: number, system: number, idle: number,
        iowait: number, irq: number, softirq: number, steal: number
    }> = new Map()

    private static readonly CPU_COMMAND = [
        'echo "@@TABBY_CPU_STAT@@"; cat /proc/stat',
        'echo "@@TABBY_CPU_LOAD@@"; cat /proc/loadavg',
        'echo "@@TABBY_CPU_TEMP@@"; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null || echo "N/A"',
        'echo "@@TABBY_CPU_PROC@@"; ps -eo stat | grep -c "^R" 2>/dev/null || echo "0"; ps -eo stat | grep -c "^S" 2>/dev/null || echo "0"; ps -eo stat | grep -c "^[RDSTt]" 2>/dev/null || echo "0"',
        'echo "@@TABBY_CPU_TOP@@"; ps -eo pid,user:16,pcpu,pmem,comm,args --sort=-pcpu | head -n 11',
    ].join('; ')

    async ngOnInit (): Promise<void> {
        // 如果有缓存且未过期，先显示缓存
        if (CpuTabComponent.cachedData &&
            Date.now() - CpuTabComponent.cachedAt < CpuTabComponent.CACHE_TTL) {
            const cache = CpuTabComponent.cachedData
            this.cores = cache.cores
            this.usagePercent = cache.usagePercent
            this.loadAverage = cache.loadAverage
            this.temperature = cache.temperature
            this.userProcesses = cache.userProcesses
            this.systemProcesses = cache.systemProcesses
            this.totalProcesses = cache.totalProcesses
            this.topProcesses = [...cache.topProcesses]
            this.history = [...cache.history]
            // 恢复previousCPUStats
            if (cache.previousCPUStats) {
                this.previousCPUStats = new Map(cache.previousCPUStats)
            }
            this.loading = false
            // 延迟重绘图表
            setTimeout(() => this.drawChart(), 0)
        }

        // 触发数据获取
        await this.fetchStats()
        this.updateTimer = setInterval(() => this.fetchStats(), 3000)
    }

    ngOnDestroy (): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer)
        }
    }

    ngAfterViewInit (): void {
        this.drawChart()
    }

    async fetchStats (): Promise<void> {
        if (this.fetching) return
        this.fetching = true

        try {
            const output = await this.executeCommand(CpuTabComponent.CPU_COMMAND)
            const sections = this.parseSections(output)

            if (sections.stat) {
                const cpuInfo = this.parseCPUInfo(sections.stat)
                this.cores = cpuInfo.cores
                this.usagePercent = cpuInfo.usagePercent

                // 添加到历史数据
                this.history.push({
                    timestamp: Date.now(),
                    usagePercent: cpuInfo.usagePercent,
                })

                // 限制历史数据长度
                if (this.history.length > this.maxHistoryPoints) {
                    this.history = this.history.slice(-this.maxHistoryPoints)
                }

                // 重绘图表
                this.drawChart()
            }

            if (sections.load) {
                this.loadAverage = sections.load.trim().split(' ').slice(0, 3)
            }

            if (sections.temp) {
                this.temperature = this.parseTemperature(sections.temp)
            }

            if (sections.proc) {
                const procLines = sections.proc.trim().split('\n').filter(l => l)
                if (procLines.length >= 3) {
                    this.userProcesses = parseInt(procLines[0], 10) || 0
                    this.systemProcesses = parseInt(procLines[1], 10) || 0
                    this.totalProcesses = parseInt(procLines[2], 10) || 0
                }
            }

            if (sections.top) {
                this.topProcesses = this.parseTopProcesses(sections.top)
            }

            this.loading = false
            this.error = null

            // 更新缓存
            CpuTabComponent.cachedData = {
                cores: this.cores,
                usagePercent: this.usagePercent,
                loadAverage: this.loadAverage,
                temperature: this.temperature,
                userProcesses: this.userProcesses,
                systemProcesses: this.systemProcesses,
                totalProcesses: this.totalProcesses,
                history: [...this.history],
                previousCPUStats: new Map(this.previousCPUStats),
                topProcesses: [...this.topProcesses],
            }
            CpuTabComponent.cachedAt = Date.now()
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
            const match = /^@@TABBY_CPU_(\w+)@@\s*$/.exec(line)
            if (match) {
                current = match[1].toLowerCase()
                sections[current] = ''
            } else if (current) {
                sections[current] += line + '\n'
            }
        }

        return sections
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
            const stats = {
                user: parseInt(parts[1], 10) || 0,
                nice: parseInt(parts[2], 10) || 0,
                system: parseInt(parts[3], 10) || 0,
                idle: parseInt(parts[4], 10) || 0,
                iowait: parseInt(parts[5], 10) || 0,
                irq: parseInt(parts[6], 10) || 0,
                softirq: parseInt(parts[7], 10) || 0,
                steal: parseInt(parts[8], 10) || 0,
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

    private parseTemperature (data: string): string|null {
        const lines = data.trim().split('\n').filter(l => l && l !== 'N/A')
        if (lines.length === 0) return null

        // 取第一个温度值，通常以毫摄氏度为单位
        const temp = parseInt(lines[0], 10)
        if (isNaN(temp)) return null

        // 如果是毫摄氏度（大于1000），转换为摄氏度
        if (temp > 1000) {
            return `${(temp / 1000).toFixed(1)}°C`
        }
        return `${temp}°C`
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

    // Canvas图表绘制
    drawChart (): void {
        const canvas = this.trendCanvasRef?.nativeElement
        if (!canvas || this.history.length < 2) return

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // 使用 clientWidth/clientHeight 获取可靠尺寸
        const w = canvas.clientWidth
        const h = canvas.clientHeight
        if (w === 0 || h === 0) return

        // 处理高DPI
        const dpr = window.devicePixelRatio || 1
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)

        const padding = { top: 20, right: 20, bottom: 30, left: 40 }
        const chartW = w - padding.left - padding.right
        const chartH = h - padding.top - padding.bottom

        // 读取主题色
        const computedStyle = getComputedStyle(canvas)
        const primaryColor = computedStyle.getPropertyValue('--theme-primary').trim() || '#0d6efd'
        const fgColor = computedStyle.getPropertyValue('--theme-fg').trim() || '#fff'
        const gridColor = computedStyle.getPropertyValue('--theme-bg-more-2').trim() || 'rgba(255,255,255,0.1)'

        ctx.clearRect(0, 0, w, h)

        // 绘制网格线
        ctx.strokeStyle = gridColor
        ctx.lineWidth = 1

        // Y轴网格线（0%, 25%, 50%, 75%, 100%）
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (i / 4) * chartH
            ctx.beginPath()
            ctx.moveTo(padding.left, y)
            ctx.lineTo(w - padding.right, y)
            ctx.stroke()

            // Y轴标签
            ctx.fillStyle = fgColor
            ctx.font = '11px sans-serif'
            ctx.textAlign = 'right'
            ctx.textBaseline = 'middle'
            ctx.fillText(`${100 - i * 25}%`, padding.left - 8, y)
        }

        // X轴标签（时间）
        const timeLabels = 5
        for (let i = 0; i < timeLabels; i++) {
            const x = padding.left + (i / (timeLabels - 1)) * chartW
            const dataIndex = Math.floor((i / (timeLabels - 1)) * (this.history.length - 1))
            const point = this.history[dataIndex]
            if (point) {
                const date = new Date(point.timestamp)
                const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
                ctx.fillStyle = fgColor
                ctx.font = '10px sans-serif'
                ctx.textAlign = 'center'
                ctx.textBaseline = 'top'
                ctx.fillText(timeStr, x, h - padding.bottom + 8)
            }
        }

        // 绘制渐变填充区域（使用贝塞尔曲线）
        const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom)
        gradient.addColorStop(0, this.hexToRgba(primaryColor, 0.3))
        gradient.addColorStop(1, this.hexToRgba(primaryColor, 0.0))

        ctx.beginPath()
        ctx.moveTo(padding.left, h - padding.bottom)
        this.drawSmoothCurve(ctx, this.history, padding, chartW, chartH, h, false)
        ctx.lineTo(w - padding.right, h - padding.bottom)
        ctx.closePath()
        ctx.fillStyle = gradient
        ctx.fill()

        // 绘制平滑曲线
        ctx.beginPath()
        this.drawSmoothCurve(ctx, this.history, padding, chartW, chartH, h, true)
        ctx.strokeStyle = primaryColor
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.stroke()
    }

    private drawSmoothCurve (
        ctx: CanvasRenderingContext2D,
        history: CPUHistoryPoint[],
        padding: { top: number, right: number, bottom: number, left: number },
        chartW: number,
        chartH: number,
        h: number,
        strokeOnly: boolean
    ): void {
        if (history.length === 0) return

        const points = history.map((point, i) => ({
            x: padding.left + (i / (history.length - 1)) * chartW,
            y: padding.top + (1 - point.usagePercent / 100) * chartH,
        }))

        if (points.length === 1) {
            ctx.lineTo(points[0].x, points[0].y)
            return
        }

        // 使用三次贝塞尔曲线拟合
        ctx.moveTo(points[0].x, points[0].y)

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[Math.max(0, i - 1)]
            const p1 = points[i]
            const p2 = points[i + 1]
            const p3 = points[Math.min(points.length - 1, i + 2)]

            const cp1x = p1.x + (p2.x - p0.x) / 6
            const cp1y = p1.y + (p2.y - p0.y) / 6
            const cp2x = p2.x - (p3.x - p1.x) / 6
            const cp2y = p2.y - (p3.y - p1.y) / 6

            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
        }
    }

    private hexToRgba (hex: string, alpha: number): string {
        // 处理CSS变量可能返回的rgb格式
        if (hex.startsWith('rgb')) {
            return hex.replace('rgb', 'rgba').replace(')', `, ${alpha})`)
        }

        // 处理hex
        let r = 0, g = 0, b = 0
        if (hex.startsWith('#')) {
            if (hex.length === 4) {
                r = parseInt(hex[1] + hex[1], 16)
                g = parseInt(hex[2] + hex[2], 16)
                b = parseInt(hex[3] + hex[3], 16)
            } else if (hex.length === 7) {
                r = parseInt(hex.slice(1, 3), 16)
                g = parseInt(hex.slice(3, 5), 16)
                b = parseInt(hex.slice(5, 7), 16)
            }
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }

    private parseTopProcesses (data: string): ProcessInfo[] {
        const lines = data.trim().split('\n').filter(l => l)
        const processes: ProcessInfo[] = []

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line) continue

            const parts = line.trim().split(/\s+/)
            if (parts.length < 5) continue

            const pid = parseInt(parts[0], 10)
            const user = parts[1] || ''
            const cpu = parseFloat(parts[2]) || 0
            const mem = parseFloat(parts[3]) || 0
            const command = parts[4] || ''

            processes.push({ pid, user, cpu, mem, command })
        }

        return processes
    }

    getProgressBarClass (percent: number): string {
        if (percent < 50) return 'bg-success'
        if (percent < 80) return 'bg-warning'
        return 'bg-danger'
    }

    async killProcess (pid: number): Promise<void> {
        if (!confirm(`确定要终止进程 ${pid} 吗？`)) {
            return
        }

        try {
            await this.executeCommand(`kill -9 ${pid}`)
            // 从列表中移除
            this.topProcesses = this.topProcesses.filter(p => p.pid !== pid)
        } catch (err) {
            alert(`终止进程失败: ${err.message}`)
        }
    }
}
