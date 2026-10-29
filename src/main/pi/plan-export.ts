import { writeFile } from 'node:fs/promises'
import type { PlanActionResult, PlanDocumentDTO, PlanDocumentRequest } from '../../shared/plan'
/** The dialog is supplied by IPC; only this immutable, authoritative snapshot is written. */
export async function exportPlan(request: PlanDocumentRequest,
  read: (request: PlanDocumentRequest) => PlanActionResult<PlanDocumentDTO>,
  choose: (defaultPath: string) => Promise<{ canceled: boolean; filePath?: string }>
): Promise<PlanActionResult<{ cancelled: boolean }>> {
  const document = read(request)
  if (!document.ok) return document
  try {
    const chosen = await choose(`plan-${document.value.ref.planId}-v${document.value.ref.revision}.md`)
    if (chosen.canceled || !chosen.filePath) return { ok: true, value: { cancelled: true } }
    await writeFile(chosen.filePath, document.value.markdown, 'utf8')
    return { ok: true, value: { cancelled: false } }
  } catch { return { ok: false, code: 'plan-export-failed', blockers: [] } }
}
