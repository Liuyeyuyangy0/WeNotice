# 用 SignPath Foundation 给 WeNotice 做免费开源签名

[SignPath Foundation](https://signpath.org/) 给开源项目提供**免费**的 Windows 代码签名：
证书由基金会持有、私钥在 HSM 里，签名在 CI 中自动完成，用户下载的 exe 能看到
「WeNotice — 由 SignPath Foundation 签名」。

免费的前提（官方要求）：

- 项目是**公开仓库**、使用 **OSI 认可的开源许可证**（本项目 MIT，满足）；
- 所有构建都必须跑在 **GitHub 托管的 runner** 上（本项目用 `windows-latest`，满足）；
- 需要通过 SignPath 的 GitHub 集成验证「二进制确实由该仓库构建」。

> 注意：证书是发给「项目」的，不是发给你个人的，所以别人能验证 exe 来自本仓库；
> 但 SmartScreen 信誉仍需随下载量积累，刚签完名第一次下载仍可能提示。

---

## 第一步：提交申请

打开 <https://signpath.org/apply>，填写表单。参考填写内容：

| 字段 | 填写 |
| --- | --- |
| Project name | `WeNotice` |
| Repository URL | `https://github.com/Liuyeyuyangy0/WeNotice` |
| License | `MIT` |
| Project website（如有） | `https://github.com/Liuyeyuyangy0/WeNotice` |
| 项目简介 | 微信消息自动筛选「通知类消息」的 Windows 桌面应用，Electron + 原生 JS，本地处理数据，不上传聊天内容。 |
| 构建方式 | GitHub Actions（`windows-latest`），产物为便携版 ZIP；需要签名的是启动器 `WeNotice.exe`。 |
| 维护者 | 你的 GitHub 用户名 + 邮箱 |

提交后等邮件（一般几个工作日）。期间可以先跑仓库里的 CI 验证构建（未签名也能出包）。

---

## 第二步：批准后，在 SignPath 里配置

1. 登录 <https://app.signpath.io>，进入你的 **Organization**。
2. **Trusted Build Systems** → 添加 `GitHub.com`（SignPath 用它验证产物来自 GitHub Actions）。
3. **Projects** → 新建 project，slug 例如 `wenotice`，关联上面的 build system。
4. **Signing Policies** → 新建策略，slug 例如 `release-signing`（可设为需要审批，或自动签名）。
5. **Artifact Configurations** → 新建，slug 例如 `wenotice-launcher`，内容粘贴
   仓库里的 [`signpath/wenotice-launcher-artifact-config.xml`](../signpath/wenotice-launcher-artifact-config.xml)。
6. **GitHub App**：在 <https://github.com/apps/signpath> 安装并授权给 `WeNotice` 仓库
   （SignPath 需要读 Actions 产物、写审计信息）。
7. 记下 Organization 的 **Organization ID**（Organization settings → General）。
8. **API Tokens** → 新建 token（CI 用），复制保存，只显示一次。

---

## 第三步：配置 GitHub 仓库

`Settings → Secrets and variables → Actions`：

**Variables**（普通变量，`vars.` 读取）：

| 名称 | 值 |
| --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | 上一步的 Organization ID |
| `SIGNPATH_PROJECT_SLUG` | `wenotice` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |
| `SIGNPATH_ARTIFACT_CONFIG_SLUG` | `wenotice-launcher` |

**Secrets**（加密变量，`secrets.` 读取）：

| 名称 | 值 |
| --- | --- |
| `SIGNPATH_API_TOKEN` | 第二步第 8 点的 API token |

> 没配置 `SIGNPATH_PROJECT_SLUG` 时，workflow 会自动跳过签名，仍然产出未签名的包。

---

## 第四步：跑流水线

`.github/workflows/release.yml` 有两种触发方式：

1. **打 tag 发版**：`git tag v1.0.1 && git push origin v1.0.1`
   → 自动构建、签名、打包 ZIP、创建/更新 GitHub Release（附 `.sha256`）。
2. **手动运行**：Actions → `Build & Release (portable)` → Run workflow
   → 产物在 Actions 的 Artifacts 里（适合先验证构建）。

签名前后可以这样检查：

```powershell
# 从 Actions 下载 ZIP 解压后
Get-AuthenticodeSignature .\WeNotice\WeNotice.exe | Format-List Status,SignerCertificate,TimeStamperCertificate
# 期望：Status=Valid，SignerCertificate 的 Subject 含 SignPath Foundation
```

---

## 常见问题

**Q：为什么只签 `WeNotice.exe`，不签 `electron.exe`？**
A：`electron.exe` 是 Electron 官方发布的运行时（几亿人用、版本公开可校验），不属于我们的代码；
我们的入口是启动器 `WeNotice.exe`，用户双击的就是它。把 240MB 的运行时也签一遍没有收益。

**Q：免费签名要花钱吗？**
A：SignPath Foundation 对开源项目免费；申请、证书、签名都不收费。商业用途需另购 SignPath.io。

**Q：签了名 SmartScreen 就不提示了吗？**
A：不是。SmartScreen 看的是「证书 + 下载量/时间积累的信誉」。新证书、新发布仍可能提示；
坚持用同一个证书签名、积累下载量后提示会消失。

**Q：本地自己签和自己的项目证书冲突吗？**
A：不冲突。`tools/sign-exe.ps1` 用于本地自签名测试；正式发布用 SignPath 证书。
GitHub Release 里的包以 Release 构建产物为准。

**Q：项目以后改名/换仓库怎么办？**
A：在 SignPath 项目设置里更新仓库链接，重新走一次集成验证即可；历史签名不受影响。
