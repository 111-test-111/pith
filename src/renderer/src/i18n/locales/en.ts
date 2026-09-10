/**
 * English messages — the source of truth. Every other locale is typed against
 * this shape, so a missing or extra key fails typecheck. Keys are flat
 * `domain.key` strings; `{name}` placeholders are filled by `t()`.
 */
const en = {
  // app
  'app.starting': 'Starting Pi…',

  // common
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.continue': 'Continue',

  // workspace shell / sidebar
  'workspace.newChat': 'New chat',
  'workspace.openFolder': 'Open folder…',
  'workspace.sessions': 'Sessions',
  'workspace.sessionsAria': 'Sessions by workspace folder',
  'workspace.settings': 'Settings',
  'workspace.noModel': 'No model selected',
  'workspace.removeAttachment': 'Remove {name}',
  'workspace.deleteSession': 'Delete session',
  'workspace.deleteProject': 'Delete project',
  'workspace.confirmDeleteSessionTitle': 'Delete session?',
  'workspace.confirmDeleteSessionMessage': '“{label}” will be moved to the Trash.',
  'workspace.confirmDeleteProjectTitle': 'Delete project?',
  'workspace.confirmDeleteProjectMessage':
    'All {count} {sessionsWord} under “{label}” will be moved to the Trash.',
  'workspace.showMore': 'Show more',
  'workspace.sessionOne': 'session',
  'workspace.sessionMany': 'sessions',

  // conversation
  'chat.transcriptAria': 'Conversation',
  'chat.emptyTitle': 'Ready when you are',
  'chat.emptyBody':
    'Ask Pi to read, edit, search and run code in this workspace — or attach an image and reference files with @.',
  'chat.working': 'Working…',
  'chat.thinking': 'Thinking…',
  'chat.reasoning': 'Reasoning',
  'chat.you': 'You',
  'chat.assistantFallback': 'Assistant',
  'chat.usage': '{input} in · {output} out · {cost}',
  'chat.aborted': ' (aborted)',
  'chat.queuedSteer': 'Queued steer: “{text}”',

  // composer
  'composer.placeholder': 'Ask Pi to do something… (@ to reference files)',
  'composer.attachImage': 'Attach image',
  'composer.attachImageDesc': 'Send a screenshot or photo to the model',
  'composer.attachFile': 'Reference file',
  'composer.attachFileDesc': 'Inline a local file into the prompt',
  'composer.thinkingLevel': 'Thinking: {level}',
  'composer.thinkingDesc': 'Cycle the reasoning effort',
  'composer.dropImages': 'Drop images to attach',

  // @mention file picker
  'mention.searching': 'Searching files…',
  'mention.filesCount': 'Files ({count})',
  'mention.hints': '↑↓ navigate · ↵ select · esc close',
  'mention.noMatches': 'No matching files',
  'mention.image': 'image',

  // model picker
  'model.searchAria': 'Search models',
  'model.choose': 'Choose model',
  'model.listAria': 'Models',
  'model.noneFound': 'No models found.',
  'model.reasoning': 'reasoning',
  'model.standard': 'standard',
  'model.contextK': '{k}k ctx',
  'model.noProviders': 'No configured providers. Add an API key in Settings.',

  // welcome
  'welcome.title': 'Welcome to Pi',
  'welcome.body':
    'A coding agent that reads, edits, searches and runs code in a folder on your machine. Pick a working directory to start — you can change it any time from the sidebar.',
  'welcome.choose': 'Choose a working directory',
  'welcome.footnote':
    'Models are configured through providers such as Anthropic, OpenAI or Google — add an API key in Settings after you pick a folder.',

  // provider auth
  'auth.openAuthPage': 'Open authorization page',
  'auth.deviceCode': 'Device code',
  'auth.connected': 'Connected',
  'auth.notConfigured': 'Not configured',

  // settings
  'settings.title': 'Settings',
  'settings.general': 'General',
  'settings.appearance': 'Appearance',
  'settings.providers': 'Providers',
  'settings.storage': 'Storage',
  'settings.credentials': 'Credentials',
  'settings.credentialsDesc': '~/.pi/agent/auth.json — shared with the pi CLI',
  'settings.sessions': 'Sessions',
  'settings.sessionsDesc': '~/.pi/agent/sessions — per workspace folder',
  'settings.about': 'About',
  'settings.version': 'Version {version}',
  'settings.versionUnknown': 'Version —',
  'settings.openProjectPage': 'Open project page',
  'settings.theme': 'Theme',
  'settings.light': 'Light',
  'settings.dark': 'Dark',
  'settings.system': 'System',
  'settings.accent': 'Accent',
  'settings.accentDesc': 'Applies across the interface',
  'settings.accentAria': 'Accent {id}',
  'settings.language': 'Language',
  'settings.languageDesc': 'Interface language — applies immediately',
  'settings.providersDesc': 'Sign in to unlock models. Keys are stored in ~/.pi/agent/auth.json.',
  'settings.refreshProviders': 'Refresh providers',
  'settings.apiKey': 'API key',
  'settings.oauth': 'OAuth',
  'settings.signOut': 'Sign out of {name}',
  'settings.noProviders': 'No providers discovered.',

  // tool call surfaces
  'tool.noOutput': '(no output)',
  'tool.noDiff': '(no diff)',
  'tool.emptyFile': '(empty file)',
  'tool.editing': 'Editing…',
  'tool.reading': 'Reading…',
  'tool.writingFile': 'Writing file…',
  'tool.wrote': 'Wrote {file}',
  'tool.live': 'Live',
  'tool.duration': '{seconds}s',
  'tool.runningPlaceholder': '…'
}

export type Messages = typeof en
export type MessageKey = keyof Messages
export default en
