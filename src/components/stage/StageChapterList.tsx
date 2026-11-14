import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChapterRow } from '../../stores/navigation/stage-progress'
import { chapterLabel } from '../../shared/chapter-label'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT } from './stage-text'

type Text = (zh: string, en: string) => string
const ROW_HEIGHT = 30
const OVERSCAN = 8

/** Keep long books bounded in the DOM; short lists retain their natural sizing. */
export default function StageChapterList({ chapters, currentChapter, onChapter, text }: {
  chapters: readonly ChapterRow[]
  currentChapter?: number
  onChapter: (chapter: number) => void
  text: Text
}) {
  const list = useRef<HTMLOListElement>(null)
  const focusIndex = useRef<number | null>(null)
  const windowed = chapters.length > 100
  const currentIndex = chapters.findIndex(chapter => chapter.number === currentChapter)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const start = windowed ? Math.max(0, Math.min(chapters.length - 1, Math.floor(viewport.top / ROW_HEIGHT)) - OVERSCAN) : 0
  const end = windowed ? Math.min(chapters.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN) : chapters.length

  useLayoutEffect(() => {
    const element = list.current
    if (!element || !windowed) return
    const measure = () => setViewport(previous => {
      const height = element.clientHeight
      return previous.height === height && previous.top === element.scrollTop ? previous : { top: element.scrollTop, height }
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [windowed])

  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    if (!windowed) {
      element.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (currentIndex < 0) return
    const top = currentIndex * ROW_HEIGHT, height = element.clientHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + height) element.scrollTop = top + ROW_HEIGHT - height
    setViewport({ top: element.scrollTop, height })
    // Status/title updates must not pull the user away from a manually scrolled position.
  }, [currentIndex, chapters.length, windowed])

  useLayoutEffect(() => {
    if (focusIndex.current === null) return
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-chapter-index="${focusIndex.current}"]`)
    if (button) { button.focus({ preventScroll: true }); focusIndex.current = null }
  })

  const moveFocus = (event: KeyboardEvent<HTMLOListElement>) => {
    if (!windowed || event.altKey || event.ctrlKey || event.metaKey) return
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-chapter-index]')
    if (!button) return
    const index = Number(button.dataset.chapterIndex)
    const page = Math.max(1, Math.floor(viewport.height / ROW_HEIGHT))
    const target = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? chapters.length - 1
        : event.key === 'PageDown' ? index + page : event.key === 'PageUp' ? index - page : null
    if (target === null) return
    event.preventDefault()
    const next = Math.max(0, Math.min(chapters.length - 1, target))
    focusIndex.current = next
    const element = list.current!
    const top = next * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight
    setViewport({ top: element.scrollTop, height: element.clientHeight })
  }

  return <ol ref={list} className={`stage-chapters${windowed ? ' stage-chapters--windowed' : ''}`}
    aria-label={text('章节', 'Chapters')} onKeyDown={moveFocus}
    onScroll={windowed ? event => {
      const element = event.currentTarget
      setViewport({ top: element.scrollTop, height: element.clientHeight })
    } : undefined}>
    {start > 0 && <li aria-hidden="true" role="presentation" style={{ height: start * ROW_HEIGHT }} />}
    {chapters.slice(start, end).map((chapter, offset) => <li key={chapter.number}
      aria-setsize={windowed ? chapters.length : undefined} aria-posinset={windowed ? start + offset + 1 : undefined}>
      <button type="button" className="stage-chapter" data-phase={chapter.phase} data-chapter-index={start + offset}
        aria-current={chapter.number === currentChapter ? 'page' : undefined} onClick={() => onChapter(chapter.number)}>
        <span className="stage-chapter-no">{chapter.number}</span>
        <span className="stage-chapter-title">{chapter.title || chapterLabel(chapter.number, text)}</span>
        {chapter.running ? <span className="stage-chapter-status" data-tone="accent">{text(...CHAPTER_RUNNING_TEXT)}</span>
          : chapter.phase === 'final' ? <span className="stage-chapter-dot" role="img" aria-label={text(...CHAPTER_PHASE_TEXT.final)} />
            : chapter.phase !== 'todo' ? <span className="stage-chapter-status">{text(...CHAPTER_PHASE_TEXT[chapter.phase])}</span> : null}
      </button>
    </li>)}
    {end < chapters.length && <li aria-hidden="true" role="presentation" style={{ height: (chapters.length - end) * ROW_HEIGHT }} />}
  </ol>
}
