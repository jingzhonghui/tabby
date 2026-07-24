import * as crypto from 'crypto'
import { Injectable } from '@angular/core'
import { ConfigService, FileProvidersService, PartialProfile, ProfileGroup, ProfileImportResult, ProfileExportResult, ProfilesService, ProfileTransferProvider, VaultService, VAULT_SECRET_TYPE_FILE } from 'tabby-core'
import { SSHProfile } from './api'
import { PasswordStorageService } from './services/passwordStorage.service'

/* eslint-disable @typescript-eslint/no-use-before-define */

const SAFE_COLUMNS = ['主机名称', '协议', '主机地址', '端口', '用户名', '认证方式', '分组']
const SECRET_COLUMNS = ['主机名称', '协议', '主机地址', '端口', '用户名', '密码', '认证方式', '私钥内容', '私钥密码', '分组']

interface CSVRow {
    line: number
    values: Record<string, string|undefined>
}

interface ImportCandidate {
    line: number
    profile: PartialProfile<SSHProfile>
    groupPath: string[]
    password: string
    privateKey: string
    privateKeyPassword: string
}

interface EnsuredGroup {
    id?: string
    createdIds: string[]
}

@Injectable({ providedIn: 'root' })
export class SSHProfileTransferProvider extends ProfileTransferProvider {
    id = 'ssh-csv'
    name = 'SSH CSV'

    constructor (
        private config: ConfigService,
        private profiles: ProfilesService,
        private passwordStorage: PasswordStorageService,
        private fileProviders: FileProvidersService,
        private vault: VaultService,
    ) {
        super()
    }

    async importProfiles (content: Uint8Array): Promise<ProfileImportResult> {
        const rows = parseCSV(Buffer.from(content).toString('utf8'))
        const errors: string[] = []
        const candidates: ImportCandidate[] = []
        const existingKeys = new Set<string>()

        for (const profile of await this.profiles.getProfiles({ includeBuiltin: false })) {
            if (profile.type === 'ssh') {
                existingKeys.add(this.connectionKey(this.profiles.getConfigProxyForProfile(profile as PartialProfile<SSHProfile>)))
            }
        }

        let skipped = 0
        for (const row of rows) {
            try {
                const candidate = this.rowIntoCandidate(row)
                const key = this.connectionKey(this.profiles.getConfigProxyForProfile(candidate.profile))
                if (existingKeys.has(key)) {
                    skipped++
                    continue
                }
                candidates.push(candidate)
            } catch (e) {
                errors.push(`第 ${row.line} 行：${errorMessage(e)}`)
            }
        }

        const groupIds = await this.buildGroupMap()
        let imported = 0
        for (const candidate of candidates) {
            const key = this.connectionKey(this.profiles.getConfigProxyForProfile(candidate.profile))
            if (existingKeys.has(key)) {
                skipped++
                continue
            }

            let privateKeyId: string|undefined = undefined
            let privateKeyHash: string|undefined = undefined
            let passwordStored = false
            let ensuredGroup: EnsuredGroup = { createdIds: [] }
            try {
                const profile = candidate.profile

                if (candidate.privateKey) {
                    privateKeyId = crypto.randomBytes(32).toString('hex')
                    await this.vault.addSecret({
                        type: VAULT_SECRET_TYPE_FILE,
                        key: { id: privateKeyId, description: `private key for ${profile.name}` },
                        value: Buffer.from(candidate.privateKey).toString('base64'),
                    })
                    profile.options!.privateKeys = [`vault://${privateKeyId}`]
                    if (candidate.privateKeyPassword) {
                        privateKeyHash = crypto.createHash('sha512').update(candidate.privateKey).digest('hex')
                        await this.passwordStorage.savePrivateKeyPassword(privateKeyHash, candidate.privateKeyPassword)
                    }
                }

                if (candidate.password) {
                    await this.passwordStorage.savePassword(this.profiles.getConfigProxyForProfile(profile), candidate.password)
                    passwordStored = true
                }

                ensuredGroup = await this.ensureGroup(candidate.groupPath, groupIds)
                profile.group = ensuredGroup.id
                if (!profile.group) { delete profile.group }
                await this.profiles.newProfile(profile)
                existingKeys.add(key)
                imported++
            } catch (e) {
                if (passwordStored) {
                    await this.passwordStorage.deletePassword(this.profiles.getConfigProxyForProfile(candidate.profile)).catch(() => undefined)
                }
                if (privateKeyHash) {
                    await this.passwordStorage.deletePrivateKeyPassword(privateKeyHash).catch(() => undefined)
                }
                if (privateKeyId) {
                    await this.vault.removeSecret(VAULT_SECRET_TYPE_FILE, { id: privateKeyId }).catch(() => undefined)
                }
                this.removeEmptyGroups(ensuredGroup.createdIds, groupIds)
                errors.push(`第 ${candidate.line} 行：${errorMessage(e)}`)
            }
        }

        if (imported) {
            await this.config.save()
        }
        return { imported, skipped, errors }
    }

