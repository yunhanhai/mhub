# Docker 部署

## 部署边界

镜像包含前端、Rust 后端、从源码构建的 ALAC WASM、FFmpeg/FFprobe、健康检查及对应源码包。镜像不包含平台账号、wrapper 认证环境、MySQL 或 Telegram 服务。没有凭据也可启动界面和健康检查；完整播放能力需要对应平台的有效配置。

首次部署按根目录 README 复制 `config.example.toml` 为 `config.toml`，复制 `.env.example` 为 `.env`，然后运行 `docker compose up -d --build`。配置文件必须在启动前存在，Compose 不会将缺失文件误建为目录。

容器以 UID/GID `10001:10001` 运行，根文件系统只读，去除 Linux capabilities，临时目录单独挂载，日志轮转。默认仅发布到 `127.0.0.1:8000`。命名卷首次创建会继承镜像的数据目录权限；使用已有绑定目录时，应先为 UID 10001 授予写权限。

首次构建会下载 Rust、Node、Python、FFmpeg 及依赖，并从源码构建后端与 ALAC WASM。`CARGO_BUILD_JOBS` 默认是 `1`，以减少同时编译多个 Rust crate 的内存占用；这不限制 BuildKit 的其他阶段或运行中的服务。内存有限时，可为单独的 `docker-container` builder 设置 CPU、内存及 `[worker.oci] max-parallelism = 1`，再显式选择该 builder。运行上限另在本机 Compose override 的 `mem_limit`、`cpus` 中设置，编译限制不会自动传递给音乐容器。不要把机器的 CPU 核数或内存上限当作经过验证的并发听众容量。

## 配置

| 位置 | 用途 | 生效方式 |
| --- | --- | --- |
| `config.toml` | 平台凭据、wrapper 地址、可选数据库、Telegram、账号 `[auth]`、音源网关 `[gateway]` 和授权曲库 `[library]` | 修改后重建容器进程 |
| `.env` | 监听地址、端口、日志级别及可选媒体域 | `docker compose up -d` |
| `MUSIC_MEDIA_BASE_URL` | 已完成媒体的独立源；默认同源 | 改动后 `docker compose up -d --build` |
| `MUSIC_LEGACY_MEDIA_BASE_URL` | 迁移后旧队列媒体地址的兼容源 | 改动后重新构建前端 |

媒体域必须是无用户名、密码、路径、查询参数的 HTTP(S) origin。配置后，前端把正在生成（`streaming`）和已完成的音频都发往媒体域，接口、封面、歌词等小请求仍走主站，避免音频占用页面带宽。启用独立媒体域时，应配置正确 CORS、Range、版本查询参数与缓存策略；CDN 必须遵循源站的 `Cache-Control`：生成中的流返回 `no-store, no-transform`，同一 URL 完成后才返回可缓存的完整文件。只缓存已完成的成功媒体响应，不能缓存播放任务状态、未就绪流或错误响应，也不能对音频路径强制覆盖边缘缓存时间或缓冲响应。

`config.toml` 中空字符串表示未配置。按需填写平台 Cookie 或 `music.applemusic`，不需要把模板中每个平台都启用。YouTube Music Cookie 可通过后端环境变量 `YOUTUBE_MUSIC_COOKIE` 注入；其他环境覆盖见源码 `settings.rs` 及各平台适配器。

不要把 Cookie、token、数据库密码放入 `Dockerfile`、构建参数或前端环境变量。Vite 变量会公开到浏览器。

## 外部服务

- **Apple Music**：自行部署并认证兼容的 raw wrapper 或 wrapper-lite，在配置中填入容器可访问的地址。`127.0.0.1` 在容器里指容器自身。wrapper-lite 默认关闭；需要时设置 `wrapper_lite_enabled` 和对应 URL，保留旧 wrapper 回退配置。区域、账号授权和上游可用性仍然影响下载。Widevine 兼容路径需要自行提供 `wv_device` 设备文件，或 `wv_client_id` 与 `wv_private_key` 文件对；将文件只读挂载并填写容器内路径，公开版本不再内置第三方测试设备凭据。
- **MySQL**：填写已有兼容 `music_cache` 表的数据库 URL；不启用数据库时仍可运行应用，但不能复用数据库记录的远端缓存。除启用账号后自动创建的 `mhub_` 前缀表外，本项目不会创建或迁移外部数据库。
- **Telegram**：填写 Bot token、缓存 chat ID 和可选 Bot API 地址。大文件通常需要自建 Local Bot API。该服务与本容器必须共享文件存储，并通过 `MUSIC_API_TELEGRAM_LOCAL_ROOT`、`MUSIC_API_TELEGRAM_CONTAINER_ROOT` 对齐路径；可在自己的 Compose override 中添加只读共享卷和这两个环境变量。不要把整个账号数据目录复制进镜像。Telegram 把文件存在上传者所在的数据中心；若主 bot 的数据中心离服务器很远，大文件上传会很慢。可另建一个数据中心离服务器近的上传 bot，把两个 bot 都设为一个私有频道的管理员，在 `[music]` 填 `upload_channel_id`，并把上传 bot 的 token 放进 `upload_bot_token_file`（默认 `/etc/music-gateway/uploader-token`，权限 0600）：上传 bot 把歌发到频道，主 bot 转发一次取得自己的 `file_id`，任一步失败都回退为直接上传。
- **本地音频缓存**：`data/downloads` 下每首歌一个目录，存放解密后的音频和按需生成的 ALAC 包、浏览器用 FLAC。它只是 Telegram 与各平台之上的加速层：后端每 15 分钟（以及启动时）清理一次，连续 `[audio_cache] idle_hours`（默认 72）小时无人请求的目录被删除，总量超过 `max_gib`（默认 20）时从最久未用的开始删到 90%。正在下载或 30 分钟内写入、请求过的目录不会被删。已上传 Telegram 的歌之后从 Telegram 取；未上传的（未配置 Telegram 或上传失败）会重新下载。Local Bot API 自己的文件目录不归本服务管理。

- **音源网关（可选）**：让同机的其他服务（如 Telegram bot）借用本服务的平台账号、下载和 Telegram 缓存，账号只需在这里配置一次。在 `[gateway]` 设置 `listen`（只用回环地址，例如 `127.0.0.1:8091`，不要经反向代理或 CDN 暴露）和至少 32 字符的令牌，令牌建议放在权限 0600 的 `token_file` 中，并在客户端配置相同令牌。网关与网站共用同一套播放任务：网页和 bot 同时请求同一首歌只下载、上传一次；平台请求、限流、Apple wrapper 并发和网易登录续期都只在这里发生。容器部署时，网关端口须发布到宿主机回环地址或放进与客户端共享的内部网络。客户端用 Telegram `file_id` 发送，因此必须使用同一个 Bot token。接口与客户端见 `crates/music-gateway`。

本仓库不分发 wrapper 二进制或第三方服务的认证数据，也不把任何外部服务的认证操作伪装成镜像首次启动过程。

## HTTPS 反向代理

