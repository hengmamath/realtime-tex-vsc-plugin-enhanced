//! One background pass: snapshot the buffers, run the instrumented full compile (with
//! biber/bibtex when the document asks for it), and return the capture.

use crate::capture::{capture_command, collect_capture, CaptureResult};
use crate::texlive::TexLive;
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BibTool {
    Auto,
    Biber,
    BibTeX,
    None,
}

#[derive(Debug, Clone)]
pub struct PassOutcome {
    pub capture: CaptureResult,
    pub passes: u32,
    pub bib_ran: bool,
    pub aux_stable: bool,
}

impl Clone for CaptureResult {
    fn clone(&self) -> Self {
        CaptureResult {
            out_dir: self.out_dir.clone(),
            jobname: self.jobname.clone(),
            json: self.json.clone(),
            pdf: self.pdf.clone(),
            log: self.log.clone(),
            wall: self.wall,
            exit_ok: self.exit_ok,
        }
    }
}

/// Write `files` (relative path → text) under `dir`, copying every other file from `project`
/// (images, .bib, .cls …) so relative inputs resolve.
pub fn write_snapshot(project: &Path, files: &BTreeMap<String, String>, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let dir = crate::paths::canonical(dir)?;
    anyhow::ensure!(
        !crate::paths::canonical(project)?.starts_with(&dir),
        "snapshot must not contain the project"
    );
    // PDFs built from tracked sources are outputs; standalone figure PDFs remain inputs.
    let built = files
        .keys()
        .map(|rel| {
            project
                .join(rel.trim_start_matches("./"))
                .with_extension("pdf")
        })
        .collect();
    let mut inputs = BTreeMap::new();
    snapshot_inputs(project, &dir, Path::new(""), 0, &built, &mut inputs)?;
    let mut overlays = BTreeMap::new();
    for (rel, text) in files {
        let rel: PathBuf = Path::new(rel)
            .components()
            .filter(|c| !matches!(c, std::path::Component::CurDir))
            .collect();
        validate_snapshot_path(&rel)?;
        for parent in rel
            .ancestors()
            .skip(1)
            .take_while(|p| !p.as_os_str().is_empty())
        {
            inputs.insert(parent.to_path_buf(), true);
        }
        inputs.insert(rel.clone(), false);
        overlays.insert(rel, text);
    }
    let manifest = dir.join(".rtex-snapshot-inputs.json");
    let (previous, had_inventory): (BTreeSet<PathBuf>, bool) = match std::fs::read(&manifest) {
        Ok(bytes) => (
            serde_json::from_slice::<BTreeSet<std::ffi::OsString>>(&bytes)?
                .into_iter()
                .map(PathBuf::from)
                .collect(),
            true,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Migrate pre-inventory scratch contents before starting any reader; retain cwd.
            for entry in std::fs::read_dir(&dir)? {
                remove_snapshot_entry(&entry?.path())?;
            }
            (BTreeSet::new(), false)
        }
        Err(e) => return Err(e.into()),
    };
    for rel in &previous {
        validate_snapshot_path(rel)?;
    }
    let current: BTreeSet<_> = inputs.keys().cloned().collect();
    // Keep ownership even if a copy fails halfway through, then narrow it on success.
    let pending = previous.union(&current).cloned().collect();
    if !had_inventory || pending != previous {
        write_snapshot_inventory(&manifest, &pending)?;
    }
    for rel in previous.iter().rev().filter(|rel| !current.contains(*rel)) {
        // Never follow a replaced parent symlink out of the snapshot during cleanup.
        let mut reachable = true;
        for parent in rel
            .ancestors()
            .skip(1)
            .take_while(|p| !p.as_os_str().is_empty())
        {
            match std::fs::symlink_metadata(dir.join(parent)) {
                Ok(m) if m.is_dir() => (),
                Ok(_) => {
                    reachable = false;
                    break;
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    reachable = false;
                    break;
                }
                Err(e) => return Err(e.into()),
            }
        }
        if !reachable {
            continue;
        }
        let target = dir.join(rel);
        match std::fs::symlink_metadata(&target) {
            Ok(m) if m.is_dir() => match std::fs::remove_dir(&target) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => (),
                Err(e) => return Err(e.into()),
            },
            Ok(_) => std::fs::remove_file(&target)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    for (rel, is_dir) in &inputs {
        let target = dir.join(rel);
        match std::fs::symlink_metadata(&target) {
            Ok(m) if m.is_dir() != *is_dir || (!*is_dir && !m.is_file()) => {
                remove_snapshot_entry(&target)?;
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        if *is_dir {
            std::fs::create_dir_all(&target)?;
        } else if let Some(text) = overlays.get(rel) {
            std::fs::write(&target, text)?;
        } else {
            let source = project.join(rel);
            if !target.exists() || !same_file_contents(&source, &target)? {
                std::fs::copy(&source, &target)?;
            }
        }
    }
    if pending != current {
        write_snapshot_inventory(&manifest, &current)?;
    }
    Ok(())
}

fn validate_snapshot_path(path: &Path) -> Result<()> {
    anyhow::ensure!(
        !path.as_os_str().is_empty()
            && path
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
            && !path.starts_with(".rtex-snapshot-inputs.json")
            && !path.starts_with(".rtex-snapshot-inputs.next"),
        "invalid snapshot input path: {}",
        path.display()
    );
    Ok(())
}

fn write_snapshot_inventory(manifest: &Path, paths: &BTreeSet<PathBuf>) -> Result<()> {
    // OsString also preserves valid filesystem names that are not UTF-8.
    let names: BTreeSet<_> = paths.iter().map(|p| p.as_os_str()).collect();
    let pending = manifest.with_extension("next");
    if pending.symlink_metadata().is_ok() {
        remove_snapshot_entry(&pending)?;
    }
    std::fs::write(&pending, serde_json::to_vec(&names)?)?;
    std::fs::rename(pending, manifest)?;
    Ok(())
}

fn remove_snapshot_entry(path: &Path) -> Result<()> {
    if std::fs::symlink_metadata(path)?.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn same_file_contents(source: &Path, target: &Path) -> Result<bool> {
    use std::io::BufRead;
    let source = std::fs::File::open(source)?;
    let target = std::fs::File::open(target)?;
    if source.metadata()?.len() != target.metadata()?.len() {
        return Ok(false);
    }
    let mut source = std::io::BufReader::with_capacity(64 * 1024, source);
    let mut target = std::io::BufReader::with_capacity(64 * 1024, target);
    loop {
        let a = source.fill_buf()?;
        let b = target.fill_buf()?;
        let n = a.len().min(b.len());
        if a[..n] != b[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(a.is_empty() && b.is_empty());
        }
        source.consume(n);
        target.consume(n);
    }
}

fn snapshot_inputs(
    project: &Path,
    dir: &Path,
    rel: &Path,
    depth: usize,
    built: &std::collections::HashSet<PathBuf>,
    inputs: &mut BTreeMap<PathBuf, bool>,
) -> Result<()> {
    if depth > 8 {
        return Ok(());
    }
    for entry in std::fs::read_dir(project.join(rel))? {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s.starts_with('.') || name_s == "build" || name_s == "target" {
            continue;
        }
        let path = entry.path();
        let path_canon = crate::paths::canonical(&path).unwrap_or_else(|_| path.clone());
        if dir.starts_with(&path_canon) {
            continue;
        }
        let rel = rel.join(name);
        if path.is_dir() {
            inputs.insert(rel.clone(), true);
            snapshot_inputs(project, dir, &rel, depth + 1, built, inputs)?;
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext == "pdf" && built.contains(&path) {
                continue;
            }
            if matches!(
                ext,
                "aux"
                    | "log"
                    | "synctex.gz"
                    | "fls"
                    | "fdb_latexmk"
                    | "out"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "bbl"
                    | "bcf"
                    | "blg"
                    | "run.xml"
            ) {
                continue;
            }
            inputs.insert(rel, false);
        }
    }
    Ok(())
}

/// Create under `out` every directory of `src` (skipping hidden, build and target), so
/// `\include{chapters/x}` can open `chapters/x.aux` in the output directory.
pub fn mirror_dirs(src: &Path, out: &Path, depth: usize) -> Result<()> {
    if depth > 8 {
        return Ok(());
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s.starts_with('.') || name_s == "build" || name_s == "target" {
            continue;
        }
        if entry.path().is_dir() {
            let sub = out.join(&name);
            std::fs::create_dir_all(&sub)?;
            mirror_dirs(&entry.path(), &sub, depth + 1)?;
        }
    }
    Ok(())
}

/// `bytes` with the pass directory's path taken out, plain and hex-encoded (bookmark writes
/// `srcfile={<hex of the .ind path>}` into the `.aux`): passes alternate between directories,
/// and the same document must give the same signature in either.
fn without_dir(bytes: &[u8], dir_forms: &[Vec<u8>]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for form in dir_forms {
        if form.is_empty() {
            continue;
        }
        let mut next = Vec::with_capacity(out.len());
        let mut i = 0;
        while i < out.len() {
            if out[i..].starts_with(form) {
                next.extend_from_slice(b"<dir>");
                i += form.len();
            } else {
                next.push(out[i]);
                i += 1;
            }
        }
        out = next;
    }
    out
}

fn dir_forms(out_dir: &Path) -> Vec<Vec<u8>> {
    let mut dirs = vec![out_dir.to_path_buf()];
    if let Ok(c) = crate::paths::canonical(out_dir) {
        dirs.push(c);
    }
    // as given and as TeX writes it back (forward slashes on Windows)
    let mut paths: Vec<String> = Vec::new();
    for d in &dirs {
        paths.push(d.to_string_lossy().into_owned());
        paths.push(crate::paths::tex(d));
    }
    let mut forms = Vec::new();
    for p in paths {
        let hex: String = p.bytes().map(|b| format!("{b:02X}")).collect();
        forms.push(hex.to_ascii_lowercase().into_bytes());
        forms.push(hex.into_bytes());
        forms.push(p.into_bytes());
    }
    // longest first, so a path is replaced before a shorter form inside it; equal forms
    // (an already canonical directory) adjacent so `dedup` drops them
    forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    forms.dedup();
    forms
}

fn aux_signature(out_dir: &Path, jobname: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    let forms = dir_forms(out_dir);
    // every index (imakeidx's `name=` indexes too), as makeindex left it
    let mut inds: Vec<PathBuf> = std::fs::read_dir(out_dir)
        .map(|d| {
            d.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|e| e == "ind"))
                .collect()
        })
        .unwrap_or_default();
    inds.sort();
    for p in &inds {
        if let Ok(b) = std::fs::read(p) {
            p.file_name().hash(&mut h);
            without_dir(&b, &forms).hash(&mut h);
        }
    }
    for ext in ["aux", "toc", "lof", "lot", "out", "bcf", "bbl", "idx"] {
        if let Ok(b) = std::fs::read(out_dir.join(format!("{jobname}.{ext}"))) {
            let b = without_dir(&b, &forms);
            ext.hash(&mut h);
            b.hash(&mut h);
            if ext == "aux" {
                // partial aux files of \include'd chapters (\@input{chapters/x.aux})
                let text = String::from_utf8_lossy(&b);
                for part in text.split("\\@input{").skip(1) {
                    let Some(name) = part.split('}').next() else {
                        continue;
                    };
                    if let Ok(pb) = std::fs::read(out_dir.join(name)) {
                        name.hash(&mut h);
                        without_dir(&pb, &forms).hash(&mut h);
                    }
                }
            }
        }
    }
    h.finish()
}

fn log_requests_rerun(log: &Path) -> bool {
    std::fs::read_to_string(log)
        .map(|s| {
            s.contains("Rerun to get")
                || s.contains("rerun LaTeX")
                || s.contains("Please (re)run Biber")
                || s.contains("Please rerun LaTeX")
        })
        .unwrap_or(false)
}

/// Run instrumented passes in `out_dir` until the aux family is stable or `max_passes` is hit.
pub fn run_pass(
    tl: &TexLive,
    snapshot_dir: &Path,
    main: &str,
    out_dir: &Path,
    max_passes: u32,
    bib: BibTool,
    instrumented: bool,
) -> Result<PassOutcome> {
    run_pass_with(
        tl,
        snapshot_dir,
        main,
        out_dir,
        max_passes,
        bib,
        instrumented,
        "",
    )
}

/// `run_pass` with extra unit environments for the capture (see `run_capture_with`).
#[allow(clippy::too_many_arguments)]
pub fn run_pass_with(
    tl: &TexLive,
    snapshot_dir: &Path,
    main: &str,
    out_dir: &Path,
    max_passes: u32,
    bib: BibTool,
    instrumented: bool,
    unit_envs: &str,
) -> Result<PassOutcome> {
    let mut runner = |_pass: u32| {
        crate::capture::run_capture_with(tl, snapshot_dir, main, out_dir, instrumented, unit_envs)
    };
    run_pass_with_runner(
        PassPlan {
            tl,
            snapshot_dir,
            main,
            aux_dir: out_dir,
            max_passes,
            bib,
        },
        &mut runner,
        &mut |_, _| {},
    )
}

/// Copy the aux family a pass leaves for the next one (`.aux .toc .lof .lot .out .bbl .bcf
/// .ind .gls .nav .snm`, and the partial `.aux` files of `\include`d chapters in
/// subdirectories) from one pass directory into another. Pass outputs (PDF, log, capture
/// JSON) and the picture cache are not copied, nor are the files TeX only writes, which a
/// standby engine may already hold open from its preamble (`.idx` from `\makeindex`, `.glo`
/// from `\makeglossaries`): a copy would land in a file being written.
pub fn copy_aux_family(from: &Path, to: &Path) -> Result<()> {
    fn go(root: &Path, dir: &Path, to: &Path) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.is_dir() {
                if name != "pic-cache" && !name.starts_with("pass-") {
                    go(root, &path, to)?;
                }
                continue;
            }
            let keep = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    matches!(
                        e,
                        "aux"
                            | "toc"
                            | "lof"
                            | "lot"
                            | "out"
                            | "bbl"
                            | "bcf"
                            | "blg"
                            | "ind"
                            | "gls"
                            | "nav"
                            | "snm"
                            | "vrb"
                            | "xml"
                    )
                })
                .unwrap_or(false);
            if keep {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let dst = to.join(rel);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&path, dst)?;
            }
        }
        Ok(())
    }
    if from == to || !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    go(from, from, to)
}

