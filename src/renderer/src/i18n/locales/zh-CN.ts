import type { Messages } from './en'

/** 简体中文 — key 必须与 en.ts 完全一致（类型强制）。 */
const zhCN: Messages = {
  // app
  'app.starting': '正在启动 Pi…',

  // common
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.continue': '继续',

  // workspace shell / sidebar
  'workspace.newChat': '新会话',
  'workspace.openFolder': '打开目录…',
  'workspace.sessions': '会话',
  'workspace.sessionsAria': '按工作区目录分组的会话',
  'workspace.settings': '设置',
  'workspace.themeLabel': '主题：{mode}',
  'workspace.noModel': '未选择模型',
  'workspace.removeAttachment': '移除 {name}',
  'workspace.deleteSession': '删除会话',
  'workspace.deleteProject': '删除项目',
  'workspace.confirmDeleteSessionTitle': '删除会话？',
  'workspace.confirmDeleteSessionMessage': '“{label}”将被移到废纸篓。',
  'workspace.confirmDeleteProjectTitle': '删除项目？',
  'workspace.confirmDeleteProjectMessage': '“{label}”下的全部 {count} {sessionsWord}将被移到废纸篓。',
  'workspace.showMore': '显示更多',
  'workspace.sessionOne': '个会话',
  'workspace.sessionMany': '个会话',

  // conversation
  'chat.transcriptAria': '会话记录',
  'chat.navGoTo': '跳转到第 {index} 条消息（共 {count} 条）',
  'chat.emptyTitle': '准备好了，随时开始',
  'chat.emptyBody': '让 Pi 在这个工作区里读代码、改代码、搜索和运行代码——也可以附加图片、用 @ 引用文件。',
  'chat.working': '正在处理…',
  'chat.thinking': '思考中…',
  'chat.reasoning': '推理过程',
  'chat.you': '你',
  'chat.assistantFallback': '助手',
  'chat.usage': '输入 {input} · 输出 {output} · {cost}',
  'chat.aborted': '（已中止）',
  'chat.queuedSteer': '已排队插话：“{text}”',

  // composer
  'composer.placeholder': '让 Pi 做点什么…（@ 可引用文件）',
  'composer.attachImage': '附加图片',
  'composer.attachImageDesc': '向模型发送截图或照片',
  'composer.attachFile': '引用文件',
  'composer.attachFileDesc': '将本地文件内联到提示中',
  'composer.thinkingLevel': '思考强度：{level}',
  'composer.thinkingDesc': '循环切换推理强度',
  'composer.dropImages': '拖放图片以附加',

  // @mention file picker
  'mention.searching': '正在搜索文件…',
  'mention.filesCount': '文件（{count}）',
  'mention.hints': '↑↓ 选择 · ↵ 确认 · esc 关闭',
  'mention.noMatches': '没有匹配的文件',
  'mention.image': '图片',

  // model picker
  'model.searchAria': '搜索模型',
  'model.choose': '选择模型',
  'model.listAria': '模型',
  'model.noneFound': '未找到模型。',
  'model.reasoning': '推理',
  'model.standard': '标准',
  'model.contextK': '{k}k 上下文',
  'model.noProviders': '尚无已配置的提供商，请在设置中添加 API key。',

  // welcome
  'welcome.title': '欢迎使用 Pi',
  'welcome.body': '一个在你本机目录里读代码、改代码、搜索并运行代码的编程智能体。先选择一个工作目录即可开始——之后随时可以在侧边栏更换。',
  'welcome.choose': '选择工作目录',
  'welcome.footnote': '模型通过 Anthropic、OpenAI、Google 等提供商配置——选好目录后在设置中添加 API key。',

  // provider auth
  'auth.openAuthPage': '打开授权页面',
  'auth.deviceCode': '设备码',
  'auth.connected': '已连接',
  'auth.notConfigured': '未配置',

  // settings
  'settings.title': '设置',
  'settings.back': '返回对话',
  'settings.general': '通用',
  'settings.generalDesc': '存储、版本与项目信息。',
  'settings.appearance': '外观',
  'settings.appearanceDesc': '主题、强调色与界面语言。',
  'settings.providers': '提供商',
  'settings.storage': '存储',
  'settings.credentials': '凭据',
  'settings.credentialsDesc': '~/.pi/agent/auth.json — 与 pi CLI 共享',
  'settings.sessions': '会话',
  'settings.sessionsDesc': '~/.pi/agent/sessions — 按工作区目录存放',
  'settings.about': '关于',
  'settings.version': '版本 {version}',
  'settings.versionUnknown': '版本 —',
  'settings.openProjectPage': '打开项目主页',
  'settings.theme': '主题',
  'settings.light': '浅色',
  'settings.dark': '深色',
  'settings.system': '跟随系统',
  'settings.accent': '强调色',
  'settings.accentDesc': '应用于整个界面',
  'settings.accentAria': '强调色 {id}',
  'settings.language': '语言',
  'settings.languageDesc': '界面语言 — 立即生效',
  'settings.providersDesc': '登录以解锁模型。密钥存储在 ~/.pi/agent/auth.json。',
  'settings.refreshProviders': '刷新提供商',
  'settings.apiKey': 'API key',
  'settings.oauth': 'OAuth',
  'settings.signOut': '退出登录 {name}',
  'settings.noProviders': '未发现提供商。',

  // tool call surfaces
  'tool.noOutput': '（无输出）',
  'tool.noDiff': '（无差异）',
  'tool.emptyFile': '（空文件）',
  'tool.editing': '正在编辑…',
  'tool.reading': '正在读取…',
  'tool.writingFile': '正在写入文件…',
  'tool.wrote': '已写入 {file}',
  'tool.live': '实时',
  'tool.duration': '{seconds} 秒',
  'tool.runningPlaceholder': '…'
}

export default zhCN