Service Worker、媒体会话等浏览器功能需要安全上下文。除本机开发外使用 HTTPS。反向代理对音频请求应关闭响应缓冲、支持长连接和 Range，保留响应的 `Cache-Control`、`ETag`、`Content-Range` 等头，并设置适合大文件的超时。

示例 Nginx location（放入已有 TLS 站点，并配置自己的访问控制）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 600s;
}
```

此处使用 `$http_host` 保留非默认外部端口；曲库 `origin` 配置须完全匹配。只发布 TLS 代理入口，将 Rust 和 Navidrome 端口留在受控内部网络；不要以客户端提供的 `X-Forwarded-*` 作为访问许可。反向代理自身还需配置有效证书、自己的 server_name 和请求限制。

以下配置按 Caddy 2.11.9 编写。将站点名换成自己拥有且已解析到代理的域名，回源地址换成实际 Rust 监听地址；曲库 `origin` 同步设为浏览器使用的完整 HTTPS origin。Caddy 为实际域名申请证书，正式运行前执行 `caddy validate --config Caddyfile --adapter caddyfile`。

```caddyfile
{
    admin off
    servers {
        protocols h1 h2
        strict_sni_host on
        max_header_size 16KB
        timeouts {
            read_header 10s
            write 0s
            write_idle 15s
            idle 30s
        }
    }
}

music.example.com {
    reverse_proxy 127.0.0.1:8000 {
        flush_interval 20ms
        transport http {
            versions 1.1
            dial_timeout 2s
            response_header_timeout 10s
        }
    }
}
```

HTTP 回源会保留客户端的 Host 与端口。`strict_sni_host on` 让 TLS SNI 与请求 Host 的主机名不一致时返回 421；应用继续检查完整 authority，包括端口。省略该选项时，未匹配站点的错误 Host 可能得到空的 200，因此应直接检查状态和正文，不能把“请求成功”理解为已到达曲库。代理不配置音频响应缓存，保留应用的 `no-store`、ETag 和 Range 语义。

`write` 是整份响应的总期限，`write_idle` 限制一次写入停滞的时间；前者设成 4 秒会截断仍在前进的慢下载。这里不另设代理总期限，使用 15 秒写入空闲期限，并保留应用自身的会话、任务和资源上限。`idle` 只限制连接等待下一个请求，不能代替写入空闲期限。`flush_interval` 控制发送批次，已进入代理、TLS 或 TCP 缓冲的字节仍可能在退出后到达客户端。

旧平台音乐 API 使用共享账号，原有账号只保护个人歌单和接力播放。独立公开曲库应使用下方的 `exclusive = true`，使旧路由根本不注册。保留综合站点模式时，曲库检查仍只覆盖 `/api/v1/library/`，应在代理层统一控制其他接口访问。CORS 和静态首页登录不能代替这些控制；代理日志不记录 Cookie 或敏感查询参数。

## 可选授权曲库

在 `config.toml` 设置以下内容，并按[架构说明](architecture.md#授权曲库)准备私有配置和曲目清单：

```toml
[library]
config_file = "/absolute/private/library.json"
exclusive = true
```

`exclusive` 默认 false，明确设为 true 才成为独立曲库站点。根路径跳转 `/library/`，只提供该页面所需资源、新曲库接口、健康检查和带许可证的源码归档；旧 `/api/v1/platforms`、共享播放、账号、同步、主页面及根 Service Worker 不再提供。缺少曲库配置会拒绝启动。页面含源码下载链接；每次构建后运行 `python3 scripts/package_source.py web/source.tar.gz` 更新归档。首次试用使用专用主机名，已有综合站点的根 Service Worker 和浏览器存储迁移另行验证。

独立曲库使用 `/library/sw.js` 与独立安装身份 `/library/`。浏览器首次联网成功准备页面后，已保存的公开曲目支持断网重新打开；只有用户主动保存的音频进入IndexedDB。Worker更新请求使用 `updateViaCache: none`，安装时使用不带账号凭据的静态请求并校验SHA256，不缓存曲库API或受限媒体。正式域名必须使用HTTPS，本机127.0.0.1可用开发安全上下文。

曲库播放队列只属于当前页面，刷新或账号变更后清空，已保存的公开音频仍保留。页面提供追加当前结果、替换队列并播放及曲目菜单中的下一首播放；搜索不改变既有顺序。更新验收应同时检查暂停后的音频副本保留与新页面队列清空，其他标签页不得被强制刷新。

队列交互验收需检查未变化曲目行与原生按钮保持、同一曲目重排后的序号、删除待播后相邻可用动作以及清空后的标题焦点。播放准备完成只恢复仍属于该动作的焦点，用户已经转去搜索时不抢回；断网移除不可用待播也须恢复可用焦点。计数仅在内容改变时更新，以一个完整状态供辅助技术读取；正常播放刷新不得强制滚动回仍有焦点的队列按钮。用实际滚轮和键盘分别检查自由滚动及固定播放栏避让；DOM与ARIA检查不等同于真机触摸或读屏软件验收。

浏览页支持关键词、专辑名称、格式、已保存筛选和稳定排序，条件在当前可访问目录内计算。输入文字即时筛选，提交搜索同时重新读取授权目录；离线则只筛选公开副本。刷新和账号切换清空关键词、专辑与格式，排序枚举单独记忆。每批显示24项，列表操作仍使用完整筛选结果。原件库规模上限不因此扩大，正式扩容需要同时设计后端分页、策略管理与资源预算。

列表交互验收使用实际键盘和同源两页：一页展开菜单并将焦点置于动作，另一页保存或移除不同曲目，检查未变化行和菜单保持、焦点可见且动作仍指向当前曲目。同版本元数据刷新须同时更新文字、时长、无障碍名称和动作数据；换原件版本、账号切换或目录失效须删除旧控件。检查键盘移除最后副本、移除中主动转去搜索、重新排序与已显示的更多批次；列表同步期间实际音频仍保持同一音源并前进。缩窄窗口或固定播放栏不能遮住恢复后的焦点，DOM变化数量的观察不等同于长期内存或手机后台性能测量。

播放准备还应跨同页入口验收：曲库、离线列表和队列选择同一首时只有一个准备请求，所有对应按钮同步等待且保留其他曲目与暂停控制。用实际POST后延迟确认、已保存原件SHA延迟和实际原生play后的确认延迟分别验证；仅disabled不能作为重复操作的唯一防线，旧回调重复调用也须合并。换目标、暂停后重选和迟到旧结果不得覆盖新音源；“替换当前结果”依然改变队列，不能误合并为单曲选择。原速自然EOF进入续播准备也不得被同曲目重复选择打断。延迟原生确认与暂停之后人工发起新的play是不同情形，测试不可混淆。等待文案不应导致窄屏控件跳动，完成后的焦点和Worker空闲检查也须核对。

失败恢复验收从实际协议入手：登录后通过同一浏览器的API退出会话但保留旧页面，选择受限曲目应得到账号确认动作，确认后旧目录清除且公开离线副本仍保留；再显式登录与选择才能播放。注入旧目录版本并让真实后端拒绝，刷新后应聚焦当前版本控件，保留队列并等待用户选择；缺少实例需要重新连接。失败任务错误码、暂时服务故障和无法解析的响应分别检查，不能依赖消息文字区分权限。延迟刷新时验证重复动作、暂停、切换曲目、移动焦点及两页更新阻止，最终用实际原件播放核对。响应或时间注入与真实会话/音频证据分别记录。

界面渲染测量可运行`node scripts/library-lab/measure-rendering.mjs OUTPUT http://127.0.0.1:PORT`，使用专门的两份公开自制音频实例与临时浏览器资料；可设置`PLAYWRIGHT_MODULE`和`BROWSER_EXECUTABLE`。脚本对两曲/100项元数据、空闲/播放四种条件进行两轮反序测量，每组15秒；新增条目仅为合成元数据，实际播放仍用原MP3。播放原件临时循环以跨越测量窗口，另用原速自然EOF回归证明续播。记录CDP渲染工作、渲染进程CPU时间、节点修改和GC后JS堆；测量工具本身有开销，优化前后须保持相同工具与条件，避免并行构建/性能实验。节点/JS堆不代替进程RSS与私有内存，也不代表数小时真机收听。只有实际播放状态或队列输入变化应更新控件，正常进度刷新不得反复修改不变的队列或错误播报。