/// Where and how a sequence of passes runs.
#[derive(Clone, Copy)]
pub struct PassPlan<'a> {
    pub tl: &'a TexLive,
    pub snapshot_dir: &'a Path,
    pub main: &'a str,
    /// The aux family the first pass starts from (each pass may run in its own directory).
    pub aux_dir: &'a Path,
    pub max_passes: u32,
    pub bib: BibTool,
}

/// `run_pass_with` with the single pass supplied by `runner` (a fresh lualatex, or a standby
/// `WarmEngine` that already holds the preamble). Each pass may run in its own directory
/// (`CaptureResult::out_dir`); `aux_dir` holds the aux family the first pass starts from.
pub fn run_pass_with_runner(
    plan: PassPlan,
    runner: &mut dyn FnMut(u32) -> Result<CaptureResult>,
    on_pass: &mut dyn FnMut(&CaptureResult, u32),
) -> Result<PassOutcome> {
    let PassPlan {
        tl,
        snapshot_dir,
        main,
        aux_dir,
        max_passes,
        bib,
    } = plan;
    std::fs::create_dir_all(aux_dir)?;
    let jobname = Path::new(main)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("main")
        .to_string();
    let mut sig_before = aux_signature(aux_dir, &jobname);
    let mut bib_ran = false;
    let mut indexed = BTreeMap::new();
    let mut last: Option<CaptureResult> = None;
    let mut passes = 0;
    let mut stable = false;
    while passes < max_passes {
        passes += 1;
        let cap = runner(passes)?;
        let out_dir = cap.out_dir.clone();
        let out_dir = out_dir.as_path();
        let bcf = out_dir.join(format!("{jobname}.bcf"));
        let aux = out_dir.join(format!("{jobname}.aux"));
        let wants_bib = match bib {
            BibTool::None => false,
            BibTool::Biber => bcf.exists(),
            BibTool::BibTeX => std::fs::read_to_string(&aux)
                .map(|s| s.contains("\\citation") || s.contains("\\bibdata"))
                .unwrap_or(false),
            BibTool::Auto => {
                bcf.exists()
                    || std::fs::read_to_string(&aux)
                        .map(|s| s.contains("\\bibdata"))
                        .unwrap_or(false)
            }
        };
        if wants_bib && !bib_ran {
            let tool = if bcf.exists() { "biber" } else { "bibtex" };
            let mut cmd = Command::new(tool);
            cmd.current_dir(out_dir).arg(&jobname);
            if let Some(d) = &tl.bin_dir {
                crate::paths::prepend_bin_dir(&mut cmd, d);
            }
            // bibtex needs BIBINPUTS to find .bib files in the snapshot
            cmd.env(
                "BIBINPUTS",
                format!(
                    "{}{}",
                    crate::paths::tex(snapshot_dir),
                    crate::paths::SEARCH_SEP
                ),
            );
            let out = cmd.output().with_context(|| format!("running {tool}"))?;
            if !out.status.success() {
                log::warn!("{tool} failed: {}", String::from_utf8_lossy(&out.stderr));
            }
            bib_ran = true;
        }
        run_makeindex(tl, snapshot_dir, out_dir, &jobname, &mut indexed);
        let sig_after = aux_signature(out_dir, &jobname);
        // a bibliography run that changed nothing (same .bbl) needs no extra pass: the .bbl is
        // part of the signature
        let rerun = log_requests_rerun(&cap.log) || sig_after != sig_before;
        sig_before = sig_after;
        if rerun && passes < max_passes {
            // another pass follows: the caller may show this one meanwhile
            on_pass(&cap, passes);
        }
        last = Some(cap);
        if !rerun {
            stable = true;
            break;
        }
    }
    Ok(PassOutcome {
        capture: last.unwrap(),
        passes,
        bib_ran,
        aux_stable: stable,
    })
}

