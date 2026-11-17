use super::*;
use futures::StreamExt;
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};

struct PartialFile(PathBuf);
impl Drop for PartialFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Library {
    pub(super) async fn cache_file(
        &self,
        entry: &Entry,
        auth: &SourceAuth,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        let key = representation_key(
            &self.config.source.instance_id,
            &entry.song_id,
            &entry.sha256,
        );
        let name = disk::name(&key);
        let file = self.disk.path(&name);
        let _lease = self.disk.lease(&name);
        match fs::symlink_metadata(&file).await {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(error(409, "cache_changed", "缓存不是普通文件"));
                }
                self.count(|m| m.cache_validations += 1);
                if metadata.is_file()
                    && metadata.len() == entry.size
                    && hash_file(&file, cancel).await? == entry.sha256
                {
                    self.count(|m| m.cache_hits += 1);
                    self.disk.touch(&name);
                    return Ok(file);
                }
                self.disk.discard(&name)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(internal()),
        }
        self.count(|m| m.cache_misses += 1);
        let _reservation = self.reserve_file(entry, &name).await?;
        let parameters = [("id", entry.song_id.as_str()), ("format", "raw")];
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(error(409, "cancelled", "下载已取消")),
            result = self.source_response("stream", auth, &parameters) => result?,
        };
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if content_type.contains("json")
            || content_type.contains("xml")
            || content_type.starts_with("text/")
        {
            self.count(|m| m.protocol_failures += 1);
            source::envelope(source::bounded_json(response, 65536).await?)?;
            return Err(error(502, "source_media", "曲库返回了非音频数据"));
        }
        if response.status() != StatusCode::OK {
            return Err(error(502, "source_media", "原文件下载失败"));
        }
        if response
            .content_length()
            .is_some_and(|size| size != entry.size)
        {
            return Err(error(409, "source_changed", "原文件大小已变化"));
        }
        self.count(|m| m.source_downloads += 1);
        let partial = PartialFile(self.config.cache_dir.join(format!(
            "{}.{}.partial",
            hex_hash(key.as_bytes()),
            opaque::<12>()
        )));
        // Declare the guard before the handle so cancellation closes the handle
        // before removing its path, including on Windows.
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut handle = options.open(&partial.0).await.map_err(|_| internal())?;
        let mut stream = response.bytes_stream();
        let result = async {
            let mut hash = Sha256::new();
            let mut size = 0;
            loop {
                let next = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(error(409, "cancelled", "下载已取消")),
                    next = stream.next() => next,
                };
                let Some(chunk) = next else { break };
                let chunk =
                    chunk.map_err(|_| error(502, "source_unavailable", "原文件传输中断"))?;
                size += chunk.len() as u64;
                if size > entry.size {
                    return Err(error(409, "source_changed", "原文件超过清单大小"));
                }
                hash.update(&chunk);
                handle.write_all(&chunk).await.map_err(|_| internal())?;
            }
            if size != entry.size || format!("{:x}", hash.finalize()) != entry.sha256 {
                return Err(error(409, "integrity_failed", "原文件校验失败"));
            }
            handle.sync_all().await.map_err(|_| internal())?;
            Ok(())
        }
        .await;
        // Tokio file writes can still be running on a blocking thread. Finish
        // those writes and close the OS handle before the guard removes a path.
        drop(handle.into_std().await);
        result?;
        if cancel.is_cancelled() {
            return Err(error(409, "cancelled", "下载已取消"));
        }
        self.disk.publish(&partial.0, &name, entry.size)
    }
}
async fn hash_file(path: &Path, cancel: &CancellationToken) -> Result<String> {
    let mut file = fs::File::open(path).await.map_err(|_| internal())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        if cancel.is_cancelled() {
            return Err(error(409, "cancelled", "准备已取消"));
        }
        let length = file.read(&mut buffer).await.map_err(|_| internal())?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
