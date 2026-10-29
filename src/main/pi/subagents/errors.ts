/** Tool-visible error for subagent dispatch: its message is safe to return
 * to the model as the tool call's failure text. */
export class SubagentError extends Error {}