进度条验收须观察真实原生currentTime：焦点停留而不编辑时继续跟随播放；实际鼠标移动或按住方向键只预览，松开只提交一次。分别验证播放、暂停、公开离线Blob、Home/End、Escape、切歌、失去焦点与来源变化；源准备时不可跳转。预览和原生跳转未结束应阻止页面更新，取消之后允许空闲更新。不能仅以range数值或合成seeked证明音频已到目标位置。原生range可能保留浏览器自己的鼠标捕获，提前捕获丢失的注入要标明；整页截图会调整视口并取消正在进行的拖动，预览截图使用固定视口，设备触摸行为另行验收。

从原件生成元数据和封面候选，使用已经安装的FFprobe与FFmpeg，不需要额外Python库：

```sh
python3 scripts/library-lab/scan_library.py /music \
  --output /private/library-scan \
  --bindings /private/file-bindings.json \
  --previous-policy /private/policy.json
```

绑定文件示例为 `{"instanceId":"library-instance","files":[{"path":"Album/song.flac","songId":"navidrome-song-id"}]}`，路径相对于音频目录。不要在绑定里设置access或allowedUserIds。输出目录必须新建且位于原件目录外；inventory.json、candidate-policy.json、changes.json和artwork目录属于私有实例数据，不进入源码包或镜像。未提供绑定时仅扫描和提取，不生成策略。新增条目默认无账号授权；在核对候选和原件映射后，运营者明确维护授权，按原有流程替换策略，不自动覆盖在线文件。

需要显示封面时，在曲库JSON配置中添加 `"artworkDir":"/app/config/artwork"`，将扫描输出的artwork目录只读挂载到该位置。策略的artwork是hash/size/width/height/contentType描述符，服务器只读对应hash.jpg，不接受URL或任意文件路径。保留音频原件及策略备份，应用元数据候选不应更改原件哈希或访问权限；同长度原件换版仍须重新扫描。原件没有嵌入图片时显示占位，不自动向外部图库请求封面。缩略图的显示与离线音频保存分别验收，实际手机系统栏图片仍需真机确认。

发布时一起更新HTML、Worker、带哈希的JS/清单/图标及其br/gzip兄弟文件，核验解压后的字节；保留旧页面可能引用的哈希资源。新Worker等待用户暂停后点击更新，并检查其他曲库页面也已空闲；不会为更新清除音频IndexedDB。安装按钮只在浏览器提供安装事件时出现，其他浏览器可用自己的“添加到主屏幕”入口。页面仅显示当前实例已保存的公开副本及占用空间；换端口或主机名会成为另一份浏览器存储。

显式设置 `MUSIC_API_CONFIG` 时，文件不存在或无法读取会拒绝启动，不回退默认综合站点。主配置中的未知顶层字段、`[library]` 中的未知字段及无效 TOML 也会失败；迁移时删除无效或过时字段。只有没有显式设置配置路径、默认开发文件确实不存在时才沿用无配置启动。解析失败日志不回显可能包含凭据的配置行。

私有 `origin` 必须与浏览器实际使用的 HTTPS origin 完全一致，包括非默认端口。HTTPS Cookie 使用 `__Host-` 前缀、Secure、HttpOnly、SameSite=Strict、Path=/，无 Domain。旧的 HTTP 开发 Cookie 不用于 HTTPS 身份；重启后重新登录。仅曲库模式的页面禁止嵌入其他页面，但这不改变已交付音频的可复制性。

本机原生运行先执行 `npm --prefix frontend run build`、`cargo build --locked --bin music-api`，再以 `MUSIC_API_CONFIG` 指定主 TOML，设置 `MUSIC_API_SERVE_WEB=true` 后启动程序。在配置的 origin 打开 `/library/`；无需另起 Node 服务。此页面生成在 `web/library/`，主界面的平台选择器和原有账号入口尚未与曲库合并。

离线并发协调需要安全上下文的Web Locks（HTTPS或浏览器认可的回环来源）；跨标签页仅限相同来源与存储分区、运行该协调代码的页面。不支持该API时仍可单页保存和重试，但不能承诺多个标签页只下载一次。上线前用两页实际保存/移除、下载失败、写入失败及快速切歌核验，区分故障注入和自然错误。浏览器存储配额与系统可用磁盘空间不同，保存失败时应腾出空间并重试，不自动删除既有副本来掩盖配额错误。

显式离线下载按可信原件长度最多接受32MiB，只接受完整HTTP200与对应MP3/FLAC媒体类型。下载响应头和正文共用5分钟总期限，15秒没有收到新字节即失败；持续字节只延长空闲期限，不延长总期限。进度100%之后仍须EOF、SHA256与IndexedDB提交成功。验收应实际等待15秒空闲超时，并另外用明确标注的故障注入检查慢流、提前EOF、超长正文、错误MIME、206和校验失败；缩短测试时钟的结果不能写成真实5分钟等待。

逐首取消入口保留在“保存进行中”，搜索筛掉该曲目也能找到。两页等待同一首时取消等待者不停止持锁者，取消持锁者后下一页可继续；取消独立的一首不影响其他保存或播放。写入前取消不留半成品，完整音频提交后取消最终处理则保留副本并提示该边界。还应检查当前页与同源页的副本显示、取消后的重试、可见键盘焦点，以及保存或取消仍未结束时Worker不能激活。真机后台计时和系统存储回收须另行验收。

同时检查本地存储被拒绝、临时打开失败、连接关闭和只读请求超时的行为。页面应保持当前授权在线曲库与播放可用，离线区域显示“暂时无法读取”及重试入口；恢复存储后重新核对已有音频长度和哈希。打开和只读事务的3秒期限分别计时，不代表磁盘吞吐保证。隐私设置、浏览器数据回收、存储分区或模式可能影响IndexedDB/localStorage，不能通过前端绕过浏览器限制，也不应清除数据库来掩盖读取问题。

