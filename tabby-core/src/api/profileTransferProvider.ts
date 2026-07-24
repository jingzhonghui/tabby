import { Injectable } from '@angular/core'

export interface ProfileImportResult {
    imported: number
    skipped: number
    errors: string[]
}

export interface ProfileExportResult {
    name: string
    content: Uint8Array
    exported: number
    warnings: string[]
}

@Injectable()
export abstract class ProfileTransferProvider {
    abstract id: string
    abstract name: string

    abstract importProfiles (content: Uint8Array): Promise<ProfileImportResult>
    abstract exportProfiles (includeSecrets: boolean): Promise<ProfileExportResult>
}
