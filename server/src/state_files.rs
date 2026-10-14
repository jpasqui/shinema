//! SQLite uses ambient filenames for its database and sidecars. Reject existing
//! links before opening any writable file, and request SQLite NOFOLLOW as well.
//! The state directory must remain private to the server account: these checks
//! are not a sandbox against a same-account process racing directory replacement.
use std::{fs, io, path::Path};

fn rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "SQLite state files must be ordinary, singly linked files",
    )
}

pub(crate) fn create_private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)?.permissions().mode() & 0o022 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "State directory must not be writable by other users",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate(directory: &Path) -> io::Result<()> {
    for name in [
        "progress.sqlite3",
        "progress.sqlite3-wal",
        "progress.sqlite3-shm",
        "progress.sqlite3-journal",
    ] {
        match validate_file(&directory.join(name)) {
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
pub(crate) fn validate_file(path: &Path) -> io::Result<u64> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(rejected());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(rejected());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
            GetFileInformationByHandle,
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(rejected());
        }
        // Opening a reparse point itself for read-only metadata must never
        // follow a final-link swap or give this check a writable handle.
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: valid live file handle and an appropriately sized output
        // buffer; its contents are read only after the API reports success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.nNumberOfLinks != 1 {
            return Err(rejected());
        }
    }
    Ok(metadata.len())
}
