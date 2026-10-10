import { useI18n } from '@/i18n'
import { useWidePaneSplit } from '@/lib/hooks/use-wide-pane-split'
import { PanelResizeHandle } from '../PanelResizeHandle'
import type { GitState, GitStore } from '@/state/git-store'

/** CSS fits the saved preference; dragging writes only this workspace's variable. */
export function useGitSplit(state: GitState, store: GitStore, hasDetail: boolean) {
  const { t } = useI18n()
  const split = useWidePaneSplit({ preferred: state.splitWidths[state.view], enabled: hasDetail,
    scope: JSON.stringify([state.cwd, state.view]), onCommit: width => store.setSplitWidth(state.view, width, state.cwd) })
  return {
    ref: split.ref,
    handle: hasDetail ? <PanelResizeHandle {...split.handleProps} label={t('git.resizeSplit')} /> : null
  }
}