/// Index programs a document may ask for (imakeidx `program=`); anything else runs makeindex.
const INDEX_PROGRAMS: &[&str] = &[
    "makeindex",
    "texindy",
    "xindy",
    "truexindy",
    "upmendex",
    "mendex",
];

/// The command for `idx` (a file name in the pass directory): the one the capture recorded
/// from imakeidx (`<job>.rtex-idxcmd`: program, the document's options, the file), else
/// `makeindex -q <idx>`.
fn index_command(recorded: &str, idx: &str) -> (String, Vec<String>) {
    for line in recorded.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        let (Some(prog), Some(file)) = (words.first(), words.last()) else {
            continue;
        };
        if *file == idx && words.len() >= 2 && INDEX_PROGRAMS.contains(prog) {
            let mut args: Vec<String> = words[1..].iter().map(|w| w.to_string()).collect();
            if *prog == "makeindex" && !args.iter().any(|a| a == "-q") {
                args.insert(0, "-q".into());
            }
            return (prog.to_string(), args);
        }
    }
    ("makeindex".into(), vec!["-q".into(), idx.into()])
}

/// Run the index program on every `.idx` a pass wrote (`\makeindex`, imakeidx's named indexes)
/// whose entries differ from the ones last indexed in `indexed` (name → hash of the `.idx`), or
/// whose `.ind` is missing, with the program and options imakeidx was given (`index_command`).
/// The `.ind` files are part of the aux signature, so a changed index brings another pass. The
/// index is built here rather than by the document (imakeidx's own call needs shell escape and
/// cannot find an `.idx` in the output directory).
fn run_makeindex(
    tl: &TexLive,
    snapshot_dir: &Path,
    out_dir: &Path,
    jobname: &str,
    indexed: &mut BTreeMap<String, u64>,
) {
    use std::hash::{Hash, Hasher};
    let Ok(dir) = std::fs::read_dir(out_dir) else {
        return;
    };
    let recorded =
        std::fs::read_to_string(out_dir.join(format!("{jobname}.rtex-idxcmd"))).unwrap_or_default();
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "idx") {
            continue;
        }
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut h);
        let hash = h.finish();
        if indexed.get(&name) == Some(&hash) && path.with_extension("ind").exists() {
            continue;
        }
        let (program, args) = index_command(&recorded, &name);
        let mut cmd = Command::new(&program);
        cmd.current_dir(out_dir).args(&args);
        if let Some(d) = &tl.bin_dir {
            crate::paths::prepend_bin_dir(&mut cmd, d);
        }
        // index styles (.ist) the project ships
        cmd.env(
            "INDEXSTYLE",
            format!(
                "{}{}",
                crate::paths::tex(snapshot_dir),
                crate::paths::SEARCH_SEP
            ),
        );
        match cmd.output() {
            Ok(out) if !out.status.success() => {
                log::warn!(
                    "{program} {name} failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                )
            }
            Err(e) => log::warn!("running {program}: {e}"),
            _ => {}
        }
        indexed.insert(name, hash);
    }
}

