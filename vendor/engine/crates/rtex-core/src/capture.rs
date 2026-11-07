//! Running an instrumented full LuaLaTeX pass (`rtex-capture`) and reading its results.

use crate::texlive::TexLive;
use anyhow::{bail, Context, Result};
use rtex_dl::{DisplayList, Sp};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(crate) const DEFAULT_PASS_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy)]
pub(crate) struct PassWatch<'a> {
    pub(crate) timeout: Duration,
    pub(crate) shutdown: &'a AtomicBool,
}

impl PassWatch<'_> {
    pub(crate) fn remaining(&self, started: Instant) -> Result<Duration> {
        anyhow::ensure!(!self.shutdown.load(Ordering::SeqCst), "lualatex pass canceled");
        let remaining = self.timeout.saturating_sub(started.elapsed());
        anyhow::ensure!(
            !remaining.is_zero(),
            "lualatex exceeded the {} s pass time limit", self.timeout.as_secs_f64()
        );
        Ok(remaining)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Nfss {
    pub enc: Option<String>,
    pub family: Option<String>,
    pub series: Option<String>,
    pub shape: Option<String>,
    pub size: Option<String>,
    pub baselineskip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ParaBegin {
    pub line: i64,
    pub nest: i64,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub font: Option<i64>,
    #[serde(default)]
    pub nfss: Nfss,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub mathversion: Option<String>,
    /// `\if@nobreak` at paragraph start (true right after a heading).
    #[serde(default)]
    pub nobreak: bool,
    /// Unit the paragraph belongs to.
    #[serde(default)]
    pub unit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Placement {
    pub page: i64,
    /// 1-based row index within the unit.
    #[serde(default)]
    pub row: i64,
    /// Capture paragraph sequence number of the row's line (0 for display rows), and its line index.
    #[serde(default)]
    pub par: i64,
    #[serde(default)]
    pub line: i64,
    pub x: Sp,
    pub y: Sp,
    pub w: Sp,
    pub h: Sp,
    pub d: Sp,
}

/// A fast-path unit as seen by the capture run: a top-level paragraph, a block environment
/// or a heading, with the state in force when it began and where its rows were shipped.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CapturedUnit {
    pub uid: i64,
    /// "par" | "env" | "heading"
    pub kind: String,
    /// Environment or sectioning command name for env/heading units.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    pub begin_line: i64,
    #[serde(default)]
    pub end_line: Option<i64>,
    #[serde(default)]
    pub nest: i64,
    #[serde(default)]
    pub seqs: Vec<i64>,
    #[serde(default)]
    pub placements: Vec<Placement>,
    #[serde(default)]
    pub rows: i64,
    /// Counter values that changed since the previous unit (delta encoding; see `abs_counters`).
    /// An empty Lua table arrives as `[]`, hence the loose type.
    #[serde(default)]
    pub counters: serde_json::Value,
    /// Counters the unit advanced: name → value at the unit's end (absent when none).
    #[serde(default)]
    pub advanced: Option<BTreeMap<String, i64>>,
    /// `\the<counter>` bodies that changed since the previous unit (delta; see `abs_thefmt`).
    #[serde(default)]
    pub thefmt: serde_json::Value,
    /// Absolute `\the<counter>` bodies at unit begin (filled by `CaptureJson::finalize`).
    #[serde(skip)]
    pub abs_thefmt: BTreeMap<String, String>,
    /// Meanings of the macros the body (re)defines that changed since the previous unit (delta).
    #[serde(default)]
    pub macros: serde_json::Value,
    /// Absolute meanings at unit begin (filled by `CaptureJson::finalize`).
    #[serde(skip)]
    pub abs_macros: BTreeMap<String, String>,
    #[serde(default)]
    pub everypar: String,
    #[serde(default)]
    pub nobreak: bool,
    #[serde(default)]
    pub afterindent: bool,
    #[serde(default)]
    pub noskipsec: bool,
    /// A heading the class sets run-in (`\paragraph`, IEEEtran's `\subsubsection`): its title
    /// goes into the next paragraph or list item, whose lines the unit has.
    #[serde(default)]
    pub runin: bool,
    #[serde(default)]
    pub nfss: Nfss,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub ints: BTreeMap<String, i64>,
    #[serde(default)]
    pub dims: BTreeMap<String, i64>,
    #[serde(default)]
    pub glues: BTreeMap<String, Vec<f64>>,
    #[serde(default)]
    pub parshape: Option<serde_json::Value>,
    /// Absolute counter values at unit begin (filled by `CaptureJson::finalize`).
    #[serde(skip)]
    pub abs_counters: BTreeMap<String, i64>,
}

/// A paragraph as seen by `pre_linebreak_filter` in the instrumented run, with its context.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CapturedParagraph {
    pub seq: i64,
    pub groupcode: String,
    pub nest: i64,
    pub end_line: i64,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub lines: Option<i64>,
    #[serde(default)]
    pub ints: BTreeMap<String, i64>,
    #[serde(default)]
    pub dims: BTreeMap<String, i64>,
    #[serde(default)]
    pub glues: BTreeMap<String, Vec<f64>>,
    #[serde(default)]
    pub parshape: Option<serde_json::Value>,
    #[serde(default)]
    pub everypar: String,
    #[serde(default)]
    pub flags: BTreeMap<String, i64>,
    #[serde(default)]
    pub begin: Option<ParaBegin>,
    #[serde(default)]
    pub placements: Option<Vec<Placement>>,
}

impl CapturedParagraph {
    pub fn is_top_level(&self) -> bool {
        self.groupcode.is_empty() && self.nest == 1
    }
    /// Source line range (1-based, inclusive start, inclusive end as reported by the filter).
    pub fn start_line(&self) -> Option<i64> {
        self.begin.as_ref().map(|b| b.line)
    }
    /// The context the fast server needs (serialized as the `ctx` of a `context` request).
    pub fn context_json(&self) -> serde_json::Value {
        serde_json::json!({
            "ints": self.ints, "dims": self.dims, "glues": self.glues,
            "parshape": self.parshape, "everypar": self.everypar,
            "begin": self.begin,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CaptureJson {
    pub version: i64,
    /// Actual cwd of the instrumented snapshot, for exact absolute source-path resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_root: Option<String>,
    pub jobname: String,
    pub pages: i64,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub paragraphs: Vec<CapturedParagraph>,
    #[serde(default)]
    pub units: Vec<CapturedUnit>,
    /// LaTeX counter names known to the document (from `\cl@@ckpt`).
    #[serde(default)]
    pub counters: Vec<String>,
    /// Where this pass drew each picture environment (`file:line` → position), for the
    /// picture cache. An empty Lua table arrives as `[]`, hence the loose type.
    #[serde(default)]
    pub pics: serde_json::Value,
    /// Keys of cached pictures whose skipped body did not end on the line the source scan
    /// predicted (the cache forgets them; see `piccache::PicCache::absorb`).
    #[serde(default)]
    pub pic_mismatch: Vec<String>,
}

impl CaptureJson {
    /// `pics` as a map (empty when the pass recorded none).
    pub fn recorded_pics(&self) -> BTreeMap<String, crate::piccache::RecordedPic> {
        serde_json::from_value(self.pics.clone()).unwrap_or_default()
    }

    /// Reconstruct absolute counter values from the per-unit deltas (units are in document order).
    pub fn finalize(&mut self) {
        let mut acc: BTreeMap<String, i64> = BTreeMap::new();
        let mut fmt: BTreeMap<String, String> = BTreeMap::new();
        let mut mac: BTreeMap<String, String> = BTreeMap::new();
        for u in &mut self.units {
            if let serde_json::Value::Object(m) = &u.counters {
                for (k, v) in m {
                    if let Some(n) = v.as_i64() {
                        acc.insert(k.clone(), n);
                    }
                }
            }
            if let serde_json::Value::Object(m) = &u.thefmt {
                for (k, v) in m {
                    if let Some(b) = v.as_str() {
                        fmt.insert(k.clone(), b.to_string());
                    }
                }
            }
            if let serde_json::Value::Object(m) = &u.macros {
                for (k, v) in m {
                    if let Some(b) = v.as_str() {
                        mac.insert(k.clone(), b.to_string());
                    }
                }
            }
            u.abs_counters = acc.clone();
            u.abs_thefmt = fmt.clone();
            u.abs_macros = mac.clone();
        }
    }
    pub fn unit(&self, uid: i64) -> Option<&CapturedUnit> {
        self.units.iter().find(|u| u.uid == uid)
    }
}

#[derive(Debug)]
pub struct CaptureResult {
    pub out_dir: PathBuf,
    pub jobname: String,
    pub json: CaptureJson,
    pub pdf: PathBuf,
    pub log: PathBuf,
    pub wall: std::time::Duration,
    pub exit_ok: bool,
}

impl CaptureResult {
    pub fn page(&self, n: i64) -> Result<DisplayList> {
        let p = self
            .out_dir
            .join(format!("{}.rtex-page{}.json", self.jobname, n));
        let s = std::fs::read_to_string(&p).with_context(|| format!("reading {}", p.display()))?;
        Ok(DisplayList::from_json(&s)?)
    }
    pub fn paragraph(&self, seq: i64) -> Option<&CapturedParagraph> {
        self.json.paragraphs.iter().find(|p| p.seq == seq)
    }
}

/// Run `lualatex '\RequirePackage{rtex-capture}\input{main}'` in `src_dir`, writing to `out_dir`.
/// `instrumented=false` runs the same build without the capture package (clean reference).
pub fn run_capture(
    tl: &TexLive,
    src_dir: &Path,
    main: &str,
    out_dir: &Path,
    instrumented: bool,
) -> Result<CaptureResult> {
    run_capture_with(tl, src_dir, main, out_dir, instrumented, "")
}

/// `run_capture` with extra unit environments (comma separated, `$RTEX_UNIT_ENVS`): theorem-like
/// environments the capture should treat as units.
pub fn run_capture_with(
    tl: &TexLive,
    src_dir: &Path,
    main: &str,
    out_dir: &Path,
    instrumented: bool,
    unit_envs: &str,
) -> Result<CaptureResult> {
    run_capture_timed(tl, src_dir, main, out_dir, instrumented, unit_envs, None)
}

pub(crate) fn run_capture_timed(
    tl: &TexLive,
    src_dir: &Path,
    main: &str,
    out_dir: &Path,
    instrumented: bool,
    unit_envs: &str,
    watch: Option<PassWatch<'_>>,
) -> Result<CaptureResult> {
    let (mut cmd, jobname, out_dir) =
        capture_command(tl, src_dir, main, out_dir, instrumented, unit_envs)?;
    cmd.arg(if instrumented {
        format!("\\RequirePackage{{rtex-capture}}\\input{{{main}}}")
    } else {
        format!("\\input{{{main}}}")
    });
    let t0 = Instant::now();
    let mut pass = PassChild::spawn(cmd.stdin(Stdio::null()))?;
    let (status, stdout) = pass.finish(t0, watch)?;
    collect_capture(
        &out_dir,
        &jobname,
        instrumented,
        status.success(),
        status.code(),
        &stdout,
        t0.elapsed(),
    )
}

/// Drain stdout from spawn, even while a standby is still loading its preamble.
pub(crate) struct PassChild {
    pub(crate) child: Child,
    stdout: crossbeam_channel::Receiver<Vec<u8>>,
}

impl PassChild {
    pub(crate) fn spawn(cmd: &mut Command) -> Result<Self> {
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("spawning lualatex")?;
        let pipe = child.stdout.take().expect("piped lualatex stdout");
        let (tx, stdout) = crossbeam_channel::bounded(1);
        let pass = Self { child, stdout };
        std::thread::Builder::new()
            .name("rtex-pass-output".into())
            .spawn(move || {
                let _ = tx.send(output_tail(pipe));
            })
            .context("starting pass output reader")?;
        Ok(pass)
    }

    pub(crate) fn finish(
        &mut self,
        started: Instant,
        watch: Option<PassWatch<'_>>,
    ) -> Result<(ExitStatus, Vec<u8>)> {
        let Some(watch) = watch else {
            let status = self.child.wait().context("waiting for lualatex")?;
            let stdout = self.stdout.recv().context("lualatex output reader stopped")?;
            return Ok((status, stdout));
        };
        let stdout = loop {
            let wait = watch.remaining(started)?.min(Duration::from_millis(50));
            match self.stdout.recv_timeout(wait) {
                Ok(stdout) => break stdout,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(e) => return Err(e).context("lualatex output reader stopped"),
            }
        };
        // EOF alone does not guarantee that LuaLaTeX has exited.
        loop {
            if let Some(status) = self.child.try_wait().context("waiting for lualatex")? {
                return Ok((status, stdout));
            }
            std::thread::sleep(watch.remaining(started)?.min(Duration::from_millis(5)));
        }
    }
}

fn output_tail(mut pipe: impl Read) -> Vec<u8> {
    // The diagnostics display only the last 2,000 characters. Keep room for UTF-8.
    const TAIL: usize = 8_000;
    let mut tail = VecDeque::with_capacity(TAIL);
    let mut buf = [0; TAIL];
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        tail.drain(..(tail.len() + n).saturating_sub(TAIL));
        tail.extend(&buf[..n]);
    }
    tail.into()
}

impl Drop for PassChild {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// The lualatex command for a pass over `src_dir`, without its final `\input` argument.
/// Returns (command, jobname, canonical out_dir).
pub fn capture_command(
    tl: &TexLive,
    src_dir: &Path,
    main: &str,
    out_dir: &Path,
    instrumented: bool,
    unit_envs: &str,
) -> Result<(Command, String, std::path::PathBuf)> {
    std::fs::create_dir_all(out_dir)?;
    let out_dir = crate::paths::canonical(out_dir)?;
    crate::background::mirror_dirs(src_dir, &out_dir, 0)?;
    let jobname = Path::new(main)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("main")
        .to_string();
    // Pass directories are reused (including by preloaded standby engines). A preamble can
    // terminate TeX successfully before capture.finish(), so existence alone cannot establish
    // that a PDF or capture belongs to this pass. Clear outputs before starting the process,
    // while preserving the aux family it needs for references and convergence. In particular,
    // do not do this when releasing a standby: its preamble may already have opened the PDF.
    clear_capture_outputs(&out_dir, &jobname)?;
    let mut cmd = tl.lualatex_cmd(src_dir);
    cmd.arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg(format!("--jobname={jobname}"))
        .arg(format!(
            "--output-directory={}",
            crate::paths::tex(&out_dir)
        ))
        .env("RTEX_CAPTURE_DIR", &out_dir)
        .env("RTEX_UNIT_ENVS", unit_envs);
    let _ = instrumented;
    Ok((cmd, jobname, out_dir))
}

pub(crate) fn standby_ready_path(out_dir: &Path, jobname: &str) -> PathBuf {
    out_dir.join(format!("{jobname}.rtex-bg-ready"))
}

fn clear_capture_outputs(out_dir: &Path, jobname: &str) -> Result<()> {
    for entry in std::fs::read_dir(out_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let page = name
            .strip_prefix(&format!("{jobname}.rtex-page"))
            .and_then(|n| n.strip_suffix(".json"))
            .map(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if page
            || [
                "pdf",
                "log",
                "rtex.json",
                "rtex-anchors.json",
                "rtex-idxcmd",
                "rtex-bg-ready",
            ]
            .iter()
            .any(|ext| name == format!("{jobname}.{ext}"))
        {
            std::fs::remove_file(entry.path()).with_context(|| {
                format!("clearing previous pass output {}", entry.path().display())
            })?;
        }
    }
    Ok(())
}

/// Read the outputs of a finished pass (log, PDF, capture JSON when instrumented).
pub fn collect_capture(
    out_dir: &Path,
    jobname: &str,
    instrumented: bool,
    exit_ok: bool,
    exit_code: Option<i32>,
    stdout: &[u8],
    wall: std::time::Duration,
) -> Result<CaptureResult> {
    if exit_code.is_none() {
        bail!("lualatex was killed by a signal");
    }
    let log = out_dir.join(format!("{jobname}.log"));
    let pdf = out_dir.join(format!("{jobname}.pdf"));
    let json = if instrumented {
        let jp = out_dir.join(format!("{jobname}.rtex.json"));
        if !jp.exists() {
            bail!(
                "capture run produced no {}; lualatex exit {:?}\n{}",
                jp.display(),
                exit_code,
                String::from_utf8_lossy(stdout)
                    .chars()
                    .rev()
                    .take(2000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            );
        }
        {
            let mut j: CaptureJson = serde_json::from_str(&std::fs::read_to_string(&jp)?)
                .with_context(|| format!("parsing capture json {}", jp.display()))?;
            j.finalize();
            j
        }
    } else {
        CaptureJson {
            jobname: jobname.to_string(),
            ..Default::default()
        }
    };
    if instrumented && json.pages > 0 && !pdf.is_file() {
        bail!(
            "capture recorded {} pages but produced no {}; lualatex exit {:?}",
            json.pages,
            pdf.display(),
            exit_code
        );
    }
    Ok(CaptureResult {
        out_dir: out_dir.to_path_buf(),
        jobname: jobname.to_string(),
        json,
        pdf,
        log,
        wall,
        exit_ok,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_pass_times_out_when_the_child_closes_stdout_without_exiting() {
        use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec 1>&-; while :; do :; done"]);
        let mut pass = PassChild::spawn(&mut command).unwrap();
        let pid = Pid::from_raw(pass.child.id() as i32);
        let watch = PassWatch {
            timeout: Duration::from_millis(50),
            shutdown: &AtomicBool::new(false),
        };
        let err = pass.finish(Instant::now(), Some(watch)).unwrap_err();
        assert!(err.to_string().contains("time limit"));
        drop(pass);
        assert_eq!(kill(pid, None), Err(Errno::ESRCH));
    }

    #[cfg(unix)]
    #[test]
    fn session_shutdown_terminates_and_reaps_an_active_pass() {
        use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "while :; do :; done"]);
        let mut pass = PassChild::spawn(&mut command).unwrap();
        let pid = Pid::from_raw(pass.child.id() as i32);
        let shutdown = AtomicBool::new(true);
        let watch = PassWatch {
            timeout: DEFAULT_PASS_TIMEOUT,
            shutdown: &shutdown,
        };
        let err = pass.finish(Instant::now(), Some(watch)).unwrap_err();
        assert!(err.to_string().contains("canceled"));
        drop(pass);
        assert_eq!(kill(pid, None), Err(Errno::ESRCH));
    }

    #[test]
    fn diagnostics_keep_only_the_output_tail() {
        let mut bytes = vec![b'a'; 80_000];
        bytes.extend_from_slice(b"diagnostic");
        let tail = output_tail(bytes.as_slice());
        assert_eq!(tail.len(), 8_000);
        assert!(tail.ends_with(b"diagnostic"));
    }

    #[test]
    fn capture_with_pages_requires_a_fresh_pdf() {
        let root = std::env::temp_dir().join(format!("rtex-capture-no-pdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("main.rtex.json"),
            r#"{"version":2,"jobname":"main","pages":1}"#,
        )
        .unwrap();
        let err = collect_capture(
            &root,
            "main",
            true,
            true,
            Some(0),
            b"",
            std::time::Duration::ZERO,
        )
        .unwrap_err();
        assert!(err.to_string().contains("recorded 1 pages but produced no"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_capture_clears_only_previous_pass_outputs() {
        let root = std::env::temp_dir().join(format!("rtex-capture-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        let out = root.join("out");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let stale = [
            "main.pdf",
            "main.log",
            "main.rtex.json",
            "main.rtex-page1.json",
            "main.rtex-page12.json",
            "main.rtex-anchors.json",
            "main.rtex-idxcmd",
            "main.rtex-bg-ready",
        ];
        let kept = [
            "main.aux",
            "main.toc",
            "main.bbl",
            "main.idx",
            "main.glo",
            "layout-1.pdf",
            "other.pdf",
            "other.rtex.json",
            "other.rtex-page1.json",
            "main.rtex-page-guide.json",
        ];
        for file in stale.iter().chain(kept.iter()) {
            std::fs::write(out.join(file), "previous run").unwrap();
        }
        let tl = TexLive {
            bin_dir: None,
            lualatex: PathBuf::from("unused-lualatex"),
            rtex_texdir: src.clone(),
        };
        capture_command(&tl, &src, "main.tex", &out, true, "").unwrap();
        for file in stale {
            assert!(!out.join(file).exists(), "stale output survived: {file}");
        }
        for file in kept {
            assert!(
                out.join(file).is_file(),
                "auxiliary or unrelated file removed: {file}"
            );
        }
        // A clean TeX exit without new capture output must not become a successful old layout.
        let err = collect_capture(
            &out,
            "main",
            true,
            true,
            Some(0),
            b"No pages of output.",
            std::time::Duration::ZERO,
        )
        .unwrap_err();
        assert!(err.to_string().contains("capture run produced no"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
