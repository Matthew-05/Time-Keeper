/**
 * Copies third-party frontend assets out of node_modules and into static/vendor/
 * so the packaged desktop app has no runtime CDN dependency.
 *
 * Run with `npm run vendor` (or `npm run build`, which also rebuilds the CSS).
 * The output of this script IS committed — node_modules is not.
 */
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'static', 'vendor')

/** [source relative to node_modules, destination relative to static/vendor] */
const FILES = [
  ['flatpickr/dist/flatpickr.min.js', 'flatpickr/flatpickr.min.js'],
  ['flatpickr/dist/flatpickr.min.css', 'flatpickr/flatpickr.min.css'],

  ['choices.js/public/assets/scripts/choices.min.js', 'choices/choices.min.js'],
  ['choices.js/public/assets/styles/choices.min.css', 'choices/choices.min.css'],

  [
    'input-duration/index.js',
    'input-duration/input-duration.js',
    stripInputDurationDebug,
  ],
  ['input-duration/LICENSE', 'input-duration/LICENSE'],

  [
    'vis-timeline/standalone/umd/vis-timeline-graph2d.min.js',
    'vis-timeline/vis-timeline-graph2d.min.js',
  ],
  [
    'vis-timeline/styles/vis-timeline-graph2d.min.css',
    'vis-timeline/vis-timeline-graph2d.min.css',
  ],

  ['chart.js/dist/chart.umd.min.js', 'chartjs/chart.umd.min.js'],
]

/** Latin-only Inter subsets — the rest of the unicode ranges aren't worth the bytes. */
const FONT_PATTERN = /^inter-latin(-ext)?-wght-(normal|italic)\.woff2$/

function stripInputDurationDebug(source) {
  return source.replace(/^\s*console\.log\([^;\n]*\);\r?\n/gm, '')
}

async function copy(from, to, transform = null) {
  const dest = join(vendor, to)
  await mkdir(dirname(dest), { recursive: true })
  if (transform) {
    const source = await readFile(join(root, 'node_modules', from), 'utf8')
    await writeFile(dest, transform(source), 'utf8')
  } else {
    await copyFile(join(root, 'node_modules', from), dest)
  }
  console.log(`  ${to}`)
}

async function copyFonts() {
  const src = join(root, 'node_modules', '@fontsource-variable', 'inter', 'files')
  const names = (await readdir(src)).filter((n) => FONT_PATTERN.test(n))
  for (const name of names) {
    await copy(join('@fontsource-variable', 'inter', 'files', name), join('fonts', name))
  }
}

console.log('Vendoring frontend assets into static/vendor/ ...')
for (const [from, to, transform] of FILES) await copy(from, to, transform)
await copyFonts()
console.log('Done.')