pub fn snapshot_dir(build: &Path) -> PathBuf {
    build.join("src")
}

/// Reference definitions from an `.aux` file (and the files it `\@input`s), as
/// (control-sequence name, macro body) pairs the fast server can define with `token.set_macro`:
/// `\newlabel{name}{value}` → `r@name`, `\bibcite{key}{value}` → `b@key`, and mathtools'
/// `\MT@newlabel{name}` → the empty marker `MT_r_name` used by `showonlyrefs`.
pub fn read_aux_labels(aux: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    read_aux_into(aux, &mut out, &mut seen, 0);
    out
}

fn read_aux_into(
    aux: &Path,
    out: &mut Vec<(String, String)>,
    seen: &mut std::collections::HashSet<PathBuf>,
    depth: u32,
) {
    if depth > 8 || !seen.insert(aux.to_path_buf()) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(aux) else {
        return;
    };
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            i += text[i..].find('\n').unwrap_or(b.len() - i);
            continue;
        }
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        let rest = &text[i..];
        let (prefix, kind) = if rest.starts_with("\\newlabel") {
            ("\\newlabel", "r@")
        } else if rest.starts_with("\\bibcite") {
            ("\\bibcite", "b@")
        } else if rest.starts_with("\\MT@newlabel") {
            ("\\MT@newlabel", "MT_r_")
        } else if rest.starts_with("\\@input") {
            ("\\@input", "")
        } else {
            // Consume control symbols too: neither \\% nor the second slash of \\\\
            // starts an aux command or a comment.
            i += if b
                .get(i + 1)
                .is_some_and(|c| !c.is_ascii_alphabetic() && *c != b'@')
            {
                2
            } else {
                1
            };
            continue;
        };
        let mut j = i + prefix.len();
        let Some((name, after)) = brace_group(&text, j) else {
            i += 1;
            continue;
        };
        j = after;
        if kind.is_empty() {
            let child = aux.parent().unwrap_or(Path::new(".")).join(name.trim());
            read_aux_into(&child, out, seen, depth + 1);
            i = j;
            continue;
        }
        if kind == "MT_r_" {
            out.push((format!("{kind}{name}"), String::new()));
            i = j;
            continue;
        }
        let Some((value, after)) = brace_group(&text, j) else {
            i += 1;
            continue;
        };
        out.push((format!("{kind}{name}"), value));
        i = after;
    }
}

