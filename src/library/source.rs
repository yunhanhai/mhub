use super::*;
use futures::StreamExt;

impl Library {
    pub(super) async fn source_response(
        &self,
        method: &str,
        auth: &SourceAuth,
        extra: &[(&str, &str)],
    ) -> Result<reqwest::Response> {
        self.count(|m| m.source_requests += 1);
        let mut form = vec![
            ("v", "1.16.1"),
            ("c", "mhub-library"),
            ("f", "json"),
            ("u", auth.username.as_str()),
            ("s", auth.salt.as_str()),
            ("t", auth.token.as_str()),
        ];
        form.extend_from_slice(extra);
        self.http
            .post(
                self.source_url
                    .join(&format!("/rest/{method}.view"))
                    .map_err(|_| internal())?,
            )
            .form(&form)
            .send()
            .await
            .map_err(|_| error(502, "source_unavailable", "暂时无法连接曲库"))
    }
    pub(super) async fn subsonic(
        &self,
        method: &str,
        auth: &SourceAuth,
        extra: &[(&str, &str)],
    ) -> Result<Value> {
        let response = self.source_response(method, auth, extra).await?;
        if !response.status().is_success() {
            return Err(error(502, "source_http", "曲库 HTTP 请求失败"));
        }
        let result = bounded_json(response, 1024 * 1024).await.and_then(envelope);
        if result.is_err() {
            self.count(|m| m.protocol_failures += 1);
        }
        result
    }
}

pub(super) async fn bounded_json(response: reqwest::Response, maximum: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| error(502, "source_protocol", "曲库响应中断"))?;
        if bytes.len() + chunk.len() > maximum {
            return Err(error(502, "source_too_large", "曲库响应超过允许的大小"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| error(502, "source_protocol", "曲库返回了无法识别的数据"))
}
pub(super) fn envelope(body: Value) -> Result<Value> {
    let response = &body["subsonic-response"];
    if response["status"].as_str() == Some("ok") {
        return Ok(response.clone());
    }
    Err(match response["error"]["code"].as_u64() {
        Some(10 | 40) => error(401, "source_auth", "曲库身份已失效，请重新登录"),
        Some(50) => error(403, "source_permission", "曲库拒绝访问"),
        Some(70) => error(404, "source_missing", "曲库中没有这首曲目"),
        _ => error(502, "source_protocol", "曲库协议请求失败"),
    })
}
