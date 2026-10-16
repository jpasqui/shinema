//! Existing-identity SSH transport; the Rust server owns indexing and HTTP.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, ReadBuf},
    process::{Child, ChildStdout, Command},
    time::{Duration, timeout},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshConfig {
    pub destination: String,
    pub key_file: PathBuf,
    pub known_hosts_file: PathBuf,
    pub roots: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub relative: String,
    pub size_bytes: u64,
    pub modified_ns: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub items: Vec<RemoteEntry>,
    pub files_seen: u64,
    pub ignored_files: u64,
    pub links_skipped: u64,
}
fn rejected(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
impl SshConfig {
    pub fn from_file(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let value: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> io::Result<()> {
        let (user, host) = self
            .destination
            .split_once('@')
            .ok_or_else(|| rejected("Use an existing user@host"))?;
        if user.starts_with('-')
            || user.is_empty()
            || host.is_empty()
            || !user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b))
            || host.starts_with('-')
            || self.destination.len() > 255
        {
            return Err(rejected("Invalid SSH destination"));
        }
        for path in [&self.key_file, &self.known_hosts_file] {
            if !path.is_absolute() || !std::fs::symlink_metadata(path)?.is_file() {
                return Err(rejected(
                    "Use existing regular SSH identity and trust files",
                ));
            }
        }
        if self.roots.is_empty()
            || self.roots.iter().any(|(kind, path)| {
                !["tv", "movies"].contains(&kind.as_str())
                    || !path.starts_with('/')
                    || path
                        .split('/')
                        .skip(1)
                        .any(|s| s.is_empty() || s == "." || s == ".." || s.contains('\0'))
            })
        {
            return Err(rejected(
                "Use absolute TV and Movies roots without traversal",
            ));
        }
        Ok(())
    }
    fn command(&self, mut payload: serde_json::Value) -> io::Result<Child> {
        payload["roots"] = serde_json::to_value(&self.roots)?;
        payload["extensions"] = serde_json::to_value(crate::content_registry::scan_extensions())?;
        let source = include_str!("remote_reader.py");
        let program = "python3";
        let remote = format!(
            "{program} -c {} {}",
            quote(source),
            quote(&payload.to_string())
        );
        let mut command = Command::new("ssh");
        command
            .args([
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "UpdateHostKeys=no",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "ServerAliveInterval=10",
                "-o",
                "ServerAliveCountMax=2",
            ])
            .arg("-o")
            .arg(format!(
                "UserKnownHostsFile={}",
                self.known_hosts_file.display()
            ))
            .arg("-i")
            .arg(&self.key_file)
            .arg(&self.destination)
            .arg(remote)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command.spawn()
    }
    async fn json(&self, payload: serde_json::Value) -> io::Result<serde_json::Value> {
        let mut child = self.command(payload)?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| rejected("SSH stdout unavailable"))?;
        let read = async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(134217729)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > 134217728 {
                return Err(rejected(
                    "Scan exceeds 128 MiB; no partial catalog was accepted",
                ));
            }
            let status = child.wait().await?;
            if !status.success() {
                return Err(rejected(
                    "Read-only SSH operation failed; verify existing access and roots",
                ));
            }
            serde_json::from_slice(&bytes).map_err(|_| rejected("Invalid SSH metadata"))
        };
        timeout(Duration::from_secs(120), read)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "SSH metadata read timed out"))?
    }
    pub async fn scan(&self) -> io::Result<Scan> {
        serde_json::from_value(self.json(serde_json::json!({"operation":"scan"})).await?)
            .map_err(|_| rejected("Invalid scan"))
    }
    fn payload(entry: &RemoteEntry, operation: &str) -> serde_json::Value {
        let mut value = serde_json::to_value(entry).expect("Entry serialization");
        value["operation"] = operation.into();
        value
    }
    pub async fn stat(&self, entry: &RemoteEntry) -> io::Result<()> {
        self.json(Self::payload(entry, "stat")).await.map(|_| ())
    }
    pub fn stream(
        &self,
        entry: &RemoteEntry,
        start: u64,
        length: u64,
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) -> io::Result<RemoteStream> {
        let mut payload = Self::payload(entry, "stream");
        payload["start"] = start.into();
        payload["length"] = length.into();
        let mut child = self.command(payload)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| rejected("SSH stdout unavailable"))?;
        Ok(RemoteStream {
            _child: child,
            _permit: permit,
            stdout: stdout.take(length),
            remaining: length,
        })
    }
}

/// Own the child for exactly the HTTP body's lifetime. Drop/cancel kills SSH,
/// including requests abandoned after stat or during a seek.
pub struct RemoteStream {
    _child: Child,
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
    stdout: tokio::io::Take<ChildStdout>,
    remaining: u64,
}
impl AsyncRead for RemoteStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        match Pin::new(&mut self.stdout).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) => {
                let bytes = (buffer.filled().len() - before) as u64;
                if bytes == 0 && self.remaining > 0 {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Remote source ended early",
                    )));
                }
                self.remaining = self.remaining.saturating_sub(bytes);
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
