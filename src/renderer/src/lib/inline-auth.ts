/**
 * Inline auth-flow claim: the provider detail page renders its OAuth
 * interaction (method choices, auth links, device codes) inline, so the
 * global AuthBridge overlay must skip that provider's auth events for the
 * duration of the flow. Module-level by design — the Workspace subscriptions
 * and the detail page live in different subtrees.
 */
let claimedProvider: string | null = null

export function claimInlineAuth(providerId: string): void {
  claimedProvider = providerId
}

export function releaseInlineAuth(providerId: string): void {
  if (claimedProvider === providerId) claimedProvider = null
}

export function isInlineAuthClaimed(providerId: string): boolean {
  return claimedProvider === providerId
}
