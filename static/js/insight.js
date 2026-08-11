/**
 * The little formatting language the insight popovers speak.
 *
 * A tooltip that has to explain arithmetic is not one sentence, and rendering
 * it as one produced a paragraph nobody could find a number in. `data-insight`
 * therefore carries a few lines instead of a blob, and `renderInsight` turns
 * them into real elements.
 *
 * The format is deliberately line-based rather than JSON: it survives an HTML
 * attribute without escaping, it is readable as-is in devtools, and a plain
 * one-line tooltip — which is most of them — is already valid input that comes
 * out as a single paragraph, exactly as before.
 *
 *     # Aug 4                 heading, the thing being explained
 *     Tracked | 37m 30s       a figure: label on the left, value on the right
 *     ## Shared out           a subheading, for a second group of figures
 *     Phase 2 | 18m
 *     Still provisional …     anything else is a closing note
 */

/** Build a document from parts, dropping the ones that didn't apply. */
export function insight(...lines) {
    return lines.filter(Boolean).join('\n')
}

export const heading = (text) => `# ${clean(text)}`
export const section = (text) => `## ${clean(text)}`
export const note = (text) => clean(text)

/**
 * One label/value pair.
 *
 * Values are ours — durations, percentages — but labels can be a budget the
 * user named, so the line is split on its *last* separator when parsed. That
 * keeps "Acme | Phase 2" working as a label without needing to escape it.
 */
export const row = (label, value) => `${clean(label)} | ${clean(value)}`

/** Newlines are the record separator, so they can't survive inside a field. */
function clean(text) {
    return String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Flatten to one sentence for `aria-label`.
 *
 * Screen readers get prose rather than a visual table: "Tracked 37m 30s.
 * Billed 45m." reads correctly, whereas the pipes would be announced.
 */
export function insightToSentence(source) {
    return parseInsight(source)
        .map((part) => {
            if (part.kind === 'row') return `${part.label} ${part.value}.`
            if (part.kind === 'heading' || part.kind === 'section') return `${part.text}.`
            return part.text
        })
        .join(' ')
        .replace(/\.\./g, '.')
        .trim()
}

/** Parse the line format into parts. Unknown lines are notes, never dropped. */
export function parseInsight(source) {
    return String(source ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            if (line.startsWith('## ')) {
                return { kind: 'section', text: line.slice(3).trim() }
            }
            if (line.startsWith('# ')) {
                return { kind: 'heading', text: line.slice(2).trim() }
            }
            const split = line.lastIndexOf(' | ')
            if (split > 0) {
                return {
                    kind: 'row',
                    label: line.slice(0, split).trim(),
                    value: line.slice(split + 3).trim(),
                }
            }
            return { kind: 'note', text: line }
        })
}

/**
 * Render into `container`, replacing whatever was there.
 *
 * Builds nodes and sets `textContent` rather than assembling markup: insight
 * text carries client and budget names, and this is the one place all of them
 * reach the DOM.
 */
export function renderInsight(container, source) {
    container.textContent = ''
    const parts = parseInsight(source)

    // Consecutive figures share one grid so their values line up in a column;
    // a note or a subheading closes the run.
    let figures = null
    for (const part of parts) {
        if (part.kind !== 'row') figures = null

        if (part.kind === 'row') {
            if (!figures) {
                figures = document.createElement('dl')
                figures.className = 'tk-insight-figures'
                container.appendChild(figures)
            }
            const label = document.createElement('dt')
            label.textContent = part.label
            const value = document.createElement('dd')
            value.textContent = part.value
            figures.append(label, value)
            continue
        }

        const element = document.createElement(
            part.kind === 'heading' ? 'strong' : part.kind === 'section' ? 'em' : 'p'
        )
        element.className = `tk-insight-${part.kind}`
        element.textContent = part.text
        container.appendChild(element)
    }
}
