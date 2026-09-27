import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, TOKENS } from './defaults.mjs'

export function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {}
  const pickBool = (key, fallback) => (typeof source[key] === 'boolean' ? source[key] : fallback)
  const pickNum = (key, fallback) => {
    const value = Number(source[key])
    return Number.isFinite(value) ? value : fallback
  }
  const pickStr = (key, fallback) => (typeof source[key] === 'string' ? source[key] : fallback)
  const pickTpl = (key) => (typeof source[key] === 'string' && source[key].trim() ? source[key] : DEFAULT_TEMPLATES[key])
  return {
    enabled: pickBool('enabled', true),
    debug: pickBool('debug', false),
    notifyApproval: pickBool('notifyApproval', true),
    notifyQuestion: pickBool('notifyQuestion', true),
    notifyDone: pickBool('notifyDone', true),
    notifyError: pickBool('notifyError', true),
    notifyBlocked: pickBool('notifyBlocked', true),
    notifyMaxTokens: pickBool('notifyMaxTokens', true),
    notifyAborted: pickBool('notifyAborted', true),
    notifySubagents: pickBool('notifySubagents', false),
    notifyUserAbort: pickBool('notifyUserAbort', false),
    approvalDelayMs: pickNum('approvalDelayMs', 1200),
    questionDelayMs: pickNum('questionDelayMs', 1200),
    quietWhenFocused: pickBool('quietWhenFocused', true),
    showWhenDnd: pickBool('showWhenDnd', false),
    bypassDnd: pickBool('bypassDnd', false),
    clickToFocus: pickBool('clickToFocus', true),
    focusUrl: pickStr('focusUrl', 'dsh://open'),
    appId: pickStr('appId', 'electron.app.DeepSeek Harness'),
    iconPath: pickStr('iconPath', ''),
    foregroundProcesses: pickStr('foregroundProcesses', 'DeepSeek Harness'),
    foregroundTitles: pickStr('foregroundTitles', 'DeepSeek Harness'),
    disabledHooks: pickStr('disabledHooks', ''),
    rateLimitMs: pickNum('rateLimitMs', 60000),
    rateLimitMax: pickNum('rateLimitMax', 6),
    maxConcurrent: pickNum('maxConcurrent', 2),
    helperTimeoutMs: pickNum('helperTimeoutMs', 15000),
    approvalTitle: pickTpl('approvalTitle'),
    approvalBody: pickTpl('approvalBody'),
    questionTitle: pickTpl('questionTitle'),
    questionBody: pickTpl('questionBody'),
    doneTitle: pickTpl('doneTitle'),
    doneBody: pickTpl('doneBody'),
    blockedTitle: pickTpl('blockedTitle'),
    blockedBody: pickTpl('blockedBody'),
    errorTitle: pickTpl('errorTitle'),
    errorBody: pickTpl('errorBody'),
    maxTokensTitle: pickTpl('maxTokensTitle'),
    maxTokensBody: pickTpl('maxTokensBody'),
    abortedTitle: pickTpl('abortedTitle'),
    abortedBody: pickTpl('abortedBody'),
  }
}

export const CONFIG_FIELDS = {
  enabled: ['boolean', true, '总开关；false 时插件完全不注册任何监听'],
  debug: ['boolean', false, '把每次通知决策打到宿主日志'],
  notifyApproval: ['boolean', true, '审批请求通知（真正在等你点时）'],
  notifyQuestion: ['boolean', true, 'ask_user_question 提问通知'],
  notifyDone: ['boolean', true, '本轮任务完成通知'],
  notifyError: ['boolean', true, '任务出错通知'],
  notifyBlocked: ['boolean', true, '任务被阻止通知'],
  notifyMaxTokens: ['boolean', true, '输出被截断通知'],
  notifyAborted: ['boolean', true, '非用户原因的中断通知'],
  notifySubagents: ['boolean', false, '子代理会话是否也通知'],
  notifyUserAbort: ['boolean', false, '用户自己按停止导致的 aborted 是否通知'],
  approvalDelayMs: ['number', 1200, '审批事件静候多久仍未决才通知（规避 never 策略下的瞬时自动拒绝）'],
  questionDelayMs: ['number', 1200, '提问事件静候多久仍未回答才通知'],
  quietWhenFocused: ['boolean', true, 'DSH 窗口在前台时不弹通知'],
  showWhenDnd: ['boolean', false, '专注助手/免打扰开启时是否仍弹'],
  bypassDnd: ['boolean', false, '用 reminder 场景穿透免打扰'],
  clickToFocus: ['boolean', true, '点击通知时把桌面端窗口调到前台'],
  focusUrl: ['string', 'dsh://open', '点击通知打开的目标；默认 dsh://open 由桌面端自己处理（聚焦窗口）'],
  appId: ['string', 'electron.app.DeepSeek Harness', '通知归属的 AppUserModelID'],
  iconPath: ['string', '', '通知正文里的大图标：默认不显示（头部已有小图标）；填文件路径显示该图，填 bundled 用自带的 toast-logo.png'],
  foregroundProcesses: ['string', 'DeepSeek Harness', '视为“窗口在前台”的进程名，逗号分隔'],
  foregroundTitles: ['string', 'DeepSeek Harness', '视为“窗口在前台”的标题片段，逗号分隔'],
  disabledHooks: ['string', '', '额外屏蔽的类型，逗号分隔：approval,question,done,blocked,error,max-tokens,aborted'],
  rateLimitMs: ['number', 60000, '限流窗口（毫秒），0 表示不限流'],
  rateLimitMax: ['number', 6, '单个限流窗口内最多弹出多少条'],
  maxConcurrent: ['number', 2, '同时最多几个 PowerShell 助手进程'],
  helperTimeoutMs: ['number', 15000, '单个助手进程超时时间（毫秒）'],
  ...Object.fromEntries(
    TEMPLATE_KEYS.map((key) => [key, ['string', DEFAULT_TEMPLATES[key], `文案模板（可用 ${Object.keys(TOKENS).join(' ')}）`]]),
  ),
}

export const configValidator = {
  '~standard': {
    version: 1,
    vendor: 'dsh-win-notify',

    validate: (value) => ({ value: normalizeConfig(value) }),
  },
}
