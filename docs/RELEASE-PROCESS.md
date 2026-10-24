# WeNotice 发布流程

> 目的：改代码可以随时提交，但**不要每修一个小 bug 就打 tag 发版**。只有「阶段性功能完成」或「bug 在复现环境确认修复」之后，才对外发布正式版本。
>
> 背景：v1.3.1 → v1.3.4 曾在一个晚上连续发了 4 个版本，原因是同一类 Token 问题反复出现、每次都直接发正式版。下面这套流程用来避免这种情况。

## 1. 三种动作，分清用途

| 动作 | 触发方式 | 产物 | 是否对外可见 |
| --- | --- | --- | --- |
| **CI 检查** | push 到 `main`、PR、手动 | 无（只跑检查） | 不可见 |
| **预发布（beta）** | tag `vX.Y.Z-beta.N` | GitHub **Pre-release**（zip + sha256） | 可见，但不在 Latest |
| **正式发布** | tag `vX.Y.Z`（不带 `-beta`） | GitHub **Release**（Latest） | 可见，下载页默认 |

- CI 检查由 `.github/workflows/ci.yml` 自动执行：`node --check` 全部源码、校验 `app/package.json` 版本号、检查 `CHANGELOG.md` 是否有对应条目；**不构建、不发版**。
- 构建/发布由 `.github/workflows/release.yml` 执行；也支持手动运行（`publish=none` 只出 artifact 包，`publish=prerelease/latest` 手动发版）。

## 2. 什么时候发什么

### 只提交代码（不发版）
- 普通修复、重构、文档更新、依赖调整；
- 还没在复现环境验证过的修复；
- 连续迭代中的中间状态。

→ 直接 push `main`，CI 会跑检查；**不 bump 版本号、不打 tag**。

### 发预发布（beta）——「请帮我验收一下」
- 一个修复需要用户在目标环境验证（尤其是复现条件在开发机上不具备的，例如：AstrWeChat 提权、虚拟机、其他账号）；
- 一个功能做完了，想先让人试用再宣布正式版。

```powershell
# 1. 版本号写进 app/package.json + CHANGELOG（例如 1.3.5-beta.1）
# 2. 本地检查 + 构建 + 校验
pwsh tools\check-release.ps1 -Stage pre
pwsh tools\build-portable.ps1 -Version 1.3.5-beta.1
pwsh tools\check-release.ps1 -Stage post -Version 1.3.5-beta.1
# 3. 提交、打 beta tag、推送
git add -A; git commit -m "feat: ... (1.3.5-beta.1)"; git push origin main
git tag -a v1.3.5-beta.1 -m "WeNotice v1.3.5-beta.1"; git push origin refs/tags/v1.3.5-beta.1
```

→ CI 自动构建并创建 **Pre-release**。用户可在 Releases 页面下载（标着 “Pre-release”），但仓库默认 Latest 仍是上一个正式版。

### 发正式版——验收通过之后
- 预发布已在目标环境验收通过，或功能已确认完成；
- 没有已知未修复的回归问题；
- CHANGELOG 已整理。

→ 打正式 tag `vX.Y.Z`（版本号去掉 beta 后缀，`app/package.json` 同步），推送后 CI 创建正式 Release（Latest）。

## 3. 发版门槛（Checklist）

- [ ] 修复类：**有复现步骤，且在复现环境验证通过**（截图/诊断/日志均可）
- [ ] 功能类：自测用例通过，UI 截图检查过
- [ ] `pwsh tools\check-release.ps1 -Stage pre` 通过
- [ ] 本地构建后 `-Stage post` 通过（zip / sha256 / 签名）
- [ ] 版本号（`app/package.json`、`version.txt`、tag）一致
- [ ] `CHANGELOG.md` 有对应条目
- [ ] 已通知验收人；正式版发布前拿到「确认可用」的回复
- [ ] 升级说明写在 release notes（保留 `resources\.data`）

## 4. 版本号规则

- 正式版：`X.Y.Z`（如 `1.3.5`）；发版前才 bump `app/package.json`，CI 会校验两者一致。
- 预发布：`X.Y.Z-beta.N`（如 `1.3.5-beta.1`、`1.3.5-beta.2`）；同一轮验收迭代递增 N，**不**另起新版本号。
- 同类问题反复修：只要还没验收通过，就继续用同一轮 beta；验证通过后合并成一个正式版发布。
- 不要在没验证的修复上连续发正式版；正式版一旦发出，尽量只做必要的 hotfix。

## 5. 发布步骤（维护者）

```powershell
# 0) 确认当前在 main 且工作区干净（或只包含本次要发的改动）
git status --short

# 1) 提交前检查（语法 / 版本号 / CHANGELOG）
pwsh tools\check-release.ps1 -Stage pre

# 2) 构建 + 签名 + 打包 + 产物校验
pwsh tools\build-portable.ps1 -Version X.Y.Z
pwsh tools\sign-exe.ps1 -File dist\WeNotice\WeNotice.exe
#   （zip 与 .sha256 由 build-portable.ps1 生成；如手动打包：tar.exe -a -c -f dist\WeNotice-portable-X.Y.Z.zip -C dist WeNotice）
pwsh tools\check-release.ps1 -Stage post -Version X.Y.Z

# 3) 提交、打 tag、推送（CI 负责构建与创建 Release）
git add -A
git commit -m "release: WeNotice X.Y.Z"
git tag -a vX.Y.Z -m "WeNotice vX.Y.Z"
git push origin main
git push origin refs/tags/vX.Y.Z
```

预发布把 `X.Y.Z` 换成 `X.Y.Z-beta.N` 即可。

## 6. 回滚

- 发错了正式版：先在 GitHub 上把该 Release 标记为 Pre-release（或删除），再打一个新的正式 tag 修复；
- 预发布不需要回滚，直接补 beta 即可；
- 紧急 hotfix：从上一个正式版 tag 拉分支修复 → 验收 → 发 `X.Y.(Z+1)` 正式版。

## 7. 与验收人的约定（写给用户）

- 修复和功能先以 **Pre-release（beta）** 形式提供，Release 页面会标注 `Pre-release`；
- 验收通过后我再打正式 tag，届时 Releases 的 Latest 才更新；
- 一个小问题没有验证通过之前，不会连续发正式版本号。