    async exportProfiles (includeSecrets: boolean): Promise<ProfileExportResult> {
        const rows: string[][] = []
        const warnings: string[] = []
        const profiles = (await this.profiles.getProfiles({ includeBuiltin: false }))
            .filter(profile => profile.type === 'ssh')

        for (const partial of profiles) {
            const profile = this.profiles.getConfigProxyForProfile(partial as PartialProfile<SSHProfile>)
            let password = ''
            let privateKey = ''
            let privateKeyPassword = ''

            if (includeSecrets) {
                try {
                    password = await this.passwordStorage.loadPassword(profile) ?? profile.options.password ?? ''
                } catch (e) {
                    warnings.push(`${profile.name}：无法读取密码（${errorMessage(e)}）`)
                }

                if (profile.options.privateKeys.length > 1) {
                    warnings.push(`${profile.name}：存在多个私钥，仅导出第一个`)
                }
                const keyRef = profile.options.privateKeys[0]
                if (keyRef) {
                    try {
                        privateKey = (await this.fileProviders.retrieveFile(keyRef)).toString('utf8')
                        const hash = crypto.createHash('sha512').update(privateKey).digest('hex')
                        privateKeyPassword = await this.passwordStorage.loadPrivateKeyPassword(hash) ?? ''
                    } catch (e) {
                        warnings.push(`${profile.name}：无法读取私钥（${errorMessage(e)}）`)
                    }
                }
            }

            const common = [
                profile.name,
                'SSH',
                profile.options.host,
                `${profile.options.port ?? 22}`,
                profile.options.user,
            ]
            rows.push(includeSecrets ? [
                ...common,
                password,
                authToCSV(profile.options.auth),
                privateKey,
                privateKeyPassword,
                serializeGroupPath(this.profiles.resolveProfileGroupPath(profile.group ?? '')),
            ] : [
                ...common,
                authToCSV(profile.options.auth),
                serializeGroupPath(this.profiles.resolveProfileGroupPath(profile.group ?? '')),
            ])
        }

        const columns = includeSecrets ? SECRET_COLUMNS : SAFE_COLUMNS
        const csv = `\uFEFF${serializeCSV([columns, ...rows])}`
        const suffix = includeSecrets ? 'with_secrets' : 'safe'
        return {
            name: `tabby_hosts_${suffix}_${formatDate(new Date())}.csv`,
            content: Buffer.from(csv, 'utf8'),
            exported: rows.length,
            warnings,
        }
    }

