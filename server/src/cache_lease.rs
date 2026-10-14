//! One writer per private cache directory. Stale leases and legacy temporary
//! files are removed only after validating ordinary singly-linked files and
//! confirming their recorded owner is no longer alive.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
pub struct Lease {
    path: PathBuf,
    token: String,
}
pub(crate) fn alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        // SAFETY: signal zero only queries process existence; it sends no signal.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        // SAFETY: read-only process query, a valid output pointer, and closure
        // of the handle returned by OpenProcess. Access failures fail closed.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let mut code = 0;
            let queried = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            queried == 0 || code == STILL_ACTIVE as u32
        }
    }
}
impl Lease {
    pub fn acquire(directory: &Path) -> io::Result<Self> {
        let path = directory.join("writer.lock");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let token = format!("shinema-cache-writer-v1\n{}\n{nonce}\n", std::process::id());
        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    let lease = Self { path, token };
                    file.write_all(lease.token.as_bytes())?;
                    file.sync_all()?;
                    return Ok(lease);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if crate::state_files::validate_file(&path)? > 256 {
                        return Err(io::Error::other("Unrecognized cache lease"));
                    }
                    let content = fs::read_to_string(&path)?;
                    let fields = content.lines().collect::<Vec<_>>();
                    if fields.len() != 3
                        || fields[0] != "shinema-cache-writer-v1"
                        || fields[2].parse::<u128>().is_err()
                    {
                        return Err(io::Error::other("Unrecognized cache lease"));
                    }
                    let pid = fields[1]
                        .parse::<u32>()
                        .ok()
                        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
                        .ok_or_else(|| io::Error::other("Invalid cache owner"))?;
                    if alive(pid) {
                        return Err(io::Error::other(
                            "Cache is owned by a live server; use a separate state directory",
                        ));
                    }
                    crate::state_files::validate_file(&path)?;
                    fs::remove_file(&path)?;
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::other(
            "Cache lease acquisition raced another writer",
        ))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if crate::state_files::validate_file(&self.path).is_ok()
            && fs::read_to_string(&self.path).ok().as_deref() == Some(self.token.as_str())
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