账号验证与目录回归应分别模拟：真实登录成功后目录503、重开后的目录故障、退出请求未成功、服务器已处理登录/退出但正文丢失，以及旧会话确认迟到。页面应与实际Cookie会话一致，未确认时不显示错误的访客结论；同源其他标签页重新核对，恢复入口不重新发送登录凭据。JSON控制请求25秒总期限和1MiB上限覆盖完整正文；开发中的期限加速必须明确标注，不能把加速测试当作真实25秒计时或公网代理实测。授权音频、私有Cookie和运行配置不写入分享回执。

播放反馈验收应包含浏览器拒绝play()、真实解码器收到无效媒体、准备请求失败、原速自然EOF后的下一曲准备失败、旧请求迟到及重试中暂停。反馈区不能仅依据操作返回值报告“正在播放”，实际原生音源与playing状态须一致；用户重试应保留当前队列。窄屏/横屏检查展开后的播放栏、错误文本对比度、44像素按钮及主控件焦点，页面底部空间使用实际播放栏高度。注入NotAllowedError或错误正文要明确记录，不能声称已经验证所有浏览器权限设置或真机输出。

前端增量更新同时发布HTML、脚本、Worker及其新鲜压缩兄弟文件，并提供匹配源码归档。保留音频IndexedDB及稳定安装身份；新版等待页面空闲，不在保存过程中激活。后端任务取消属于尽力清理，服务端任务期限继续生效；不要依赖关闭页面必达DELETE或因此放宽服务器限额。

容器需要将私有 JSON 和清单只读挂载到配置中的位置，将 `cacheDir` 指向 UID 10001 可写的私有数据目录。它们不进入镜像构建上下文或 `web/`。非回环的上游地址需 HTTPS；Docker 网络主机名的 HTTP 地址不满足当前约束。源码包含构建步骤，但本机验收不等同于容器构建或公网部署验证。

为公开内容使用专用非管理员 Navidrome 账号。登录、搜索和每次媒体授权都依赖上游可用；已有私有磁盘缓存不会绕过失效身份。Navidrome 登录限频保持生效。会话和任务随进程重启失效，磁盘副本保留；先备份私有清单，避免误将受限曲目改为公开。

私有 JSON 可设置 `cacheMaxBytes`（默认 134217728）。为每个实例分配独立缓存目录；新进程若无法获得 OS 文件锁会拒绝启动。更新旧版本时先停止旧进程，锁文件不需要手动删除。缓存目录只放本模块的数据，并由服务端账号独占写入权限。

独立曲库主入口使用 HTTP/1 回源，连接上限 128、媒体正文上限 32；写阻塞超过 15 秒会断开，未完成请求头期限 10 秒，无收发期限 30 秒。TLS 代理应传播客户端中断（Nginx `proxy_ignore_client_abort off`），对客户端连接也配置发送空闲期限（例如 `send_timeout 15s` 或 Caddy `write_idle 15s`）。源端关闭连接不代表代理已经释放它自己的客户端缓冲。下方工具可单独验证实际 Caddy；Nginx、HTTP/3 与公网证书签发需在对应环境验收。

会话与任务期限可通过私有 JSON 的 `sessionTtlSeconds`、`taskTtlSeconds` 缩短；默认 3600、900 秒，不接受零、超出默认上限或拼写错误的字段。退出和自然过期会终止仍在发送的受限响应；取消任务也会关闭该任务的正在发送响应。重连需要重新授权，已到客户端的字节无法撤回。进程收到停止信号后最多等待约 5 秒让独立曲库连接结束。

部署容量使用 `cargo build --locked --release --bin music-api` 的结果测量。32 个响应、64 个会话及 256 条任务记录不能直接换算成用户数：预取、多个 Range、冷文件和每位听众的码率都会改变占用。文件准备仍只有两路，缓存命中也要进行完整哈希校验；其余请求进入最多 16 个表示的等待队列，每个账号最多占 4 个等待位置，匿名请求共用一个组。队列按账号轮转，不抢占运行中的工作；等待超过 5 秒失败。至少区分单一热门文件、混合曲目、冷启动和持续播放。

排队期间任务保持 `preparing`，客户端继续轮询；等待超时返回任务错误 `preparation_timeout`，容量拒绝为 `preparation_queue_full` 或 `preparation_user_limit`。明确提示后由用户重试，避免无界自动重试制造新高峰。相同文件的请求会合并，但各自仍需要授权；退出或会话失效时不得继续使用旧任务。私有诊断增加等待/运行准备数、等待总时长、超时和拒绝次数，仍无公开诊断接口。

重启先清理所属半成品，再允许任务重新授权并校验完整文件。旧版本与闲置缓存自动回收；活跃任务、响应体和下载预留计入容量保护，预算不足时任务明确失败。换版时从可信原件计算新哈希并原子更新清单；不要只替换上游文件然后假设同长度修改已被发现。清单解析错误时访问失败、回收暂停，修复清单后可以继续。

这版用于验证固定 MP3/FLAC 清单、进程恢复和本机 TLS 会话边界，尚未提供多实例共享会话、移动端实测、断电/网络文件系统或公网容量结论。

`LIBRARY_BACKEND=rust node scripts/library-lab/verify-https-boundaries.mjs CONFIG CREDENTIALS REPORT_DIR` 可在自己的回环 Navidrome 上复现 TLS、Cookie、子域和旧接口检查。需要 OpenSSL 及 Playwright/Chromium；支持 `OPENSSL_EXECUTABLE`、`PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`。脚本在临时目录生成证书，结束删除私钥；Node 验证 CA 和主机名，并验证不受信/错误主机名会失败。浏览器仅对该临时叶证书公钥设置进程内证书错误例外，不改变系统证书信任、不启用全局 `ignoreHTTPSErrors`。这验证浏览器会话行为，不等同于验证公网 CA 签发、Nginx 部署或所有 TLS 客户端。

实际代理实验使用 `node scripts/library-lab/verify-proxy.mjs CONFIG CREDENTIALS FIXTURE_STATE OUTPUT`。先设置 `LIBRARY_BACKEND=rust`、`MHUB_RUST_BINARY`、`CADDY_EXECUTABLE`、`OPENSSL_EXECUTABLE`，Windows 原生进程采样另需 `RESOURCE_PYTHON`；浏览器仍使用上述 Playwright 变量。用下方素材工具设置 `RESOURCE_FIXTURE_SECONDS=270` 创建一个足以持续发送的大原件，再传入其私有状态。输出必须用新目录，安装、编译和其他性能实验应先结束。

工具让客户端经过有界 TCP 转发器访问真实 Caddy TLS，再以 HTTP/1.1 回源 Rust。转发器只传 TLS 密文，先双向校准，再测试每连接下行 128 KiB/s、上行 64 KiB/s、每方向 75 ms 的模型；单方向应用队列最多 64 KiB，系统套接字缓冲另计。HTTP/2 窗口和协议开销会使音频有效吞吐低于设定带宽。该模型未模拟公网、丢包或无线抖动。首字节指标从创建任务开始计，另报 TLS 建连时间；真实 Edge 的音频时间前进单独检查，不能用首字节代替可听输出。

