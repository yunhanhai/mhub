//! Local, bounded artwork bytes share the song's authorization and version boundary.
use super::*;
use tokio::io::AsyncReadExt;

const MAX_BYTES: u64 = 64 * 1024;

fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut position = 2;
    while position + 4 <= bytes.len() {
        if bytes[position] != 0xff {
            return None;
        }
        while bytes.get(position) == Some(&0xff) {
            position += 1;
        }
        let marker = *bytes.get(position)?;
        position += 1;
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        let length =
            u16::from_be_bytes([*bytes.get(position)?, *bytes.get(position + 1)?]) as usize;
        if length < 2 || position.checked_add(length)? > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0 | 0xc2) {
            if length < 8 || bytes[position + 2] != 8 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[position + 3], bytes[position + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[position + 5], bytes[position + 6]]) as u32;
            return Some((width, height));
        }
        position += length;
    }
    None
}

pub(super) fn valid(art: &Artwork) -> bool {
    art.content_type == "image/jpeg"
        && (4..=MAX_BYTES).contains(&art.size)
        && (1..=256).contains(&art.width)
        && (1..=256).contains(&art.height)
        && art.sha256.len() == 64
        && art
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl Library {
    pub(super) async fn artwork_bytes(&self, entry: &Entry) -> Result<Vec<u8>> {
        let artwork =
            entry
                .artwork
                .as_ref()
                .ok_or(error(404, "artwork_missing", "这首曲目没有封面"))?;
        let configured = self.config.artwork_dir.as_ref().ok_or(error(
            404,
            "artwork_missing",
            "封面暂不可用",
        ))?;
        let root = tokio::fs::canonicalize(configured)
            .await
            .map_err(|_| internal())?;
        let path = root.join(format!("{}.jpg", artwork.sha256));
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|_| error(404, "artwork_missing", "封面暂不可用"))?;
        if !metadata.is_file() || metadata.len() != artwork.size {
            return Err(error(409, "artwork_integrity", "封面校验失败"));
        }
        let mut bytes = Vec::with_capacity(artwork.size as usize);
        tokio::fs::File::open(&path)
            .await
            .map_err(|_| internal())?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| internal())?;
        if bytes.len() as u64 != artwork.size
            || hex_hash(&bytes) != artwork.sha256
            || !bytes.starts_with(&[0xff, 0xd8])
            || !bytes.ends_with(&[0xff, 0xd9])
            || dimensions(&bytes) != Some((artwork.width, artwork.height))
        {
            return Err(error(409, "artwork_integrity", "封面校验失败"));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg_header() -> Vec<u8> {
        vec![
            0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9,
        ]
    }
    fn artwork(bytes: &[u8]) -> Artwork {
        Artwork {
            sha256: hex_hash(bytes),
            size: bytes.len() as u64,
            width: 1,
            height: 1,
            content_type: "image/jpeg".into(),
        }
    }
    #[test]
    fn descriptor_only_accepts_bounded_jpeg_and_content_hash() {
        let mut art = artwork(&jpeg_header());
        assert!(valid(&art));
        art.width = 257;
        assert!(!valid(&art));
        art.width = 1;
        art.sha256 = "../escape".into();
        assert!(!valid(&art));
        art.sha256 = "0".repeat(64);
        art.size = MAX_BYTES + 1;
        assert!(!valid(&art));
        art.size = 100;
        art.content_type = "image/svg+xml".into();
        assert!(!valid(&art));
    }
    #[test]
    fn jpeg_header_dimensions_are_checked_without_unbounded_offsets() {
        assert_eq!(dimensions(&jpeg_header()), Some((1, 1)));
        for bytes in [
            vec![],
            vec![0xff, 0xd8],
            vec![0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff],
            vec![0xff, 0xd8, 0xff, 0xc0, 0, 1],
        ] {
            assert_eq!(dimensions(&bytes), None);
        }
    }
    #[tokio::test]
    async fn artwork_reads_validate_hash_size_and_declared_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let cover_dir = dir.path().join("artwork");
        std::fs::create_dir(&cover_dir).unwrap();
        let mut config = crate::library::tests::config(dir.path(), "http://127.0.0.1:9".into());
        config.artwork_dir = Some(cover_dir.clone());
        let library = Library::new(config).unwrap();
        let bytes = jpeg_header();
        let mut entry = crate::library::tests::policy("instance").tracks.remove(0);
        entry.artwork = Some(artwork(&bytes));
        let file = cover_dir.join(format!("{}.jpg", hex_hash(&bytes)));
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(library.artwork_bytes(&entry).await.unwrap(), bytes);
        entry.artwork.as_mut().unwrap().width = 2;
        assert!(matches!(
            library.artwork_bytes(&entry).await,
            Err(Error {
                code: "artwork_integrity",
                ..
            })
        ));
        entry.artwork.as_mut().unwrap().width = 1;
        let mut changed = bytes.clone();
        changed[10] = 2;
        std::fs::write(&file, changed).unwrap();
        assert!(library.artwork_bytes(&entry).await.is_err());
        std::fs::write(&file, b"short").unwrap();
        assert!(library.artwork_bytes(&entry).await.is_err());
    }
    #[tokio::test]
    async fn absent_artwork_configuration_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(crate::library::tests::config(
            dir.path(),
            "http://127.0.0.1:9".into(),
        ))
        .unwrap();
        let entry = crate::library::tests::policy("instance").tracks.remove(0);
        assert!(matches!(
            library.artwork_bytes(&entry).await,
            Err(Error {
                code: "artwork_missing",
                ..
            })
        ));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symbolic_link_artwork_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let cover_dir = dir.path().join("artwork");
        std::fs::create_dir(&cover_dir).unwrap();
        let mut config = crate::library::tests::config(dir.path(), "http://127.0.0.1:9".into());
        config.artwork_dir = Some(cover_dir.clone());
        let library = Library::new(config).unwrap();
        let bytes = jpeg_header();
        let outside = dir.path().join("outside.jpg");
        std::fs::write(&outside, &bytes).unwrap();
        std::os::unix::fs::symlink(
            &outside,
            cover_dir.join(format!("{}.jpg", hex_hash(&bytes))),
        )
        .unwrap();
        let mut entry = crate::library::tests::policy("instance").tracks.remove(0);
        entry.artwork = Some(artwork(&bytes));
        assert!(library.artwork_bytes(&entry).await.is_err());
    }
}
