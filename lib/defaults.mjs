export const TOKENS = {
  '%TITLE%': '会话标题（拿不到时为空）',
  '%TOOL%': '触发审批的工具名',
  '%REASON%': '审批原因 / 结束原因',
  '%TURN%': '轮次编号',
  '%REPLY%': '本轮最后的助手回复节选',
  '%ERROR%': '错误摘要',
  '%AGENT%': '子代理名称（仅子代理通知）',
}

export const DEFAULT_TEMPLATES = {

  approvalTitle: '需要你批准',
  approvalBody: '%TOOL% %REASON% — %TITLE%',

  questionTitle: '智能体在等你回答',
  questionBody: '%TITLE%',

  doneTitle: '任务完成',
  doneBody: '%TITLE%',

  blockedTitle: '任务被阻止',
  blockedBody: '%REASON% — %TITLE%',

  errorTitle: '任务出错',
  errorBody: '%ERROR% — %TITLE%',

  maxTokensTitle: '输出被截断',
  maxTokensBody: '达到最大输出长度 — %TITLE%',

  abortedTitle: '任务被中断',
  abortedBody: '%REASON% — %TITLE%',
}

export const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES)
