import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core'
import { SSHSession } from '../session/ssh'
import { ServerStats } from './monitorTabs/overviewTab.component'

interface MonitorTab {
    id: string
    label: string
    icon: string
}

@Component({
    selector: 'server-monitor-panel',
    templateUrl: './serverMonitorPanel.component.pug',
    styleUrls: ['./serverMonitorPanel.component.scss'],
})
export class ServerMonitorPanelComponent implements OnInit, OnDestroy {
    @Input() session: SSHSession
    @Output() closed = new EventEmitter<void>()

    activeTab = 'overview'

    tabs: MonitorTab[] = [
        { id: 'overview', label: '总览', icon: 'fa-server' },
        { id: 'cpu', label: '处理器', icon: 'fa-microchip' },
        { id: 'memory', label: '内存', icon: 'fa-memory' },
        { id: 'disk', label: '磁盘', icon: 'fa-hdd' },
        { id: 'network', label: '网络', icon: 'fa-network-wired' },
    ]

    // 共享数据
    stats: ServerStats|null = null
    cpuHistory: { timestamp: number, usagePercent: number }[] = []

    // 占位组件数据（为后续扩展预留）
    memoryData: any = null
    diskData: any = null
    networkHistory: { rx: number, tx: number, timestamp: number }[] = []

    ngOnInit (): void {
        // 面板初始化
    }

    ngOnDestroy (): void {
        // 清理工作
    }

    switchTab (tabId: string): void {
        this.activeTab = tabId
    }

    onTabWheel (event: WheelEvent): void {
        const container = event.currentTarget as HTMLElement
        if (!container) return
        // 阻止默认滚动行为
        event.preventDefault()
        // 将纵向滚轮转换为横向滚动
        container.scrollLeft += event.deltaY
    }

    onStatsUpdated (stats: ServerStats): void {
        this.stats = stats
        // 同步更新CPU历史数据
        if (stats?.cpu) {
            this.cpuHistory.push({
                timestamp: Date.now(),
                usagePercent: stats.cpu.usagePercent,
            })
            if (this.cpuHistory.length > 60) {
                this.cpuHistory = this.cpuHistory.slice(-60)
            }
        }
    }

    close (): void {
        this.closed.emit()
    }
}
