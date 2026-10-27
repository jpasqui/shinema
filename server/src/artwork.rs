//! Sized artwork variants. Clients ask for the width they display, so TVs and
//! phones never decode full-size posters while scrolling. Variants are derived
//! from the metadata artwork cache and live in their own bounded directory.
use image::{ImageReader, Limits, codecs::jpeg::JpegEncoder, imageops::FilterType};
use std::{
    fs, io,
    io::Cursor,
    path::{Path, PathBuf},
};

/// Widths a client may request; anything else snaps up to the next one.
pub(crate) const WIDTHS: [u32; 8] = [160, 240, 320, 480, 640, 960, 1280, 1920];
const MAX_VARIANTS: usize = 4096;
const JPEG_QUALITY: u8 = 82;

pub(crate) fn snap_width(requested: u32) -> Option<u32> {
    if requested == 0 || requested > 4096 {
        return None;
    }
    Some(
        WIDTHS
            .iter()
            .copied()
            .find(|width| *width >= requested)
            .unwrap_or(WIDTHS[WIDTHS.len() - 1]),
    )
}

pub(crate) struct Variants {
    directory: PathBuf,
}

impl Variants {
    pub(crate) fn new(state: &Path) -> io::Result<Self> {
        let directory = state.join("image-variants");
        if fs::symlink_metadata(&directory).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io::Error::other("Artwork variant directory is a link"));
        }
        crate::state_files::create_private_directory(&directory)?;
        Ok(Self { directory })
    }

    /// Returns `original` scaled down to `width`, or `original` itself when it
    /// is already that narrow. `key` is the 64-hex artwork cache key.
    pub(crate) fn variant(&self, key: &str, original: &[u8], width: u32) -> io::Result<Vec<u8>> {
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(io::Error::other("Invalid artwork key"));
        }
        let path = self.directory.join(format!("{key}-{width}.jpg"));
        if let Ok(bytes) = fs::read(&path) {
            crate::state_files::validate_file(&path)?;
            return Ok(bytes);
        }
        let Some(resized) = resize(original, width)? else {
            return Ok(original.to_vec());
        };
        self.store(&path, &resized)?;
        Ok(resized)
    }

    fn store(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.evict_if_full()?;
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, path).inspect_err(|_| {
            let _ = fs::remove_file(&temporary);
        })
    }

    /// Keeps the directory bounded by dropping the least recently written tenth.
    fn evict_if_full(&self) -> io::Result<()> {
        let mut files = fs::read_dir(&self.directory)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, entry.path()))
            })
            .collect::<Vec<_>>();
        if files.len() < MAX_VARIANTS {
            return Ok(());
        }
        files.sort();
        for (_, path) in files.iter().take(MAX_VARIANTS / 10) {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }
}

/// Decodes with strict limits (artwork comes from metadata providers) and
/// re-encodes as JPEG. Returns `None` when no downscale is needed.
fn resize(original: &[u8], width: u32) -> io::Result<Option<Vec<u8>>> {
    let mut reader = ImageReader::new(Cursor::new(original))
        .with_guessed_format()
        .map_err(io::Error::other)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(io::Error::other)?;
    if decoded.width() <= width {
        return Ok(None);
    }
    let scaled = decoded
        .resize(width, u32::MAX, FilterType::Triangle)
        .to_rgb8();
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, JPEG_QUALITY)
        .encode_image(&scaled)
        .map_err(io::Error::other)?;
    Ok(Some(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbImage};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn widths_snap_up_and_reject_nonsense() {
        assert_eq!(snap_width(1), Some(160));
        assert_eq!(snap_width(300), Some(320));
        assert_eq!(snap_width(1920), Some(1920));
        assert_eq!(snap_width(4000), Some(1920));
        assert_eq!(snap_width(0), None);
        assert_eq!(snap_width(5000), None);
    }

    #[test]
    fn variants_downscale_once_and_keep_aspect_ratio() {
        let temp = tempfile::tempdir().unwrap();
        let variants = Variants::new(temp.path()).unwrap();
        let key = "a".repeat(64);
        let original = png(600, 900);
        let first = variants.variant(&key, &original, 240).unwrap();
        let decoded = image::load_from_memory(&first).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (240, 360));
        // The second request is served from the variant cache.
        let cached = temp
            .path()
            .join("image-variants")
            .join(format!("{key}-240.jpg"));
        assert!(cached.exists());
        assert_eq!(variants.variant(&key, &original, 240).unwrap(), first);
    }

    #[test]
    fn narrow_artwork_is_never_upscaled() {
        let temp = tempfile::tempdir().unwrap();
        let variants = Variants::new(temp.path()).unwrap();
        let original = png(200, 300);
        let result = variants.variant(&"b".repeat(64), &original, 480).unwrap();
        assert_eq!(result, original);
    }

    #[test]
    fn malformed_keys_and_images_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let variants = Variants::new(temp.path()).unwrap();
        assert!(variants.variant("../x", &png(10, 10), 160).is_err());
        assert!(
            variants
                .variant(&"c".repeat(64), b"not an image", 160)
                .is_err()
        );
    }
}
