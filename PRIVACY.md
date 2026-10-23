# Privacy Policy — WeNotice

**Last updated: 2026-10-23**

WeNotice is an open-source Windows desktop application (MIT license) that reads WeChat messages
from a **local** data source and shows you the ones you care about as desktop notifications.

## Summary

- **We do not collect, transmit, sell, or share any personal data.**
- There is no telemetry, no analytics, no crash reporting, and no account system.
- All message data stays on your own computer.
- The only optional outbound network request is the **optional** AI classification feature, which
  you must explicitly enable and configure with your own API endpoint and key (see below).

## What data WeNotice processes

| Data | Where it comes from | Where it is stored |
| --- | --- | --- |
| WeChat message metadata and text | The local HTTP API of a separate, user-installed third-party app (AstrWeChat / WeFlow, `http://127.0.0.1:5031`) | Local files under the application's data directory (`config.json`, `rules.json`, `history.json`), at most 2000 messages by default |
| Access token for that local API | Copied by the user from AstrWeChat's settings | Local `config.json` in plain text |
| App settings and notification rules | Entered by the user | Local `config.json` / `rules.json` |
| Optional AI settings (base URL, model name, API key) | Entered by the user | Local `config.json` in plain text |

Nothing is uploaded anywhere by WeNotice itself.

## Optional AI classification

If (and only if) you enable "AI 辅助判定" in Settings and provide an OpenAI-compatible API endpoint
and key, WeNotice sends the **text of messages it is unsure about** to that endpoint (which you
configure yourself, e.g. your own server or a provider you chose). No other data is sent.
If the request fails, the app silently falls back to the local rule engine.
You can disable this feature at any time; no data is sent while it is disabled.

## Third-party software

WeNotice does not bundle or redistribute WeChat, AstrWeChat, or WeFlow. AstrWeChat is a separate
open-source project (AGPL-3.0) that you install yourself; its own data handling is governed by
its own documentation and license. WeNotice only talks to its loopback HTTP API at 127.0.0.1.

## Children's privacy

WeNotice is a general-purpose desktop utility and is not directed at children. It does not
knowingly collect personal information from anyone.

## Changes to this policy

Any material change to this policy will be committed to this repository and noted in the release
notes. The up-to-date version always lives at this URL.

## Contact

Open an issue at <https://github.com/Liuyeyuyangy0/WeNotice/issues>.
