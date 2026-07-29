export type SemanticColor = 'error'|'warning'|'success'|'info'|'muted'|'accent'

export interface SemanticHighlight {
    start: number
    end: number
    color: SemanticColor
}

interface SemanticRule {
    pattern: RegExp
    color: SemanticColor
    priority: number
    capture?: number
}

const RULES: SemanticRule[] = [
    {
        pattern: /\b(?:fatal|panic|critical|crit|error|failed|failure|denied)\b/gi,
        color: 'error',
        priority: 100,
    },
    {
        pattern: /\b(?:warn|warning|deprecated)\b/gi,
        color: 'warning',
        priority: 90,
    },
    {
        pattern: /\b(?:success|succeeded|healthy|ready|started|running|passed|ok)\b/gi,
        color: 'success',
        priority: 80,
    },
    {
        pattern: /\binfo\b/gi,
        color: 'info',
        priority: 75,
    },
    {
        pattern: /\b(?:https?|ftp):\/\/[^\s"'<>]+/gi,
        color: 'accent',
        priority: 70,
    },
    {
        pattern: /(?:^|[\s="'(])((?:\/(?:[^\s/"'<>:]+))+\/?)/g,
        color: 'accent',
        priority: 65,
        capture: 1,
    },
    {
        pattern: /(?:^|[\s="'(])((?:[A-Za-z]:\\|\\\\)[^\s"'<>|]+)/g,
        color: 'accent',
        priority: 65,
        capture: 1,
    },
    {
        pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
        color: 'info',
        priority: 60,
    },
    {
        pattern: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
        color: 'muted',
        priority: 50,
    },
    {
        pattern: /(?:^|\s)((?:\d{1,2}月|[A-Z][a-z]{2})\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\b/g,
        color: 'muted',
        priority: 50,
        capture: 1,
    },
    {
        pattern: /\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
        color: 'muted',
        priority: 40,
    },
    {
        pattern: /\b(?:debug|trace|verbose)\b/gi,
        color: 'muted',
        priority: 30,
    },
]

/** 查找单行中不重叠的语义范围。 */
export function findSemanticHighlights (text: string): SemanticHighlight[] {
    const candidates: (SemanticHighlight & { priority: number })[] = []

    for (const rule of RULES) {
        rule.pattern.lastIndex = 0
        let match: RegExpExecArray|null = rule.pattern.exec(text)
        while (match) {
            const value = rule.capture ? match[rule.capture] : match[0]
            const start = match.index + (rule.capture ? match[0].indexOf(value) : 0)
            let end = start + value.length

            // 排除链接和路径末尾的标点。
            while (end > start && /[),.;!?\]]/.test(text[end - 1])) {
                end--
            }
            if (end > start) {
                candidates.push({ start, end, color: rule.color, priority: rule.priority })
            }
            if (!match[0].length) {
                rule.pattern.lastIndex++
            }
            match = rule.pattern.exec(text)
        }
    }

    candidates.sort((a, b) => b.priority - a.priority || a.start - b.start)
    const occupied = new Uint8Array(text.length)
    const result: SemanticHighlight[] = []
    for (const candidate of candidates) {
        let overlaps = false
        for (let i = candidate.start; i < candidate.end; i++) {
            if (occupied[i]) {
                overlaps = true
                break
            }
        }
        if (overlaps) {
            continue
        }
        occupied.fill(1, candidate.start, candidate.end)
        result.push({ start: candidate.start, end: candidate.end, color: candidate.color })
    }

    return result.sort((a, b) => a.start - b.start)
}