连接关闭事件在此转发器中直接传播，75 ms 延迟用于转发的字节；HTTP/1 的 TCP 断开耗时不能作为公网往返延迟。HTTP/2 的单流重置则通过原有 TLS 连接发送，继续受字节节流约束。复现时应保留每个场景的实际配置，区分暂停应用读取与启用链路带宽限制。

`PROXY_CASES` 可选择 `calibration,protocols,slow,reset,logout,expiry,total-timeout,stalled,browser`。普通实验的 `write_idle` 为 4 秒；总期限负面对照改用 `write 4s` 并关闭写入空闲期限，预期截断，不能计作产品缺陷。`PROXY_STRICT_SNI_HOST=0` 仅用于回环配置反例，正常测试保持默认严格匹配。Node 验证临时 CA 和主机名，Edge 仅对该临时叶证书公钥设置进程例外；结束删除私钥。

诊断文件在曲库请求结束或约每 5 秒刷新，读取旧文件不能精确测量响应释放。工具用已有匿名会话查询通过独立回环连接刷新计数，记录查询次数；自然过期先被客户端独立观察到，随后才查询，避免由观测请求触发过期清理。过期任务会返回 `404/task_missing`，新建私有播放仍须返回 401；两项分别验证。浏览器实验结束显式取消它自己创建的公开任务，并在停止服务前核验活跃资源与转发连接，而后才清理临时进程。

`node scripts/library-lab/verify-exposure-startup.mjs REPORT_DIR` 用隔离的真实进程验证主配置缺失、路径错误、拼写错误、仅曲库配置缺失和兼容启动，无需账号或源端服务。

资源验证使用 `prepare-resource-fixture.mjs prepare CONFIG MUSIC_ROOT FIXTURE_STATE` 创建大于 8 MiB 的自制 FLAC，需 FFmpeg 和显式 `SOURCE_ADMIN_CREDENTIALS`；结束后运行对应 `cleanup` 子命令核对哈希、只删除该素材并重新扫描曲库。`FIXTURE_STATE` 是仓库外的私有状态文件。随后运行 `verify-resources.mjs`、`verify-resource-expiry.mjs` 和 `verify-resource-retirement.mjs`，参数均为 `CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR`；`verify-resource-transport.mjs` 不需要 `CREDENTIALS`。这些脚本只测试真实回环实例，输出使用新目录。

`verify-preparation-queue.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR` 验证等待、合并、取消、超时与再次授权。可用 `QUEUE_CASES=场景名,场景名` 定向复测；`QUEUE_PUBLIC_ONLY=1` 用于不含原生登录的前版入队比较。私有场景在启动阻塞源流之前间隔至少 30 秒，保留 Navidrome 登录限频。即便碰到限频也保留失败记录，冷却后在新目录重测，不关闭上游限频。

多账号实验先设置 `LIBRARY_BACKEND=rust` 和指向自有回环 Navidrome 管理员凭据文件的 `SOURCE_ADMIN_CREDENTIALS`，运行 `node scripts/library-lab/multi-user-fixtures.mjs prepare CONFIG STATE PARENT OUTPUT`。`STATE` 必须是仓库外的新私有文件，`PARENT` 是所属临时素材目录的父目录。需要 FFmpeg；工具创建 8 个真实非管理员用户、独立服务账号、音频曲库、空曲库及 20 份自制 FLAC，逐个记录清理身份并核验原件。既有用户和曲库分配保留；此管理员仅用于实验对象的准备、权限切换与清理，不进入公开客户端。

随后运行 `node scripts/library-lab/verify-multi-user.mjs CONFIG STATE OUTPUT`。可用 `MULTI_USER_CASES=source-revocation,round-robin,limits,logout` 选择场景。真实撤权把临时用户短暂分配到空库，保留其已有会话，观察真实协议返回并在结束时恢复原分配；Navidrome 可返回 HTTP 200／错误 70，另一用户仍有权访问。此场景核验共享工作会重新选择合法身份，并拒绝失效者。代理只暂停原媒体正文，不伪造授权结果。原生登录保持 8.5 秒间隔；需要按自己实例的限频调整试验安排，不能关闭限频来获得通过。

`node scripts/library-lab/benchmark-cold-users.mjs CONFIG STATE OUTPUT` 使用 release 程序、真实源服务和每次空应用缓存。设置 `MHUB_RUST_BINARY`、`RESOURCE_PYTHON` 及经核对的 `RESOURCE_NAV_PID`；默认 8 个真实身份同时请求 8／16 个不同文件，每档两次，第二次反转身份顺序并轮换文件分配。登录阶段先完成；每路以 128 KiB/s 读 15 秒，随后排空并核验完整文件。`COLD_LEVELS`、`COLD_REPETITIONS`、`COLD_WINDOW_SECONDS` 可调整规模；报告必须保留实际配置和全部失败。`python scripts/library-lab/summarize-cold-users.py OUTPUT` 从原始结果和 Windows 采样重算分母、分账号时点与资源峰值。启动耗时包含创建、授权、准备、状态轮询和首字节，不是纯队列时间；应用冷缓存不表示磁盘冷缓存，16 文件也不表示 16 用户。

全部实验结束运行 `node scripts/library-lab/multi-user-fixtures.mjs cleanup CONFIG STATE PARENT OUTPUT`，按私有状态核对并删除临时账号、曲库与原件，重新扫描并对照既有分配快照。准备或检查中断时同样保留状态供清理；不得公开或打包 `STATE`、账号配置、原件和缓存，原始失败记录保留在新实验目录。

`benchmark-resources.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR` 以每路 128 KiB/s 的应用读取速度做阶梯与持续试验。`RESOURCE_LEVELS`、`RESOURCE_WINDOW_SECONDS`、`RESOURCE_REPETITIONS`、`RESOURCE_SOAK_SECONDS` 和 `RESOURCE_SOAK_CLIENTS` 控制工作量；`MHUB_RUST_BINARY` 指定编译产物，`RESOURCE_PROFILE` 标记其配置。Windows 上设置 `RESOURCE_PYTHON` 为已有 Python，标准库采样器读取进程 CPU、内存、句柄和 TCP，无需安装 psutil；可用 `RESOURCE_NAV_PID` 同时采样自己启动的 Navidrome。采样器目前针对 Windows，其他系统需要对应的进程采样。应用读取速度不等同于 WAN 限速，闭环播放不等同于随机到达负载；正式容量窗口应避开编译和其他实验。

## 授权曲库验证

### 键盘与无障碍界面

先构建页面，再用已有 Playwright、Chromium / Edge 和 FFmpeg 运行独立界面验收：

```sh
npm --prefix frontend run build
node scripts/library-lab/verify-accessibility.mjs REPORT_DIR
```

可用 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`FFMPEG_EXECUTABLE` 指定已有工具；设置 `AXE_CORE_PATH` 为本地 `axe-core` 的 `axe.min.js` 路径后，追加 WCAG A / AA 自动规则扫描。未提供该路径时不运行 axe，不能把其他检查通过称为 axe 通过。工具不自动安装依赖，也不需要真实账号或运行中的曲库。