    private rowIntoCandidate (row: CSVRow): ImportCandidate {
        const protocol = value(row, '协议').toUpperCase()
        if (protocol !== 'SSH') {
            throw new Error(`不支持协议“${protocol || '(空)'}”`)
        }

        const name = value(row, '主机名称')
        const host = value(row, '主机地址')
        const user = value(row, '用户名')
        if (!name) { throw new Error('主机名称不能为空') }
        if (!host) { throw new Error('主机地址不能为空') }
        if (!user) { throw new Error('用户名不能为空') }

        const portText = value(row, '端口')
        const port = portText ? Number(portText) : 22
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`端口“${portText}”无效`)
        }

        const auth = authFromCSV(value(row, '认证方式'))
        const privateKey = value(row, '私钥内容', false)
        if (privateKey && !this.vault.isEnabled()) {
            throw new Error('包含私钥内容，但尚未启用密码保险库')
        }

        return {
            line: row.line,
            profile: {
                type: 'ssh',
                name,
                options: {
                    host,
                    port,
                    user,
                    auth,
                    privateKeys: [],
                },
            },
            groupPath: splitGroupPath(value(row, '分组')),
            password: value(row, '密码', false),
            privateKey,
            privateKeyPassword: value(row, '私钥密码', false),
        }
    }

    private connectionKey (profile: SSHProfile): string {
        return `${profile.options.host.trim().toLowerCase()}\u0000${profile.options.port ?? 22}\u0000${profile.options.user.trim()}`
    }

    private async buildGroupMap (): Promise<Map<string, string>> {
        const result = new Map<string, string>()
        for (const group of await this.profiles.getProfileGroups()) {
            result.set(serializeGroupPath(this.profiles.resolveProfileGroupPath(group.id)), group.id)
        }
        return result
    }

    private async ensureGroup (path: string[], groups: Map<string, string>): Promise<EnsuredGroup> {
        let parentGroupId: string|undefined = undefined
        const currentPath: string[] = []
        const createdIds: string[] = []
        for (const name of path) {
            currentPath.push(name)
            const key = serializeGroupPath(currentPath)
            let id = groups.get(key)
            if (!id) {
                const group: Partial<ProfileGroup> & Pick<ProfileGroup, 'id'|'name'> = {
                    id: '',
                    name,
                    parentGroupId,
                    icon: 'far fa-folder',
                }
                await this.profiles.newProfileGroup(group)
                id = group.id
                groups.set(key, id)
                createdIds.push(id)
            }
            parentGroupId = id
        }
        return { id: parentGroupId, createdIds }
    }

    private removeEmptyGroups (createdIds: string[], groups: Map<string, string>): void {
        for (const id of [...createdIds].reverse()) {
            const inUse = this.config.store.profiles.some(profile => profile.group === id) ||
                this.config.store.groups.some(group => group.parentGroupId === id)
            if (!inUse) {
                this.config.store.groups = this.config.store.groups.filter(group => group.id !== id)
                for (const [path, groupId] of groups) {
                    if (groupId === id) { groups.delete(path) }
                }
            }
        }
    }
}

function value (row: CSVRow, column: string, trim = true): string {
    let result = row.values[column] ?? ''
    if (result.startsWith('\'\'')) {
        result = result.substring(1)
    } else if (/^'[\t\r\n]*[=+\-@]/.test(result)) {
        result = result.substring(1)
    }
    return trim ? result.trim() : result
}

function authFromCSV (csvValue: string): SSHProfile['options']['auth'] {
    switch (csvValue.trim().toUpperCase().replace(/[ -]/g, '_')) {
        case '':
        case 'PASSWORD': return 'password'
        case 'PUBLIC_KEY':
        case 'PUBLICKEY':
        case 'PRIVATE_KEY':
        case 'KEY': return 'publicKey'
        case 'AGENT': return 'agent'
        case 'KEYBOARD_INTERACTIVE': return 'keyboardInteractive'
        default: throw new Error(`认证方式“${csvValue}”无效`)
    }
}

