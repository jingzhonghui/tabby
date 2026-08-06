import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core'
import { SSHSession } from '../../session/ssh'
import * as russh from 'russh'

interface NetworkHistoryPoint {
    timestamp: number
    rxSpeed: number
    txSpeed: number
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

@Component({
    selector: 'network-tab',
    templateUrl: './networkTab.component.pug',
    styleUrls: ['./networkTab.component.scss'],
})
export class NetworkTabComponent implements OnInit, OnDestroy, AfterViewInit {
    @Input() session: SSHSession
    @ViewChild('trendCanvas') trendCanvasRef: ElementRef<HTMLCanvasElement>

    loading = true
    error: string|null = null
    fetching = false
    fetchAttempts = 0

    // 网络数据
    interfaces: NetworkInterface[] = []
    totalRxSpeed = 0
    totalTxSpeed = 0
    totalRxBytes = 0
    totalTxBytes = 0

    // 历史数据（60秒）
    history: NetworkHistoryPoint[] = []
    private maxHistoryPoints = 60

    // 静态缓存
    private static cachedData: {
        interfaces: NetworkInterface[]
        totalRxSpeed: number
        totalTxSpeed: number
        totalRxBytes: number
        totalTxBytes: number
        history: NetworkHistoryPoint[]
    }|null = null
    private static cachedAt = 0
    private static readonly CACHE_TTL = 300000

    private updateTimer: any
    private previousNetworkStats: Map<string, { rxBytes: number, txBytes: number, timestamp: number }> = new Map()

    private static readonly NETWORK_COMMAND = 'cat /proc/net/dev'

    async ngOnInit (): Promise<void> {
        // 如果有缓存且未过期，先显示缓存
        if (NetworkTabComponent.cachedData &&
            Date.now() - NetworkTabComponent.cachedAt < NetworkTabComponent.CACHE_TTL) {
            const cache = NetworkTabComponent.cachedData
            this.interfaces = [...cache.interfaces]
            this.totalRxSpeed = cache.totalRxSpeed
            this.totalTxSpeed = cache.totalTxSpeed
            this.totalRxBytes = cache.totalRxBytes
            this.totalTxBytes = cache.totalTxBytes
            this.history = [...cache.history]
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
        this.fetchAttempts++

        try {
            const output = await this.executeCommand(NetworkTabComponent.NETWORK_COMMAND)
            const newInterfaces = this.parseNetworkInfo(output)
            if (newInterfaces.length > 0) {
                this.interfaces = newInterfaces
            }

            // 计算总计
            this.totalRxSpeed = this.interfaces.reduce((sum, i) => sum + i.rxSpeed, 0)
            this.totalTxSpeed = this.interfaces.reduce((sum, i) => sum + i.txSpeed, 0)
            this.totalRxBytes = this.interfaces.reduce((sum, i) => sum + i.rxBytes, 0)
            this.totalTxBytes = this.interfaces.reduce((sum, i) => sum + i.txBytes, 0)

            // 添加到历史数据
            this.history.push({
                timestamp: Date.now(),
                rxSpeed: this.totalRxSpeed,
                txSpeed: this.totalTxSpeed,
            })

            // 限制历史数据长度
            if (this.history.length > this.maxHistoryPoints) {
                this.history = this.history.slice(-this.maxHistoryPoints)
            }

            // 重绘图表（延迟确保 canvas 已渲染）
            setTimeout(() => this.drawChart(), 0)

            this.loading = false
            this.error = null

            // 更新缓存
            NetworkTabComponent.cachedData = {
                interfaces: [...this.interfaces],
                totalRxSpeed: this.totalRxSpeed,
                totalTxSpeed: this.totalTxSpeed,
                totalRxBytes: this.totalRxBytes,
                totalTxBytes: this.totalTxBytes,
                history: [...this.history],
            }
            NetworkTabComponent.cachedAt = Date.now()
        } catch (err) {
            this.error = err.message
            this.loading = false
        } finally {
            this.fetching = false
        }
    }

    private parseNetworkInfo (data: string): NetworkInterface[] {
        const lines = data.split('\n').slice(2)
        const interfaces: NetworkInterface[] = []
        let totalRxBytes = 0
        let totalTxBytes = 0
        let totalRxPackets = 0
        let totalTxPackets = 0
        let totalRxErrors = 0
        let totalTxErrors = 0
        let hasInterface = false

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('lo:')) continue

            const match = trimmed.match(/^(\w+):\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/)
            if (!match) continue

            hasInterface = true
            const rxBytes = parseInt(match[2], 10) || 0
            const rxPackets = parseInt(match[3], 10) || 0
            const rxErrors = parseInt(match[4], 10) || 0
            const txBytes = parseInt(match[10], 10) || 0
            const txPackets = parseInt(match[11], 10) || 0
            const txErrors = parseInt(match[12], 10) || 0

            totalRxBytes += rxBytes
            totalTxBytes += txBytes
            totalRxPackets += rxPackets
            totalTxPackets += txPackets
            totalRxErrors += rxErrors
            totalTxErrors += txErrors
        }

