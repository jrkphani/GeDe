// Trigger a browser download of text content (issue 015 export). DOM-only and
// self-guarding so it is a no-op in non-browser environments (tests/SSR).
export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

// "{project-name}.gede.json", with filesystem-hostile characters neutralized.
export function exportFilename(projectName: string): string {
  const safe = projectName
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return `${safe || 'project'}.gede.json`
}
