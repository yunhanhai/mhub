# MHub

> 本项目由 [艺の公益站](https://ultrarouter.org/sign-up?aff=KnwD) 提供支持。

[![Verify](https://github.com/yunhanhai/mhub/actions/workflows/ci.yml/badge.svg)](https://github.com/yunhanhai/mhub/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

自托管的音乐播放器，用一个队列连接多平台音乐，也可以接入自己的 Navidrome 曲库。Rust 后端、Vue 前端，支持浏览器无损播放、逐字歌词和公开曲目的离线收听。

本仓库基于 [jizizr/mhub](https://github.com/jizizr/mhub) 开发，新增可选的授权曲库、原件校验、独立离线页面及播放恢复功能，沿用 **AGPL-3.0-only** 许可证。

[GitHub](https://github.com/yunhanhai/mhub) · [Gitee](https://gitee.com/yunhanhai/mhub) · [快速启动](#快速启动) · [授权曲库](#授权曲库navidrome) · [部署指南](docs/deployment.md) · [架构说明](docs/architecture.md) · [参与贡献](CONTRIBUTING.md)

## 功能

| 能力 | 使用方式 |
| --- | --- |
| 多平台音乐 | 搜索、歌单导入、跨平台匹配；支持 Apple Music、网易云、QQ 音乐等平台，按需配置账号 |
| 播放队列 | 追加、替换、下一首播放、拖动排序、随机与循环；可使用 Apple Music AutoPlay 推荐 |
| 浏览器无损播放 | ALAC 通过 WASM 解码并交给 Web Audio，其他格式使用原生音频；音质按播放时设置选择 |
| 歌词与界面 | 逐字歌词、简繁转换、封面取色背景，以及桌面和手机布局 |
| PWA 与离线 | 可安装为应用；多平台音频与歌词使用 IndexedDB 缓存，独立曲库可显式保存公开曲目 |
| 自有曲库 | 可选接入 Navidrome，为公开、受限曲目分别检查访问权限，原生播放 MP3 / FLAC |
| 账号与同步 | 可选通行密钥登录、资料库跨设备同步，以及在另一台设备上接着听 |
| 外部服务 | 可选回环音源网关，让同机 Telegram bot 等服务复用平台账号、下载和缓存 |

平台能力取决于账号、地区和上游接口。后台续播使用预加载和 Media Session，具体表现仍需在目标手机与浏览器上验证。仓库不提供平台账号或媒体文件，Apple Music 需自行配置账号及 wrapper 服务。

## 界面预览

以下展示多平台播放器；可选的独立授权曲库位于 `/library/`。

<p align="center">
  <img src="docs/images/desktop-home.webp" alt="桌面首页：推荐列表、侧栏与底部播放条" width="100%">
</p>
<p align="center">
  <img src="docs/images/desktop-playlist.webp" alt="歌单详情与封面取色背景" width="49%">
  <img src="docs/images/desktop-lyrics.webp" alt="全屏逐字歌词" width="49%">
</p>
<p align="center">
  <img src="docs/images/mobile-home.webp" alt="手机首页" width="24%">
  &nbsp;&nbsp;
  <img src="docs/images/mobile-lyrics.webp" alt="手机全屏歌词" width="24%">
</p>

## 快速启动

需要 Docker Engine 和 Docker Compose v2。首次构建会编译 Rust、ALAC WASM 和前端，耗时取决于机器与网络。

```sh
git clone https://github.com/yunhanhai/mhub.git
cd mhub
cp config.example.toml config.toml
cp .env.example .env
# 按需编辑 config.toml；空凭据可启动界面和健康检查。
docker compose up -d --build
```

也可以从 Gitee 克隆：

```sh
git clone https://gitee.com/yunhanhai/mhub.git
```

打开 <http://localhost:8000>。默认只绑定本机回环地址；对外提供服务时使用带访问控制的 HTTPS 反向代理。多平台接口使用服务端配置的共享账号，应由反向代理保护；独立授权曲库另有会话与访问检查。

```sh
docker compose ps
docker compose logs --tail=100 music
curl --fail http://localhost:8000/health
docker compose down
```

配置文件只读挂载，缓存保存在 `music-data` 命名卷中。`docker compose down` 保留缓存，`down -v` 会删除卷。升级、备份、外部服务和媒体域配置见[部署指南](docs/deployment.md)。

## 授权曲库（Navidrome）

希望播放自己拥有或已获授权的原始音乐时，可以启用独立曲库。它复用 MHub 播放器，通过同源接口连接 Navidrome；浏览器不接收源端凭据。

1. 准备 Navidrome、专用非管理员服务账号，以及包含曲目身份、大小、SHA-256 和访问规则的可信清单。
2. 在仓库及构建上下文之外保存私有曲库 JSON、清单与缓存目录；字段示例见[架构说明](docs/architecture.md#授权曲库)。
3. 在 `config.toml` 中启用曲库，并将这些路径按[部署指南](docs/deployment.md#可选授权曲库)挂载到容器。

```toml
[library]
config_file = "/app/private/library.json"
exclusive = true
```

`exclusive = true` 只提供授权曲库，根路径跳转到 `/library/`；设置为 `false` 可与多平台播放器共存。曲库默认关闭，配置修改后需重建服务进程。

- **访问权限**：公开曲目由服务账号读取；受限曲目要求 Navidrome 用户登录，并同时检查清单与源端权限。该登录独立于 MHub 的通行密钥账号。
- **原件与缓存**：首次播放等待完整 MP3 / FLAC，校验大小和 SHA-256 后发布；退出、取消或过期会使相应任务失效。
- **离线收听**：先打开独立页面，再显式保存公开曲目。保存成功后可断网重开页面、浏览和播放；受限曲目不保存到浏览器。
- **使用范围**：当前使用固定清单，最多 100 首、每文件 32 MiB，默认原件缓存预算 128 MiB；不支持此入口的 ALAC 或受限离线授权。

接口、队列、失败恢复和缓存规则见[架构说明](docs/architecture.md#独立曲库离线页面)，测试素材与验证命令见[曲库验证说明](docs/deployment.md#授权曲库验证)。桌面检查不代表手机后台或公网部署已经验收。

## 技术栈与结构

| 部分 | 技术与入口 |
| --- | --- |
| 后端 | Rust · Axum · Tokio；`src/` 负责平台适配、播放任务、缓存和授权曲库 |
| 前端 | Vue 3 · Pinia · Vite · Yjs；`frontend/src/` 负责界面、队列和浏览器缓存 |
| 播放与歌词 | 原生音频 · ALAC WASM · Web Audio · Media Session · AMLL · OpenCC |
| 可选存储 | MySQL 账号与缓存索引、Telegram 音频文件仓库 |
| 开发与部署 | `frontend/tests/`、`scripts/`、`wasm/alac-decoder/`、Docker 与 Compose |

完整的[部署层级与歌曲数据流](docs/architecture.md#架构图)放在架构文档中。

## 本地开发

需要 Rust 1.96+、Node.js 22.12+、FFmpeg / FFprobe。后端默认监听 `127.0.0.1:8000`，前端开发服务把 API 代理到该地址。以下环境变量命令使用 POSIX shell 语法。

```sh
cp config.example.toml config.toml
MUSIC_API_CONFIG=config.toml cargo run --locked
```

另开终端启动前端：

```sh
npm --prefix frontend ci
npm --prefix frontend run dev
```

PowerShell 中先用 `$env:MUSIC_API_CONFIG = 'config.toml'` 设置变量，再运行 `cargo run --locked`。需要后端同时提供 `/library/` 时，先运行 `npm --prefix frontend run build`，并设置 `MUSIC_API_SERVE_WEB=true`。

前端带有生成好的 ALAC 绑定；修改解码器时按[解码器说明](wasm/alac-decoder/README.md)重建。Docker 始终从源码构建。

提交前运行格式、相关测试和发布检查：

```sh
cargo fmt --check
cargo test --locked
cargo test --manifest-path wasm/alac-decoder/Cargo.toml --locked
npm --prefix frontend test
npm --prefix frontend run test:build
python3 scripts/publication_check.py
```

访问真实平台的测试默认跳过，需要自行提供配置并显式运行。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请参考 [SECURITY.md](SECURITY.md)。

## 支持与致谢

感谢 [艺の公益站](https://ultrarouter.org/sign-up?aff=KnwD) 为本项目提供支持，感谢 [LINUX DO](https://linux.do/) 社区。

感谢原项目 [jizizr/mhub](https://github.com/jizizr/mhub) 及第三方开源作者。此版本的上游基线为 [6968bbf](https://github.com/jizizr/mhub/tree/6968bbfc0a26738a5f6126102d912eed78ad91bc)，来源说明与第三方许可保留在 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

## 许可与版权

MHub 以 **[AGPL-3.0-only](LICENSE)** 发布。可以自由使用、修改，也可以商用，但通过网络向他人提供修改后的版本时，需要向这些用户提供对应源码；Docker 镜像的 `/source.tar.gz` 就是为此准备的。项目没有另行提供商业授权。

主要第三方组件及其许可：

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Apple Music-like Lyrics](https://github.com/amll-dev/applemusic-like-lyrics)（`@applemusic-like-lyrics/*`） | AGPL-3.0-only | 歌词渲染与网格渐变背景，打包进前端 |
| [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) | AGPL-3.0 | 播放与歌词交互的参考实现 |
| `widevine`、`widevine-proto` | GPL-3.0 | 依 GPLv3 / AGPLv3 第 13 条可与本项目结合发布 |
| `webauthn-rs`、`cssparser`、`selectors` 等 9 个 crate | MPL-2.0 | 文件级 copyleft，按原样使用、未修改 |
| `webpki-roots` | CDLA-Permissive-2.0 | 根证书数据 |
| [opencc-js](https://github.com/nk2028/opencc-js) | MIT，词典 Apache-2.0 | 简繁转换 |
| Vue、Pinia、Yjs、gl-matrix | MIT | 前端运行时 |
| [Lucide](https://lucide.dev) | ISC | 图标 |
| Axum、Tokio、reqwest、sqlx 等 | MIT / Apache-2.0 | 后端主要依赖 |
| `wasm/alac-decoder` 及上游 alac | MIT OR Apache-2.0 | 独立子项目，保留原许可 |

完整清单（446 个 Rust crate、93 个前端运行时包）连同各自的许可文本见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 与 `frontend/public/legal/third-party-notices.txt`，可用 `scripts/generate_notices.py` 重新生成。来源说明见 [NOTICE](NOTICE)。

界面设计参考了 Apple Music 网页版，但没有使用 Apple 的代码、图标、Logo 或字体：界面只用系统字体，SF Pro 受 Apple 字体许可约束，不随项目分发。Apple Music、网易云音乐、QQ 音乐、酷狗音乐、哔哩哔哩、汽水音乐、YouTube Music 是各自权利人的商标，本项目与它们没有任何关联。通过这些平台获取的音乐、封面和歌词，版权归权利人所有，使用时须遵守各平台的服务条款。AGPL 只覆盖本项目的代码，不授予这些内容的任何权利，尤其不包括商业使用。README 截图中的封面和歌词仅作功能展示。