function authToCSV (auth: SSHProfile['options']['auth']): string {
    switch (auth) {
        case 'publicKey': return 'PUBLIC_KEY'
        case 'agent': return 'AGENT'
        case 'keyboardInteractive': return 'KEYBOARD_INTERACTIVE'
        default: return 'PASSWORD'
    }
}

export function parseCSV (input: string): CSVRow[] {
    input = input.replace(/^\uFEFF/, '')
    const records: { line: number, fields: string[] }[] = []
    let fields: string[] = []
    let field = ''
    let quoted = false
    let closedQuote = false
    let line = 1
    let recordLine = 1

    for (let i = 0; i < input.length; i++) {
        const char = input[i]
        if (quoted) {
            if (char === '"' && input[i + 1] === '"') {
                field += '"'
                i++
            } else if (char === '"') {
                quoted = false
                closedQuote = true
            } else {
                field += char
                if (char === '\n') { line++ }
            }
        } else if (closedQuote && char !== ',' && char !== '\n' && char !== '\r') {
            throw new Error(`第 ${recordLine} 行：引号后的字符无效`)
        } else if (char === '"' && field === '') {
            quoted = true
        } else if (char === '"') {
            throw new Error(`第 ${recordLine} 行：字段中的引号无效`)
        } else if (char === ',') {
            fields.push(field)
            field = ''
            closedQuote = false
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && input[i + 1] === '\n') { i++ }
            fields.push(field)
            records.push({ line: recordLine, fields })
            fields = []
            field = ''
            closedQuote = false
            line++
            recordLine = line
        } else {
            field += char
        }
    }
    if (quoted) { throw new Error(`第 ${recordLine} 行：CSV 引号未闭合`) }
    if (field || fields.length) {
        fields.push(field)
        records.push({ line: recordLine, fields })
    }
    if (!records.length) { throw new Error('CSV 文件为空') }

    const headers = records[0].fields.map(x => x.trim())
    if (new Set(headers).size !== headers.length) {
        throw new Error('CSV 表头包含重复列')
    }
    for (const required of ['主机名称', '协议', '主机地址', '用户名']) {
        if (!headers.includes(required)) { throw new Error(`缺少必需列“${required}”`) }
    }

    for (const record of records.slice(1)) {
        if (record.fields.length !== headers.length) {
            throw new Error(`第 ${record.line} 行：列数与表头不一致`)
        }
    }

    return records.slice(1)
        .filter(record => record.fields.some(Boolean))
        .map(record => ({
            line: record.line,
            values: Object.fromEntries(headers.map((header, index) => [header, record.fields[index] ?? ''])),
        }))
}

export function serializeCSV (rows: string[][]): string {
    return rows.map((row, rowIndex) => row.map(field => {
        if (rowIndex > 0 && field.startsWith('\'')) {
            field = `'${field}`
        } else if (rowIndex > 0 && /^[\t\r\n]*[=+\-@]/.test(field)) {
            field = `'${field}`
        }
        if (/[",\r\n]/.test(field)) {
            return `"${field.replace(/"/g, '""')}"`
        }
        return field
    }).join(',')).join('\r\n') + '\r\n'
}

function splitGroupPath (path: string): string[] {
    const result: string[] = []
    let part = ''
    let escaped = false
    for (const char of path) {
        if (escaped) {
            part += char
            escaped = false
        } else if (char === '\\') {
            escaped = true
        } else if (char === '/') {
            if (part.trim()) { result.push(part.trim()) }
            part = ''
        } else {
            part += char
        }
    }
    if (escaped) { part += '\\' }
    if (part.trim()) { result.push(part.trim()) }
    return result
}

function serializeGroupPath (path: string[]): string {
    return path.map(part => part.replace(/\\/g, '\\\\').replace(/\//g, '\\/')).join('/')
}

function formatDate (date: Date): string {
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part, index) => index ? `${part}`.padStart(2, '0') : `${part}`)
        .join('-')
}

function errorMessage (error: unknown): string {
    return error instanceof Error ? error.message : `${error}`
}
