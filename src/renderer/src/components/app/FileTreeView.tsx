import { FileTree as BeUIFileTree, type FileTreeProps } from '@/components/motion/file-tree'

export { FileTreeFile, FileTreeFolder } from '@/components/motion/file-tree'

const fileTreeClasses = { item: 'h-8 gap-1.5 rounded-item text-xs font-normal aria-selected:bg-primary/10 aria-selected:text-primary [&>span.absolute]:hidden', pillContainer: 'h-8', label: 'flex' }

/** Filesystem and archive navigation share row geometry, hover, selection and
 * keyboard behaviour. Their readers and persisted expansion stay app-owned. */
export function FileTreeView(props: Omit<FileTreeProps, 'instant' | 'indent' | 'classNames'>) {
  return <BeUIFileTree {...props} instant indent={12} classNames={fileTreeClasses} />
}