该脚本启动仅监听回环的模拟接口，使用两条明确标记的元数据与同一份合成 MP3，操作实际构建页面、原生音频、IndexedDB 和 Service Worker。覆盖跳过导航、登录失败说明、登录/退出/重试后的焦点、请求期间主动转移焦点、键盘跳转、队列移除、公开副本保存及离线重开。五种窗口与主题逐项检查 Tab 路径、焦点环、固定播放栏避让、菜单 Escape 和水平溢出；720×500、360×250 CSS 视口是 1440×1000 在 200% / 400% 浏览器缩放下的布局等效检查，不是真正操作浏览器缩放按钮，也不等同于仅放大文字。

短窗口额外覆盖 844×390、1024×600 的侧栏链接，以及播放失败面板展开后的导航避让。侧栏高度跟随实际播放器高度，内容可在自身范围滚动；键盘焦点恢复时只滚动所在侧栏，不把页面主体一起拉回。触摸检查通过桌面 Chromium 的 CDP `Input.dispatchTouchEvent` 发送真实触摸输入序列，验证拖动期间仅预览、松手一次跳转、系统取消不跳转及取消后再次操作。这些是合成触摸输入，不是真机触摸验收。

GitHub Actions 的 `accessibility` 作业在独立临时目录安装固定版本 Playwright / axe-core，构建页面后执行同一脚本，失败时阻止该检查通过。JSON 与截图作为 `accessibility-evidence` 保留 7 天；测试账号和音频完全由夹具生成，产物不包含部署凭据。该作业独立于 Rust、Docker 和前端单测，不能用其中一组成功替代其他组。

输出包括 `accessibility.json` 和截图。浏览器辅助功能树、DOM 的 ARIA 属性与实际读屏输出分别记录；当前 Edge 可能将滑块 `aria-valuetext` 映射为普通数值，因此不能用属性存在证明实际播报。键盘及自动规则检查不证明完整 WCAG 合规，也不替代 NVDA / VoiceOver、手机触摸、锁屏、后台或真实 Rust / Navidrome 授权链路验收。

### 可选封面失败恢复

```sh
node scripts/library-lab/verify-artwork-recovery.mjs REPORT_DIR
```

沿用已有 Playwright、浏览器和 FFmpeg 配置，生成16×16 JPEG及合成MP3，启动仅回环的模拟接口。检查有效封面显示、仅响应头后停流不阻止播放/保存、没有封面的音频断网重开仍可播放，以及人为挂起图片解码时取消保存及时解除等待、保留完整音频并恢复焦点。JSON明确记录故障注入和浏览器版本；不使用真实曲库账号，不等同于真实源授权或手机验收。此脚本同时加入 GitHub 浏览器作业并保留报告；单测另覆盖不响应中止的网络/存储、迟到位图释放、共享请求独立取消和超长正文。

### 控制请求取消与超时恢复

```sh
node scripts/library-lab/verify-request-recovery.mjs REPORT_DIR
```

沿用已有 Playwright、浏览器和 FFmpeg 配置，操作实际构建页面与模拟回环接口。在页面内替换指定请求的 fetch，明确注入不响应中止的响应头或正文等待；保持生产25秒期限，不修改计时器。覆盖暂停解除播放等待、账号超时后的重新确认与焦点、人工播放重试，以及迟到任务/会话响应取消并拒绝覆盖新状态。被注入的登录和任务创建不送达后端，报告不声称验证了服务器回滚或未知任务清理。`request-recovery.json` 记录故障范围、浏览器版本、等待时间、资源与错误；GitHub浏览器作业运行同一脚本并保留证据。单测另覆盖迟到失败消费、读取锁释放、逐块监听回收和跨响应头/正文的总期限。

### 音频校验取消与恢复

```sh
node scripts/library-lab/verify-audio-integrity.mjs REPORT_DIR
```

使用同样的浏览器与FFmpeg配置、模拟回环API和合成MP3，在实际构建页面内明确挂起指定的Blob读取或WebCrypto摘要。保持生产10秒校验期限，验证取消保存及时结束、未验证字节不入库、手动重试，以及实际截止后释放等待；读取已存副本时暂停可以结束等待，另一首原件离线播放不受旧校验迟到结果影响。离线校验超时保留已有副本，显式重试恢复播放。哈希不匹配检查直接读取IndexedDB确认没有提交记录。`audio-integrity.json` 记录故障注入、时间、浏览器和资源；加入GitHub浏览器作业并保留证据。单测另覆盖32MiB原件上限、共享总期限、迟到拒绝消费与监听移除。此检查证明调用方解除等待，不证明WebCrypto工作已从操作系统中终止；超时也不证明原件损坏。

### 持续收听与资源采样

```sh
node scripts/library-lab/verify-listening-soak.mjs REPORT_DIR 1800
node scripts/library-lab/summarize-listening-soak.mjs REPORT_DIR
```

第二个参数是实际持续时间，接受 48..14400 秒，默认 1800。在线、离线各占一半，按完整两曲循环结束，因此实际耗时会略长于配置；最后另验暂停、反复重选与离线重开。测试使用共享的 `browser-fixture.mjs` 生成 12 秒 MP3 / FLAC，明确模拟 API；每首以原速自然结束，不合成 `ended`、不跳到结尾。离线阶段只使用已显式保存且经 SHA-256 校验的副本，检查不再创建远端任务。与无障碍检查相同，支持已有 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`FFMPEG_EXECUTABLE`。

`listening-soak.json` 每轮落盘，保留真实 EOF、500ms 进度观察汇总、任务及 Blob URL 所有权、每分钟 JS 堆、DOM 节点、监听器和渲染进程 CPU。Windows 同时采样这些渲染进程的工作集与私有内存；其他系统保留 CDP 指标，进程内存为 `null`。阶段端点和离线重开后显式 GC，其余样本不强制 GC；汇总脚本分别列出，不能混算为内存增减证据。CPU 只比较同一 ID 进程的相邻采样，另列新建、退出进程，不把少计的 CPU 当成性能改善。

脚本要求每轮两次真实原速 EOF、资源所有权有界、不出现观测到的连续两秒媒体进度停滞，并保留全部失败。内存没有人为“合格阈值”，增长趋势需要结合周期、GC 和进程变化解释。数据只覆盖该隔离浏览器的两个合成原件；不证明数小时无泄漏、整机内存、真实用户容量、Rust / Navidrome 授权或手机后台。模拟 API 没有后端到期机制，断网丢失的清理请求可使其任务记录留到夹具关闭，不能据此推断真实后端清理结果。

GitHub 的浏览器作业只运行 48 秒短程版本，覆盖真实自然续播、公开副本与退出清理；30 分钟及更长持续采样需单独运行。所有 JSON 与截图都是测试证据，不包含实际部署配置。

### 真实后端与曲库

完整的无私人数据集成检查会启动一套全新的 Navidrome、Rust 服务和隔离浏览器：

```sh
cargo build --locked --bin music-api
npm --prefix frontend run build
LIBRARY_BACKEND=rust NAVIDROME_EXECUTABLE=/path/to/navidrome node scripts/library-lab/verify-navidrome-integration.mjs REPORT_DIR
```

