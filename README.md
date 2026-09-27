# dsh-win-notify

为 **DeepSeek Harness 桌面端**（Windows）补上系统通知：智能体需要你审批、在等你回答、
任务完成、出错或被中断时，弹出真正的 Windows Toast，并在应用里提供一个开关面板。

> ### 面向桌面端，不是 Web UI 端
>
> 这个插件**只适用于 Windows 上的 DeepSeek Harness 桌面应用**,它**不适用于**在浏览器里访问的 DSH Web UI。
---
## 功能

**通知事件**（每一项都能在面板里单独开关）

| 事件 | 内容 |
|---|---|
| 需要你审批 | 谁在等你点，带上工具名与原因 |
| 智能体提问 | 用 `ask_user_question` 等你选答案 |
| 任务完成 | 一轮回复结束 |
| 任务出错 | 带上错误摘要 |
| 任务被阻止 | 步骤被策略拦下 |
| 输出被截断 | 达到模型最大输出长度 |
| 任务被中断 | 父级回收 / 钩子 / 应用退出导致 |
| 我自己按了停止 | 默认关闭 |

- **窗口在前台时不弹。** 判定在一次 PowerShell 调用里顺手完成，不额外增加进程开销。
- **通知归属 DeepSeek Harness。** 头部显示应用名与鲸鱼图标，可在
  「设置 → 系统 → 通知」里单独开关。
- **点击通知把窗口调到前台**，走桌面端自己注册的 `dsh://open`。
- **零第三方依赖。** 不用 npm 包，也不用 PowerShell 模块（不需要 BurntToast），
  只用系统自带的 Windows PowerShell 5.1。


---

## 安装

### 前置条件

- Windows 10 / 11
- **DeepSeek Harness 桌面端**（不是浏览器里的 Web UI）

### 1. 用自带的插件管理器安装

打开 DeepSeek Harness → 设置 → 插件 → **添加插件**，将插件安装完成即可使用

### 2. 注册通知身份（非必须）

它让通知头部显示 **DeepSeek Harness** 而不是原始的 AppUserModelID。

#### 先找到插件的安装位置

在powershell中执行以下指令：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\*\node_modules\dsh-win-notify" -Directory
```


在刚找到的那个目录里：

```powershell
cd <上面找到的路径>
powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-app-identity.ps1
```

它会找到开始菜单里的 `DeepSeek Harness.lnk`，写入
`System.AppUserModel.ID = electron.app.DeepSeek Harness`，并把快捷方式图标指向
本插件自带的 `assets\app.ico`。

脚本用**自身所在目录**定位图标，所以在链接目录里执行也没问题 —— 它总能找到真实的
`assets\app.ico`。

### 3. 重启应用

bundle 列表在启动时读取，所以必须重启 DeepSeek Harness，「通知」按钮才会出现。

### 验证

重启后，菜单栏 **应用 / 编辑 右边**应该出现「通知」。点开 →「发送测试通知」，
应能弹出一条系统通知。

没出现时在「设置 → 系统 → 通知」里确认 **DeepSeek Harness** 没被关掉。

### 卸载

在插件页面移除本插件即可（会同时清掉 bundle 登记）。

---

## 使用

菜单栏里的 **通知** 按钮打开面板，逐项开关哪些情况要通知、是否在前台静默、是否穿透免打扰。
**拨动立即生效，不需要重启**。

## 许可

MIT