/// The contents of the brace group starting at (or after whitespace from) `from`; returns the
/// inner text and the index after the closing brace.
fn brace_group(text: &str, from: usize) -> Option<(String, usize)> {
    let b = text.as_bytes();
    let mut i = from;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\n' || b[i] == b'\r' || b[i] == b'\t') {
        i += 1;
    }
    if i >= b.len() || b[i] != b'{' {
        return None;
    }
    let start = i + 1;
    let mut depth = 0i32;
    while i < b.len() {
        match b[i] {
            b'\\' => {
                i += 2;
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((text[start..i].to_string(), i + 1));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod aux_tests {
    use super::*;
    #[test]
    fn labels_and_bibcites() {
        let dir = std::env::temp_dir().join(format!("rtex-aux-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.aux"), "\\relax\n\\newlabel{eq:a}{{1.2}{5}}\n\\bibcite{knuth}{1}\n\\@input{ch.aux}\n\\newlabel{fig:x}{{1}{2}{Caption}{figure.1}{}}\n").unwrap();
        std::fs::write(dir.join("ch.aux"), "\\newlabel{sec:b}{{3}{7}}\n").unwrap();
        let v = read_aux_labels(&dir.join("main.aux"));
        assert_eq!(
            v,
            vec![
                ("r@eq:a".to_string(), "{1.2}{5}".to_string()),
                ("b@knuth".to_string(), "1".to_string()),
                ("r@sec:b".to_string(), "{3}{7}".to_string()),
                (
                    "r@fig:x".to_string(),
                    "{1}{2}{Caption}{figure.1}{}".to_string()
                ),
            ]
        );
    }

    #[test]
    fn mathtools_showonlyrefs_markers() {
        let dir = std::env::temp_dir().join(format!("rtex-aux-mathtools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let aux = dir.join("main.aux");
        std::fs::write(
            &aux,
            concat!(
                "\\relax\n",
                "\\newlabel{eq-bng-itr-dec1-previous}{{3.12}{22}{}{equation.3.12}{}}\n",
                "\\MT@newlabel{eq-bng-itr-dec1-previous}\n",
                "\\newlabel{eq:unreferenced}{{}{22}{}{equation.3.13}{}}\n",
                "\\bibcite{knuth}{1}\n",
                "\\MT@newlabel{eq:second}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            read_aux_labels(&aux),
            vec![
                (
                    "r@eq-bng-itr-dec1-previous".to_string(),
                    "{3.12}{22}{}{equation.3.12}{}".to_string()
                ),
                ("MT_r_eq-bng-itr-dec1-previous".to_string(), String::new()),
                (
                    "r@eq:unreferenced".to_string(),
                    "{}{22}{}{equation.3.13}{}".to_string()
                ),
                ("b@knuth".to_string(), "1".to_string()),
                ("MT_r_eq:second".to_string(), String::new()),
            ]
        );
        // A label's existence is not evidence that it was referenced. Each read returns
        // only the markers actually present in the current aux snapshot.
        std::fs::write(&aux, "\\newlabel{eq:second}{{}{22}}\n").unwrap();
        assert_eq!(
            read_aux_labels(&aux),
            vec![("r@eq:second".to_string(), "{}{22}".to_string())]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mathtools_markers_follow_aux_inputs_once() {
        let dir =
            std::env::temp_dir().join(format!("rtex-aux-mathtools-input-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("chapters")).unwrap();
        std::fs::write(
            dir.join("main.aux"),
            "\\MT@newlabel{eq:main}\n\\@input{chapters/one.aux}\n\\@input{chapters/one.aux}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("chapters/one.aux"),
            "\\MT@newlabel{eq:one}\n\\@input{two.aux}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("chapters/two.aux"),
            "\\newlabel{eq:two}{{2}{3}}\n\\MT@newlabel{eq:two}\n\\@input{one.aux}\n",
        )
        .unwrap();
        assert_eq!(
            read_aux_labels(&dir.join("main.aux")),
            vec![
                ("MT_r_eq:main".to_string(), String::new()),
                ("MT_r_eq:one".to_string(), String::new()),
                ("r@eq:two".to_string(), "{2}{3}".to_string()),
                ("MT_r_eq:two".to_string(), String::new()),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mathtools_marker_command_boundaries_and_comments() {
        let dir =
            std::env::temp_dir().join(format!("rtex-aux-mathtools-lex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let aux = dir.join("main.aux");
        std::fs::write(
            &aux,
            concat!(
                "% \\MT@newlabel{commented}\n",
                "\\MT@newlabelExtra{longer-control-word}\n",
                "\\MT@newlabel@other{longer-at-control-word}\n",
                "\\\\MT@newlabel{escaped-slash}\n",
                "\\%\\MT@newlabel{after-escaped-percent}\n",
                "\\MT@newlabel \r\n {real} % \\MT@newlabel{trailing-comment}\n",
                "\\MT@newlabel\n",
            ),
        )
        .unwrap();
        assert_eq!(
            read_aux_labels(&aux),
            vec![
                ("MT_r_after-escaped-percent".to_string(), String::new()),
                ("MT_r_real".to_string(), String::new()),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

// ---------------------------------------------------------------------------------------------
// Standby background engine: a lualatex that has loaded the preamble and waits for the body.
// Engine start, format and preamble (packages, fonts) are ~75 % of a pass over a short
// document (docs/benchmarks.md), so a pass that only typesets the body is 3–4× faster.
// ---------------------------------------------------------------------------------------------

/// Snapshot layout for a standby pass: the project copied as for `write_snapshot`, the preamble
/// (text before `\begin{document}`) in `rtex-preamble.tex`, and `main` replaced by the body
/// preceded by as many empty lines as the preamble had, so every line number and `status.filename`
/// the capture records are those of the original file. Returns the preamble's hash.
pub fn write_body_snapshot(
    project: &Path,
    files: &BTreeMap<String, String>,
    main: &str,
    dir: &Path,
) -> Result<u64> {
    let main_text = files
        .get(main)
        .ok_or_else(|| anyhow::anyhow!("main file {main} not in snapshot"))?;
    let (pre, body) = crate::split_preamble(main_text)
        .ok_or_else(|| anyhow::anyhow!("no \\begin{{document}} in {main}"))?;
    let mut padded = String::with_capacity(main_text.len());
    for _ in 0..pre.matches('\n').count() {
        padded.push('\n');
    }
    padded.push_str(body);
    let mut files2 = files.clone();
    files2.insert(main.to_string(), padded);
    files2.insert("rtex-preamble.tex".to_string(), pre.to_string());
    write_snapshot(project, &files2, dir)?;
    Ok(crate::document::hash_str(&crate::document::expand_inputs(
        pre, files,
    )))
}

pub struct WarmEngine {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    stdout: Option<std::thread::JoinHandle<Vec<u8>>>,
    pub preamble_hash: u64,
    pub src_dir: PathBuf,
    out_dir: PathBuf,
    jobname: String,
    instrumented: bool,
    pub spawned: std::time::Instant,
}

/// What a standby engine runs: the project and its sources, where the body snapshot goes and
/// where the pass writes.
#[derive(Clone, Copy)]
pub struct StandbySpec<'a> {
    pub tl: &'a TexLive,
    pub project: &'a Path,
    pub files: &'a BTreeMap<String, String>,
    pub main: &'a str,
    pub src_dir: &'a Path,
    pub out_dir: &'a Path,
    pub instrumented: bool,
    pub unit_envs: &'a str,
}

impl WarmEngine {
    /// Start a standby: writes the body snapshot into `src_dir` and runs lualatex up to the end
    /// of the preamble, where it blocks on stdin (tex/rtex-bg.lua).
    pub fn spawn(spec: StandbySpec) -> Result<WarmEngine> {
        let StandbySpec {
            tl,
            project,
            files,
            main,
            src_dir,
            out_dir,
            instrumented,
            unit_envs,
        } = spec;
        let preamble_hash = write_body_snapshot(project, files, main, src_dir)?;
        let (mut cmd, jobname, out_dir) =
            capture_command(tl, src_dir, main, out_dir, instrumented, unit_envs)?;
        let pkg = if instrumented {
            "\\RequirePackage{rtex-capture}"
        } else {
            ""
        };
        cmd.arg(format!("{pkg}\\input{{rtex-preamble.tex}}\\directlua{{dofile(kpse.find_file(\"rtex-bg.lua\",\"lua\") or \"rtex-bg.lua\")}}\\input{{{main}}}"));
        cmd.env(
            "RTEX_BG_READY",
            crate::capture::standby_ready_path(&out_dir, &jobname),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().context("spawning standby lualatex")?;
        let stdin = child.stdin.take();
        // Drain from spawn, including while the engine loads a verbose preamble. Waiting for
        // readiness with an undrained stdout pipe can otherwise deadlock before the handshake.
        let mut stdout = child.stdout.take().context("standby stdout unavailable")?;
        let stdout = match std::thread::Builder::new()
            .name("rtex-standby-output".into())
            .spawn(move || {
                use std::io::Read;
                let mut bytes = Vec::new();
                let _ = stdout.read_to_end(&mut bytes);
                bytes
            }) {
            Ok(reader) => reader,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e).context("starting standby output reader");
            }
        };
        Ok(WarmEngine {
            child,
            stdin,
            stdout: Some(stdout),
            preamble_hash,
            src_dir: src_dir.to_path_buf(),
            out_dir,
            jobname,
            instrumented,
            spawned: std::time::Instant::now(),
        })
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Where this engine writes its pass (PDF, log, capture JSON, aux family).
    pub fn out_dir(&self) -> &Path {
        &self.out_dir
    }

    fn take_stdout(&mut self) -> Vec<u8> {
        self.stdout
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default()
    }

    fn wait_ready(&mut self) -> Result<()> {
        let ready = crate::capture::standby_ready_path(&self.out_dir, &self.jobname);
        let started = std::time::Instant::now();
        loop {
            if ready.is_file() {
                let _ = std::fs::remove_file(&ready);
                return Ok(());
            }
            if let Some(status) = self.child.try_wait().context("checking standby preamble")? {
                let stdout = self.take_stdout();
                let tail: String = String::from_utf8_lossy(&stdout)
                    .chars()
                    .rev()
                    .take(2000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                anyhow::bail!(
                    "standby preamble terminated before the body; lualatex exit {:?}\n{}",
                    status.code(),
                    tail
                );
            }
            if started.elapsed() >= std::time::Duration::from_secs(60) {
                anyhow::bail!("standby preamble did not become ready within 60 seconds");
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Typeset the body: refresh the snapshot texts (same preamble), release the engine and
    /// collect the pass like a fresh run.
    pub fn run(
        mut self,
        project: &Path,
        files: &BTreeMap<String, String>,
        main: &str,
    ) -> Result<CaptureResult> {
        let t0 = std::time::Instant::now();
        // Never queue GO while TeX is still interpreting the preamble: an error prompt could
        // consume it as a filename or recovery input and continue into an invalid body pass.
        self.wait_ready()?;
        let h = write_body_snapshot(project, files, main, &self.src_dir)?;
        if h != self.preamble_hash {
            anyhow::bail!("standby preamble differs from the snapshot");
        }
        {
            use std::io::Write;
            let mut stdin = self
                .stdin
                .take()
                .ok_or_else(|| anyhow::anyhow!("standby stdin already closed"))?;
            stdin.write_all(b"GO\n").context("releasing standby")?;
            stdin.flush().ok();
            drop(stdin);
        }
        let status = self.child.wait().context("waiting for standby pass")?;
        let stdout = self.take_stdout();
        collect_capture(
            &self.out_dir,
            &self.jobname,
            self.instrumented,
            status.success(),
            status.code(),
            &stdout,
            t0.elapsed(),
        )
    }

    pub fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for WarmEngine {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.take_stdout();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_test_dir(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("rtex-snapshot-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("project")).unwrap();
        root
    }

    #[test]
    fn snapshot_compares_contents_instead_of_timestamps() {
        let root = snapshot_test_dir("contents");
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        let source = project.join("figure.pdf");
        let target = snapshot.join("figure.pdf");
        let mut bytes = vec![b'a'; 128 * 1024 + 7];
        std::fs::write(&source, &bytes).unwrap();
        let files = BTreeMap::new();
        write_snapshot(&project, &files, &snapshot).unwrap();
        let set_time = |path: &Path, time| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(time))
                .unwrap();
        };
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1234567890);
        set_time(&target, time);
        for source_time in [time, time - std::time::Duration::from_secs(60)] {
            *bytes.last_mut().unwrap() += 1;
            std::fs::write(&source, &bytes).unwrap();
            set_time(&source, source_time);
            set_time(&target, time);
            write_snapshot(&project, &files, &snapshot).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), bytes);
        }
        set_time(&target, time);
        set_time(&source, time + std::time::Duration::from_secs(60));
        write_snapshot(&project, &files, &snapshot).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().modified().unwrap(),
            time,
            "identical input must not be rewritten even if its timestamp is newer"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_removes_only_managed_inputs_and_preserves_buffer_overlays() {
        let root = snapshot_test_dir("delete");
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        std::fs::create_dir_all(project.join("figures/nested")).unwrap();
        std::fs::write(project.join("figures/nested/old.pdf"), "old").unwrap();
        std::fs::write(project.join("main.tex"), "disk").unwrap();
        let files = BTreeMap::from([
            ("./main.tex".to_string(), "unsaved".to_string()),
            ("memory/only.tex".to_string(), "buffer only".to_string()),
        ]);
        write_snapshot(&project, &files, &snapshot).unwrap();
        std::fs::write(
            snapshot.join("figures/generated.dat"),
            "Lua preamble output",
        )
        .unwrap();
        std::fs::remove_dir_all(project.join("figures")).unwrap();
        std::fs::remove_file(project.join("main.tex")).unwrap();
        write_snapshot(&project, &files, &snapshot).unwrap();
        assert!(!snapshot.join("figures/nested").exists());
        assert_eq!(
            std::fs::read_to_string(snapshot.join("figures/generated.dat")).unwrap(),
            "Lua preamble output"
        );
        assert_eq!(
            std::fs::read_to_string(snapshot.join("main.tex")).unwrap(),
            "unsaved"
        );
        assert_eq!(
            std::fs::read_to_string(snapshot.join("memory/only.tex")).unwrap(),
            "buffer only"
        );
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert!(!snapshot.join("memory").exists());
        assert!(!snapshot.join("main.tex").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_handles_file_directory_replacements_in_both_directions() {
        let root = snapshot_test_dir("types");
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        let source = project.join("asset");
        std::fs::write(&source, "file").unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        std::fs::remove_file(&source).unwrap();
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("child.dat"), "nested").unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert_eq!(
            std::fs::read_to_string(snapshot.join("asset/child.dat")).unwrap(),
            "nested"
        );
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::write(&source, "file again").unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert_eq!(
            std::fs::read_to_string(snapshot.join("asset")).unwrap(),
            "file again"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_migrates_old_contents_without_replacing_the_working_directory() {
        let root = snapshot_test_dir("migration");
        let project = root.join("project");
        let snapshot = project.join("custom-cache/src");
        std::fs::create_dir_all(&snapshot).unwrap();
        std::fs::write(snapshot.join("deleted-legacy.pdf"), "stale").unwrap();
        std::fs::write(project.join("input.dat"), "new").unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&snapshot).unwrap().ino()
        };
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert!(!snapshot.join("deleted-legacy.pdf").exists());
        assert!(!snapshot.join("custom-cache").exists());
        assert_eq!(
            std::fs::read_to_string(snapshot.join("input.dat")).unwrap(),
            "new"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(&snapshot).unwrap().ino(), inode);
        }
        assert!(write_snapshot(&project, &BTreeMap::new(), &project).is_err());
        assert!(write_snapshot(&project, &BTreeMap::new(), &root).is_err());
        assert!(project.join("input.dat").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_does_not_follow_destination_symlinks_and_preserves_names() {
        use std::os::unix::{ffi::OsStringExt, fs::symlink};
        let root = snapshot_test_dir("symlinks");
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        let outside = root.join("outside");
        std::fs::create_dir_all(project.join("assets")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("assets/data"), "source").unwrap();
        std::fs::write(outside.join("data"), "untouched").unwrap();
        let names = BTreeSet::from([std::ffi::OsString::from_vec(vec![b'x', 0xff])]);
        let bytes = serde_json::to_vec(&names).unwrap();
        assert_eq!(
            serde_json::from_slice::<BTreeSet<std::ffi::OsString>>(&bytes).unwrap(),
            names
        );
        let name = "图片 with spaces.dat";
        std::fs::write(project.join(name), "named input").unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        std::fs::remove_dir_all(snapshot.join("assets")).unwrap();
        symlink(&outside, snapshot.join("assets")).unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert_eq!(
            std::fs::read_to_string(snapshot.join("assets/data")).unwrap(),
            "source"
        );
        assert_eq!(
            std::fs::read_to_string(snapshot.join(&name)).unwrap(),
            "named input"
        );
        std::fs::remove_dir_all(snapshot.join("assets")).unwrap();
        symlink(&outside, snapshot.join("assets")).unwrap();
        std::fs::remove_dir_all(project.join("assets")).unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert!(!snapshot.join("assets").exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("data")).unwrap(),
            "untouched"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_replaces_a_socket_target_with_the_current_input() {
        // Unix-domain socket addresses need a short path even when TMPDIR is long.
        let root = PathBuf::from(format!("/tmp/rtex-snapshot-socket-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("data"), "input").unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        std::fs::remove_file(snapshot.join("data")).unwrap();
        let _socket = std::os::unix::net::UnixListener::bind(snapshot.join("data")).unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert_eq!(
            std::fs::read_to_string(snapshot.join("data")).unwrap(),
            "input"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_rejects_untrusted_inventory_paths() {
        let root = snapshot_test_dir("inventory");
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        std::fs::create_dir(&snapshot).unwrap();
        let outside = root.join("keep.dat");
        std::fs::write(&outside, "untouched").unwrap();
        let paths = BTreeSet::from([std::ffi::OsString::from("../keep.dat")]);
        std::fs::write(
            snapshot.join(".rtex-snapshot-inputs.json"),
            serde_json::to_vec(&paths).unwrap(),
        )
        .unwrap();
        assert!(write_snapshot(&project, &BTreeMap::new(), &snapshot).is_err());
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "untouched");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_tracks_partial_copies_when_later_reads_fail() {
        use std::os::unix::fs::PermissionsExt;
        let root = snapshot_test_dir("failure");
        let project = root.join("project");
        let snapshot = root.join("snapshot");
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        std::fs::write(project.join("a.dat"), "copied first").unwrap();
        std::fs::write(project.join("z.dat"), "unreadable").unwrap();
        std::fs::set_permissions(project.join("z.dat"), std::fs::Permissions::from_mode(0))
            .unwrap();
        assert!(write_snapshot(&project, &BTreeMap::new(), &snapshot).is_err());
        assert!(snapshot.join("a.dat").is_file());
        std::fs::remove_file(project.join("a.dat")).unwrap();
        std::fs::set_permissions(
            project.join("z.dat"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        write_snapshot(&project, &BTreeMap::new(), &snapshot).unwrap();
        assert!(!snapshot.join("a.dat").exists());
        assert_eq!(
            std::fs::read_to_string(snapshot.join("z.dat")).unwrap(),
            "unreadable"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_copies_nested_folders() {
        let dir = std::env::temp_dir().join(format!("rtex-snap-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("a/b")).unwrap();
        std::fs::write(project.join("main.tex"), "x").unwrap();
        std::fs::write(project.join("a/b/file.txt"), "nested").unwrap();
        std::fs::write(project.join("a/top.bib"), "bib").unwrap();
        let mut files = BTreeMap::new();
        files.insert("main.tex".to_string(), "edited".to_string());
        write_snapshot(&project, &files, &dir.join("snap")).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("snap/a/b/file.txt")).unwrap(),
            "nested"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("snap/a/top.bib")).unwrap(),
            "bib"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("snap/main.tex")).unwrap(),
            "edited"
        );
        // a second snapshot (files already present) is fine too
        write_snapshot(&project, &files, &dir.join("snap")).unwrap();
    }

    #[test]
    fn index_commands_follow_imakeidx() {
        let rec = "makeindex -s mystyle.ist main.idx\ntexindy -L english -C utf8 names.idx\n";
        assert_eq!(
            index_command(rec, "main.idx"),
            (
                "makeindex".to_string(),
                vec!["-q", "-s", "mystyle.ist", "main.idx"]
                    .into_iter()
                    .map(String::from)
                    .collect()
            )
        );
        assert_eq!(index_command(rec, "names.idx").0, "texindy");
        assert_eq!(
            index_command(rec, "names.idx").1.last().unwrap(),
            "names.idx"
        );
        // no record (makeidx, or an index imakeidx never printed): plain makeindex
        assert_eq!(
            index_command(rec, "other.idx"),
            (
                "makeindex".to_string(),
                vec!["-q".to_string(), "other.idx".to_string()]
            )
        );
        // a program outside the list is not run
        assert_eq!(index_command("rm -rf x.idx", "x.idx").0, "makeindex");
    }

    #[test]
    fn signature_ignores_the_pass_directory() {
        let dir = std::env::temp_dir().join(format!("rtex-sig-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (a, b) = (dir.join("pass-0"), dir.join("pass-1"));
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
            let p = crate::paths::canonical(d).unwrap().join("main.ind");
            let hex: String = p
                .to_string_lossy()
                .bytes()
                .map(|x| format!("{x:02X}"))
                .collect();
            std::fs::write(
                d.join("main.aux"),
                format!(
                    "\\BKM@entry{{srcfile={{{hex}}}}}\n\\@input{{{}}}\n",
                    p.display()
                ),
            )
            .unwrap();
            std::fs::write(d.join("main.ind"), "\\begin{theindex}\\end{theindex}").unwrap();
        }
        assert_eq!(aux_signature(&a, "main"), aux_signature(&b, "main"));
        std::fs::write(
            b.join("main.ind"),
            "\\begin{theindex}\\item x\\end{theindex}",
        )
        .unwrap();
        assert_ne!(aux_signature(&a, "main"), aux_signature(&b, "main"));
    }

    #[test]
    fn snapshot_keeps_input_pdfs_and_drops_built_ones() {
        let dir = std::env::temp_dir().join(format!("rtex-snap-pdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("images")).unwrap();
        std::fs::write(project.join("main.tex"), "x").unwrap();
        std::fs::write(project.join("main.pdf"), "built").unwrap();
        std::fs::write(project.join("figure.pdf"), "input").unwrap();
        std::fs::write(project.join("images/plot.pdf"), "input").unwrap();
        // a standalone figure: its source sits next to it but the document only reads the PDF
        std::fs::write(project.join("images/fig.tex"), "standalone").unwrap();
        std::fs::write(project.join("images/fig.pdf"), "input").unwrap();
        let files = BTreeMap::from([("main.tex".to_string(), "x".to_string())]);
        write_snapshot(&project, &files, &dir.join("snap")).unwrap();
        assert!(dir.join("snap/images/fig.pdf").is_file());
        assert!(!dir.join("snap/main.pdf").exists());
        assert!(dir.join("snap/figure.pdf").is_file());
        assert!(dir.join("snap/images/plot.pdf").is_file());
    }

    #[test]
    fn body_snapshot_keeps_line_numbers() {
        let dir = std::env::temp_dir().join(format!("rtex-body-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let main = "\\documentclass{article}\n\\usepackage{xcolor}\n% two\n\\begin{document}\nFirst line of the body.\n\n\\end{document}\n";
        std::fs::write(project.join("main.tex"), main).unwrap();
        let mut files = BTreeMap::new();
        files.insert("main.tex".to_string(), main.to_string());
        let h = write_body_snapshot(&project, &files, "main.tex", &dir.join("snap")).unwrap();
        let pre = std::fs::read_to_string(dir.join("snap/rtex-preamble.tex")).unwrap();
        let body = std::fs::read_to_string(dir.join("snap/main.tex")).unwrap();
        assert_eq!(
            pre,
            "\\documentclass{article}\n\\usepackage{xcolor}\n% two\n"
        );
        assert_eq!(h, crate::document::hash_str(&pre));
        // \begin{document} is on line 4 in both the original and the padded body file
        assert_eq!(
            main.lines()
                .position(|l| l.starts_with("\\begin{document}")),
            Some(3)
        );
        assert_eq!(
            body.lines()
                .position(|l| l.starts_with("\\begin{document}")),
            Some(3)
        );
        assert_eq!(body.lines().count(), main.lines().count());
        assert_eq!(body.lines().nth(4), Some("First line of the body."));
    }
}