需提供已有 Navidrome 0.64.2、FFmpeg 和 Playwright/Chromium；可用 `MHUB_RUST_BINARY`、`PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`FFMPEG_EXECUTABLE` 指定工具。脚本只在系统临时目录新建数据库、三首合成 MP3/FLAC、随机账号和策略缓存，用随机回环端口运行，不连接已有 Navidrome。外部服务、遥测与共享在该实例关闭，登录按8.5秒间隔进行，保留默认登录限频。

准备时仅管理员发起扫描，播放使用独立非管理员服务账号与 A/B 用户。验证真实原件字节、账号目录、私有预热缓存与 Range、实际曲库授权撤销和恢复；浏览器实际播放、保存两首公开原件、断网重开后自然续播，以及私有音源退出清除和受限音频不写 IndexedDB。账号撤权使用新实例内的空曲库，并检查源端真实 HTTP 200 / Subsonic 错误70。已离线页面的取消请求可能无法送达，因此先记录残留，再用本次任务清单尽力取消，核对活跃 Rust 资源后关闭进程并删除整套自建临时实例。原始数据库和媒体不作为证据上传，报告只记录版本、哈希、检查和计数。

GitHub 的 `navidrome` 作业依赖 Rust 作业成功，使用同次构建的二进制；下载固定版本 Navidrome 并验证官方发布包 SHA-256，在 Ubuntu 24.04/Chromium 运行同一脚本，将 `navidrome-integration-evidence` 保留7天。这个检查覆盖真实桌面链路，仍不证明公网 HTTPS、实际扬声器输出、读屏或手机锁屏/后台表现。

无需真实账号的 Rust HTTP 契约检查可先运行：

```sh
cargo build --locked --bin music-api
LIBRARY_BACKEND=rust node scripts/library-lab/verify-rust-contract.mjs REPORT_DIR
```

PowerShell 先设置 `$env:LIBRARY_BACKEND = 'rust'`。`MHUB_RUST_BINARY` 可指定已经从当前源码构建的程序，`FFMPEG_EXECUTABLE` 可指定已有 FFmpeg。该检查启动真实 `music-api` 独立曲库进程与仅回环的模拟原生登录/Subsonic 上游，使用合成 MP3/JPEG、随机临时凭据和隔离的策略/缓存/封面目录。检查匿名与账号目录、源凭据不外泄、来源与实例/版本边界、私有缓存预热后的跨账号拒绝、Range/条件请求、封面授权、上游 HTTP 200 协议错误、原件 SHA 不符和退出失效。

结束前先显式取消任务、退出会话，并核对真实 Rust 的活跃任务、会话、准备、媒体响应和文件租约为零，再停止自己启动的进程并清理生成目录。终态任务记录仍可按后端生命周期保留，不把它们计为活跃资源。报告只保留检查结果、程序哈希和脱敏的上游请求类型，不写入随机密码、salt、token 或 Cookie。GitHub Rust 作业运行同一检查，JSON 以 `rust-contract-evidence` 保留7天。

这证明 Rust 服务对受控上游响应的行为，不等同于真实 Navidrome、HTTPS 反向代理、浏览器播放或真机验收。下面使用真实曲库的验证仍需自己的隔离服务和显式提供的私有配置。

`scripts/library-lab/` 保留 Node 对照实现和同一组外部验收。为真实 Rust 程序运行检查时设置 `LIBRARY_BACKEND=rust`（PowerShell：`$env:LIBRARY_BACKEND = 'rust'`）：

```sh
node scripts/library-lab/verify-api.mjs CONFIG CREDENTIALS FIXTURE_DIR REPORT_DIR
node scripts/library-lab/verify-browser.mjs ORIGIN CREDENTIALS REPORT_DIR
node scripts/library-lab/verify-failures.mjs CONFIG CREDENTIALS REPORT_DIR
node scripts/library-lab/verify-rust-boundaries.mjs CONFIG CREDENTIALS REPORT_DIR
node scripts/library-lab/verify-lifecycle.mjs CONFIG CREDENTIALS REPORT_DIR
node scripts/library-lab/verify-versioning.mjs CONFIG MUSIC_ROOT REPORT_DIR
node scripts/library-lab/verify-https-boundaries.mjs CONFIG CREDENTIALS REPORT_DIR
node scripts/library-lab/verify-proxy.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR
node scripts/library-lab/verify-exposure-startup.mjs REPORT_DIR
node scripts/library-lab/verify-resources.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR
node scripts/library-lab/verify-resource-expiry.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR
node scripts/library-lab/verify-resource-retirement.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR
node scripts/library-lab/verify-resource-transport.mjs CONFIG FIXTURE_STATE REPORT_DIR
node scripts/library-lab/verify-preparation-queue.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR
node scripts/library-lab/benchmark-resources.mjs CONFIG CREDENTIALS FIXTURE_STATE REPORT_DIR
node scripts/library-lab/verify-multi-user.mjs CONFIG MULTI_USER_STATE REPORT_DIR
node scripts/library-lab/benchmark-cold-users.mjs CONFIG MULTI_USER_STATE REPORT_DIR
python scripts/library-lab/summarize-cold-users.py REPORT_DIR
```

大写参数分别为仓库外的私有 JSON 配置、测试账号、原始音频目录、报告目录和服务 origin。账号文件形如 `{ "accounts": { "a": { "id": "...", "username": "...", "password": "..." }, "b": { "id": "...", "username": "...", "password": "..." } } }`。使用自己控制的非管理员 A/B 账号、两首公开 MP3/FLAC 和一首仅 A 可访问的 90 秒 FLAC；浏览器场景使用标题含 First Light、Slow River、Long Journey 的自制素材。可通过 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE` 指定本机浏览器工具，通过 `MHUB_RUST_BINARY` 指定已编译程序。

API 检查启动隔离的真实 Rust 进程；故障检查在本机 Navidrome 前暂停原文件传输并注入无效媒体凭据。边界检查还验证重启、旧平台旁路及同机不同 origin；显式提供 `SOURCE_ADMIN_CREDENTIALS` 时，会在自己控制的回环 Navidrome 上将 A 临时分配到新建空曲库，再恢复分配并删除空曲库。失败恢复位置记录于测试运行目录。浏览器检查操作 `/library/` 的真实播放与缓存。

生命周期检查仅强制终止自己启动的隔离进程，验证半成品恢复、容量预留和无效清单。换版检查需要 `SOURCE_ADMIN_CREDENTIALS`、FFmpeg 和自有本机曲库的 `MUSIC_ROOT`；它新建独立合成 FLAC，实际替换文件并扫描 Navidrome，用暂停的 HTTP 响应验证旧版本的字节与容量保护，最后删除测试文件。可用 `MHUB_RUST_BINARY` 对比冻结的旧程序。

