//! Existing-identity SSH transport; the Rust server owns indexing and HTTP.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, ReadBuf},
    process::{Child, ChildStdout, Command},
    sync::{Semaphore, oneshot},
    time::{Duration, timeout},
};

const METADATA_PROCESS_LIMIT: usize = 4;
const METADATA_BYTES_LIMIT: u64 = 134217728;
// Bound metadata across cloned configs and libraries. Streaming bodies retain
// their separate Library transfer permits; no source verification is cached.
static METADATA_PROCESSES: OnceLock<Arc<Semaphore>> = OnceLock::new();

async fn read_metadata(child: &mut Child, bytes_limit: u64) -> io::Result<serde_json::Value> {
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| rejected("SSH stdout unavailable"))?;
    let mut bytes = Vec::new();
    (&mut stdout)
        .take(bytes_limit + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > bytes_limit {
        return Err(rejected(
            "Scan exceeds 128 MiB; no partial catalog was accepted",
        ));
    }
    if !child.wait().await?.success() {
        return Err(rejected(
            "Read-only SSH operation failed; verify existing access and roots",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| rejected("Invalid SSH metadata"))
}

async fn metadata_json(
    budget: Arc<Semaphore>,
    deadline: Duration,
    spawn: impl FnOnce() -> io::Result<Child>,
) -> io::Result<serde_json::Value> {
    // Queueing consumes the same deadline as execution. Acquire before spawn so
    // playback/HLS metadata validation also has a process cap.
    timeout(deadline, async {
        let permit = budget
            .acquire_owned()
            .await
            .map_err(|_| io::Error::other("SSH metadata budget closed"))?;
        let mut child = spawn()?;
        let (mut sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _permit = permit;
            let result = tokio::select! {
                result = read_metadata(&mut child, METADATA_BYTES_LIMIT) => Some(result),
                _ = sender.closed() => None,
            };
            // The caller can disappear while reading, waiting, or parsing. Keep
            // the slot through teardown/reaping, including errors and timeouts.
            // kill_on_drop remains a fallback if the runtime itself shuts down.
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            if let Some(result) = result {
                let _ = sender.send(result);
            }
        });
        receiver
            .await
            .map_err(|_| io::Error::other("SSH metadata worker stopped"))?
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "SSH metadata read timed out"))?
}

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
        metadata_json(
            METADATA_PROCESSES
                .get_or_init(|| Arc::new(Semaphore::new(METADATA_PROCESS_LIMIT)))
                .clone(),
            Duration::from_secs(120),
            || self.command(payload),
        )
        .await
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::{task::JoinSet, time::Instant};

    const TEST_DEADLINE: Duration = Duration::from_secs(30);

    fn local_metadata_command(delay_ms: u64, output: &str, exit_code: u8) -> Command {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "[Threading.Thread]::Sleep({delay_ms}); [Console]::Write('{}'); exit {exit_code}",
                    output.replace('\'', "''")
                ),
            ]);
            command.creation_flags(0x08000000);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                &format!(
                    "sleep {}; printf '%s' {}; exit {exit_code}",
                    delay_ms as f64 / 1000.0,
                    quote(output)
                ),
            ]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command
    }

    fn hanging_metadata_command() -> Command {
        #[cfg(windows)]
        let command = local_metadata_command(90000, "{}", 0);
        #[cfg(unix)]
        let command = {
            // Use a single process so cancellation cannot leave a shell's
            // sleeping descendant behind on Unix hosts.
            let mut command = Command::new("sleep");
            command
                .arg("90")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            command
        };
        command
    }

    #[cfg(windows)]
    fn process_running(id: u32) -> bool {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        };
        // The PID belongs to a synthetic local child started by this test.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, id);
            if handle.is_null() {
                return false;
            }
            let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            running
        }
    }

    #[cfg(unix)]
    fn process_running(id: u32) -> bool {
        // The PID belongs to a synthetic local child started by this test.
        unsafe { libc::kill(id as libc::pid_t, 0) == 0 }
    }

    #[derive(Default)]
    struct ProcessProfile {
        ids: Vec<u32>,
        peak: usize,
    }
    impl ProcessProfile {
        fn spawn(&mut self, delay_ms: u64) -> io::Result<Child> {
            let child =
                local_metadata_command(delay_ms, "{\"sizeBytes\":123,\"modifiedNs\":\"456\"}", 0)
                    .spawn()?;
            self.ids.push(child.id().expect("live local child"));
            self.peak = self
                .peak
                .max(self.ids.iter().filter(|&&id| process_running(id)).count());
            Ok(child)
        }
    }

    async fn profile_workload(
        budget: Option<Arc<Semaphore>>,
        request_count: usize,
        child_delay_ms: u64,
    ) -> (Duration, ProcessProfile) {
        let profile = Arc::new(Mutex::new(ProcessProfile::default()));
        let start = Instant::now();
        let mut requests = JoinSet::new();
        for _ in 0..request_count {
            let profile = profile.clone();
            let budget = budget.clone();
            requests.spawn(async move {
                let spawn = || profile.lock().unwrap().spawn(child_delay_ms);
                let value = if let Some(budget) = budget {
                    metadata_json(budget, Duration::from_secs(120), spawn)
                        .await
                        .unwrap()
                } else {
                    // Original process lifecycle: every request spawns before
                    // reading/waiting, with no semaphore ahead of spawn.
                    let mut child = spawn().unwrap();
                    timeout(
                        Duration::from_secs(120),
                        read_metadata(&mut child, METADATA_BYTES_LIMIT),
                    )
                    .await
                    .unwrap()
                    .unwrap()
                };
                assert_eq!(value["sizeBytes"], 123);
            });
        }
        while let Some(result) = requests.join_next().await {
            result.unwrap();
        }
        let elapsed = start.elapsed();
        let profile = Arc::try_unwrap(profile).ok().unwrap().into_inner().unwrap();
        assert_eq!(profile.ids.len(), request_count);
        assert!(profile.ids.iter().all(|&id| !process_running(id)));
        (elapsed, profile)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn metadata_budget_bounds_real_child_processes() {
        let budget = Arc::new(Semaphore::new(METADATA_PROCESS_LIMIT));
        let (_, profile) = profile_workload(Some(budget.clone()), 12, 50).await;
        assert!(profile.peak <= METADATA_PROCESS_LIMIT);
        let _permits = timeout(
            TEST_DEADLINE,
            budget.acquire_many_owned(METADATA_PROCESS_LIMIT as u32),
        )
        .await
        .expect("all metadata slots are eventually returned")
        .unwrap();
    }

    #[tokio::test]
    async fn metadata_queue_deadline_does_not_spawn() {
        let budget = Arc::new(Semaphore::new(1));
        let held = budget.clone().acquire_owned().await.unwrap();
        let spawned = AtomicBool::new(false);
        let error = metadata_json(budget.clone(), Duration::from_millis(20), || {
            spawned.store(true, Ordering::SeqCst);
            local_metadata_command(0, "{}", 0).spawn()
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(!spawned.load(Ordering::SeqCst));
        drop(held);
        assert_eq!(budget.available_permits(), 1);
    }

    async fn assert_child_reaped(budget: Arc<Semaphore>, id: u32) {
        let _permit = timeout(TEST_DEADLINE, budget.acquire_owned())
            .await
            .expect("metadata cleanup completes")
            .unwrap();
        assert!(
            !process_running(id),
            "slot released before child {id} exited"
        );
    }

    #[tokio::test]
    async fn metadata_execution_deadline_reaps_child_before_releasing_slot() {
        let budget = Arc::new(Semaphore::new(1));
        let id = AtomicU32::new(0);
        let error = metadata_json(budget.clone(), Duration::from_millis(100), || {
            let child = hanging_metadata_command().spawn()?;
            id.store(child.id().unwrap(), Ordering::SeqCst);
            Ok(child)
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let id = id.load(Ordering::SeqCst);
        assert_ne!(id, 0);
        assert_child_reaped(budget, id).await;
    }

    #[tokio::test]
    async fn metadata_cancellation_reaps_child_before_releasing_slot() {
        let budget = Arc::new(Semaphore::new(1));
        let (started, id) = oneshot::channel();
        let task_budget = budget.clone();
        let request = tokio::spawn(async move {
            metadata_json(task_budget, TEST_DEADLINE, || {
                let child = hanging_metadata_command().spawn()?;
                let _ = started.send(child.id().unwrap());
                Ok(child)
            })
            .await
        });
        let id = timeout(TEST_DEADLINE, id).await.unwrap().unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_child_reaped(budget, id).await;
    }

    #[tokio::test]
    async fn metadata_errors_release_budget_and_checks_are_not_cached() {
        let budget = Arc::new(Semaphore::new(1));
        let mut spawns = 0;
        for (output, exit_code, success) in [
            ("{\"sizeBytes\":1}", 0, true),
            ("invalid json", 0, false),
            ("{}", 2, false),
            ("{\"sizeBytes\":2}", 0, true),
        ] {
            let value = metadata_json(budget.clone(), TEST_DEADLINE, || {
                spawns += 1;
                local_metadata_command(0, output, exit_code).spawn()
            })
            .await;
            assert_eq!(value.is_ok(), success);
            if success {
                assert_eq!(
                    value.unwrap(),
                    serde_json::from_str::<serde_json::Value>(output).unwrap()
                );
            }
            let _permit = timeout(TEST_DEADLINE, budget.clone().acquire_owned())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(spawns, 4);
        let error = metadata_json(budget.clone(), TEST_DEADLINE, || {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "synthetic spawn failure",
            ))
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(budget.available_permits(), 1);
    }

    #[tokio::test]
    async fn metadata_rejects_output_over_limit() {
        let mut child = local_metadata_command(0, "{\"sizeBytes\":123}", 0)
            .spawn()
            .unwrap();
        let result = read_metadata(&mut child, 8).await;
        let _ = child.start_kill();
        let _ = child.wait().await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "local subprocess benchmark; run with --ignored --nocapture --test-threads=1"]
    async fn benchmark_metadata_process_budget() {
        const REQUESTS: usize = 32;
        const CHILD_DELAY_MS: u64 = 50;
        for budget_size in [None, Some(METADATA_PROCESS_LIMIT)] {
            let budget = budget_size.map(|size| Arc::new(Semaphore::new(size)));
            let (elapsed, profile) = profile_workload(budget, REQUESTS, CHILD_DELAY_MS).await;
            if let Some(size) = budget_size {
                assert!(profile.peak <= size);
            }
            eprintln!(
                "metadata_processes budget={budget_size:?} requests={REQUESTS} child_delay_ms={CHILD_DELAY_MS} elapsed_ms={:.3} peak_live_children={}",
                elapsed.as_secs_f64() * 1000.0,
                profile.peak
            );
        }
    }
}