        if (!hasInterface) return []

        const previous = this.previousNetworkStats.get('total')
        const elapsedSeconds = previous ? Math.max((Date.now() - previous.timestamp) / 1000, 1) : 0
        const rxSpeed = previous ? Math.max(0, totalRxBytes - previous.rxBytes) / elapsedSeconds : 0
        const txSpeed = previous ? Math.max(0, totalTxBytes - previous.txBytes) / elapsedSeconds : 0
        this.previousNetworkStats.set('total', { rxBytes: totalRxBytes, txBytes: totalTxBytes, timestamp: Date.now() })

        interfaces.push({
            name: '总计',
            rxSpeed: Math.round(rxSpeed),
            txSpeed: Math.round(txSpeed),
            rxBytes: totalRxBytes,
            txBytes: totalTxBytes,
            rxPackets: totalRxPackets,
            txPackets: totalTxPackets,
            rxErrors: totalRxErrors,
            txErrors: totalTxErrors,
        })

        return interfaces
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

        // 计算最大值用于归一化
        const maxValue = Math.max(
            ...this.history.map(p => Math.max(p.rxSpeed, p.txSpeed)),
            1
        )

        // 绘制RX渐变填充区域（使用贝塞尔曲线）
        const rxGradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom)
        rxGradient.addColorStop(0, this.hexToRgba(primaryColor, 0.3))
        rxGradient.addColorStop(1, this.hexToRgba(primaryColor, 0.0))

        ctx.beginPath()
        ctx.moveTo(padding.left, h - padding.bottom)
        this.drawSmoothCurve(ctx, this.history, padding, chartW, chartH, h, false, maxValue, 'rx')
        ctx.lineTo(w - padding.right, h - padding.bottom)
        ctx.closePath()
        ctx.fillStyle = rxGradient
        ctx.fill()

        // 绘制RX平滑曲线
        ctx.beginPath()
        this.drawSmoothCurve(ctx, this.history, padding, chartW, chartH, h, true, maxValue, 'rx')
        ctx.strokeStyle = primaryColor
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.stroke()

        // 绘制TX平滑曲线
        ctx.beginPath()
        this.drawSmoothCurve(ctx, this.history, padding, chartW, chartH, h, true, maxValue, 'tx')
        ctx.strokeStyle = '#28a745'
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.stroke()
    }

    private drawSmoothCurve (
        ctx: CanvasRenderingContext2D,
        history: NetworkHistoryPoint[],
        padding: { top: number, right: number, bottom: number, left: number },
        chartW: number,
        chartH: number,
        h: number,
        strokeOnly: boolean,
        maxValue: number,
        field: 'rx' | 'tx'
    ): void {
        if (history.length === 0) return

        const points = history.map((point, i) => ({
            x: padding.left + (i / (history.length - 1)) * chartW,
            y: padding.top + (1 - (field === 'rx' ? point.rxSpeed : point.txSpeed) / maxValue) * chartH,
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

    trackByName (_index: number, iface: NetworkInterface): string {
        return iface.name
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