HTTPS 检查使用真实 TLS、隔离 Rust 进程和浏览器，覆盖会话属性、父域 Cookie 植入、同站点/跨站点请求、嵌入页面、Host 端口、旧接口及退出后的 Range。OpenSSL 生成的临时私钥在结束时删除；Node 独立验证 CA/主机名，浏览器只对该证书公钥设置进程内例外，不安装系统根证书。可用 `OPENSSL_EXECUTABLE` 指定已有 OpenSSL。这是本机验证，不能据此声称公网证书和代理已部署。

`verify-proxy.mjs` 加入真实 Caddy、HTTP/1.1／HTTP/2 和只转发 TLS 密文的有界节流器，分别验证持续慢读、单流取消、退出、自然过期、完全停读与真实浏览器播放。先校准带宽，再核对完整原件或中断前缀；总写入期限截断属于明确的配置负面对照。Caddy 2.11.9 的严格 SNI/Host 匹配、写入空闲期限、私有诊断刷新方式及素材清理步骤见[部署说明](#https-反向代理)。此链路未模拟公网、丢包或无线抖动。

启动检查无需凭据，验证显式主配置路径不可读取、关键拼写错误及缺少曲库配置会拒绝启动，同时保留默认开发启动。显式配置失败不会回退到综合站点，解析日志不包含配置原文。

资源检查使用自制的大文件、真实 TCP 背压、进程计数和短有效期，验证慢读、任务回收、退出、自然过期以及旧版本记录被回收后的会话撤销。`prepare-resource-fixture.mjs` 的准备/清理步骤、发布版负载测量及 Windows 标准库采样器见部署说明。失败请求留在统计中，不将所有连接数或单文件吞吐称为并发用户容量。

准备队列检查在真实源流阻塞时验证合并、取消、等待超时、会话/任务过期、清单变化与恢复；其中上游资格失效由明确标记的本机代理故障注入，原件仍来自自有 Navidrome。`QUEUE_CASES` 可选择逗号分隔的场景做针对性复测，私有场景之间留出登录限频间隔。全局/账号等待名额、跨会话归属、轮转和过期工作代际隔离另由 Rust 测试覆盖。

多账号检查另用临时真实 Navidrome 用户和曲库，验证轮转、跨会话限额、退出及真实曲库撤权；代理只暂停原媒体正文。`benchmark-cold-users.mjs` 用 8 个真实身份同时准备 8／16 个不同文件，每档默认两次、新进程和空应用缓存，记录所有尝试并核对完整原件。16 文件档仍是 8 个身份；原生登录按间隔完成，不能据此推断登录高峰或公网容量。临时对象的准备、私有状态和清理步骤见[部署说明](#可选授权曲库)。

不设置 `LIBRARY_BACKEND` 时使用 Node 对照服务：`node scripts/library-lab/server.mjs CONFIG`，其配置还需 `host: "127.0.0.1"` 和 `port`；该实现仅连接回环 HTTP 曲库。

## 账号与同步

账号功能默认关闭。启用时在 `config.toml` 的 `[auth]` 中设置：

- `rp_origin`：用户访问的 HTTPS origin，如 `https://music.example.com`；`rp_id` 为空时取其主机名。通行密钥绑定 RP ID，上线后更换域名会使已注册的通行密钥失效。
- `cookie_secure`：HTTPS 部署保持 `true`；仅本机 HTTP 调试时设为 `false`。
- `turnstile_site_key`、`turnstile_secret`：开放注册时建议配置 Cloudflare Turnstile；留空则不校验。
- `session_days`、`library_limit_bytes`：会话有效期与单账号资料库上限。

账号需要 `db.mysql.url` 指向可写的 MySQL；表在首次使用时创建。反向代理和 CDN 需对 `/api/v1/sync/ws` 放行 WebSocket 升级（Nginx 需 `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`），并且不缓存 `/api/v1/auth/`、`/api/v1/sync/`。不支持 WebSocket 时客户端会退回 HTTP 同步，但失去实时推送。若有多个后端实例，同一账号的连接须落到同一实例（当前广播在进程内）。备份数据库时一并保留 `mhub_` 表。

本机 macOS 编译 `webauthn-rs` 依赖的 OpenSSL 时，可设置 `OPENSSL_DIR=/opt/homebrew/opt/openssl@3`；Docker 构建镜像已包含所需库。

## 升级、备份与恢复

升级前备份配置与数据，固定需要部署的 Git commit/tag：

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 music
```

配置更新后可执行 `docker compose up -d --force-recreate music`。应用收到 SIGTERM 时停止接受新连接并等待活动请求，Compose 最长等待 30 秒；升级期间长音频连接仍可能中断。

授权曲库可使用 `node scripts/library-lab/verify-container.mjs before ORIGIN CREDENTIALS POLICY MUSIC_DIR PRIVATE_STATE OUTPUT` 验证真实容器端点。仅允许自己的 `127.0.0.1` 实例，清单须有两份公开原件和一份受限原件，凭据文件含已有 A/B 账号，二者权限不同。脚本按原件哈希核验完整文件与 Range，检查已暖缓存的访问限制；`PRIVATE_STATE` 保存待复核的会话 Cookie，必须置于仓库和可分享报告之外。随后在保留数据卷的前提下重建容器，用相同参数、`after` 阶段和新的 `OUTPUT` 检查旧会话与任务失效，以及重新登录后的完整原件。重建后旧任务为 404，不能把它误记为必须返回 401。数据卷权限、容器安全选项、缓存复用次数和未完成文件恢复仍需从实际容器及私有诊断另行核验；脚本不声称验证了公网、TLS、容量或移动端行为。

备份需要同时保留本机 `config.toml`、`.env`、缓存卷以及自行管理的数据库/TG 存储。备份包含敏感信息，应单独保护，不能提交 Git。

下面使用当前项目的 Compose 挂载定位缓存卷，停机后以只读方式导出：

```sh
mkdir -p backups
chmod 700 backups
docker compose stop music
container=$(docker compose ps -aq music)
volume=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')
docker run --rm -v "$volume:/data:ro" -v "$PWD/backups:/backup" debian:bookworm-slim tar czf /backup/music-data.tar.gz -C /data .
docker compose start music
```

恢复前停止服务，将备份解压到目标数据卷并确认 UID 10001 可写。`docker compose down` 保留数据卷；只有明确需要丢弃缓存时才使用 `down -v`。

## 故障检查

若构建网络无法访问 `index.crates.io`，可在 `.env` 中将 `CARGO_INDEX_URL` 设为 Rust 官方 crates.io 索引的 GitHub 源 `https://raw.githubusercontent.com/rust-lang/crates.io-index/master/`，然后重新构建。默认仍使用 crates.io；不关闭 TLS 校验，也不更换 lockfile 中的包校验和。

- 容器不健康：查看 `docker compose logs music`，验证 `/health`。
- 配置挂载失败：确认文件存在且容器 UID 可读。
- 缓存写入失败：检查数据卷权限、磁盘空间及外部存储路径映射。
- 上游播放失败：检查配置、wrapper 网络和上游授权；健康检查成功不代表第三方账号可用。
- 新音质首播慢：检查真实源格式、wrapper 和网络。WASM 与原生兼容路径的首播条件不同。
- 移动端后台暂停：浏览器和系统省电策略仍可能暂停网页，Media Session 不能保证永久后台运行。
