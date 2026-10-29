import { useState } from 'react'
import { Chat01, Folder, FolderPlus } from '@/lib/icons'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import { PithIcon } from './PithIcon'

/** Sentinel Select value for a projectless chat — project values are always
 * absolute paths, so this can never collide with a real folder. */
const NO_PROJECT = '__no_project__'
/** Sentinel for the folder-picker row: it opens a directory dialog instead of
 * binding an existing project, so it can never be a real project value. */
const NEW_PROJECT = '__new_project__'

export interface NewSessionProject {
  /** Absolute project directory. */
  cwd: string
  /** Directory name, shown in the trigger and the option row. */
  label: string
}

export interface NewSessionContext {
  /** Display name only; the internal projectless workspace must stay hidden. */
  projectName: string | null
  /** Active working directory, or null for a projectless chat. */
  cwd: string | null
  /** Known projects this new chat can be started in. */
  projects: NewSessionProject[]
  /** Re-bind the new chat to another project; null means no project. */
  onProjectChange: (cwd: string | null) => void | Promise<void>
  /** Ask for a folder that is not a project yet and start the chat in it. */
  onCreateProject: () => void | Promise<void>
}

export function NewSessionHeader({ projectName, cwd, projects, onProjectChange, onCreateProject }: NewSessionContext) {
  const { t } = useI18n()
  const [switching, setSwitching] = useState(false)

  const handleProjectChange = (next: string) => {
    // The picker row is an ACTION, not a value: the panel still reports it
    // through the same channel because the trigger always carries a project.
    if (next === NEW_PROJECT) {
      setSwitching(true)
      void Promise.resolve(onCreateProject())
        .catch((error) => console.error('project pick failed', error))
        .finally(() => setSwitching(false))
      return
    }
    const target = next === NO_PROJECT ? null : next
    if (target === cwd) return
    // Switching creates a fresh session in that folder; hold the control until
    // it lands so two switches cannot race each other.
    setSwitching(true)
    void Promise.resolve(onProjectChange(target)).finally(() => setSwitching(false))
  }

  return (
    <div className="mb-6 flex flex-col items-start text-left">
      <div className="mb-5 flex max-w-full items-center gap-2 text-xs text-muted-foreground">
        <PithIcon variant="mark" className="mr-1 size-9 text-primary" />
        <span className="shrink-0">{t('newSession.label')}</span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
        <Select
          value={cwd ?? NO_PROJECT}
          onValueChange={handleProjectChange}
          disabled={switching}
          className="w-auto"
        >
          <SelectTrigger
            aria-label={t('newSession.projectAria')}
            className="h-7 w-auto gap-1.5 rounded-control border-0 bg-transparent px-1.5 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Folder aria-hidden="true" className="size-3 shrink-0" />
              <span className="max-w-56 truncate">{projectName ?? t('newSession.noProject')}</span>
            </span>
          </SelectTrigger>
          {/* z-30, above the composer's own z-20 controls row (the model and
              sandbox triggers): an equal z-index is settled by document order,
              and the composer row comes later — it painted over the panel's
              lower half. A landing-page dropdown floats over the whole card. */}
          <SelectContent className="left-0 right-auto z-30 w-72">
            <div className="max-h-72 overflow-y-auto">
              <SelectItem value={NO_PROJECT} className="py-1.5">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Chat01 aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate text-sm text-foreground">
                    {t('newSession.noProject')}
                  </span>
                </span>
              </SelectItem>
              {/* The two rows above the list are the "not one of these" choices
                  and belong together: no project at all, or a folder that is
                  not a project yet (the dialog makes it one). */}
              <SelectItem value={NEW_PROJECT} className="py-1.5">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <FolderPlus aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate text-sm text-foreground">
                    {t('newSession.newProject')}
                  </span>
                </span>
              </SelectItem>
              {projects.length ? <div aria-hidden className="mx-1 my-1 h-px bg-border" /> : null}
              {projects.map((project) => (
                <SelectItem key={project.cwd} value={project.cwd} className="py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{project.label}</span>
                    <span dir="ltr" className="truncate text-caption text-muted-foreground">
                      {project.cwd}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </div>
          </SelectContent>
        </Select>
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-foreground @lg:leading-tight">
        {t('newSession.title')}
      </h1>
    </div>
  )
}
