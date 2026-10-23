//! The standby background engine (preamble preloaded, body streamed in) must produce the same
//! capture as a fresh run: same units, lines, rows and placements. Skipped without lualatex.

use rtex_core::background::{read_aux_labels, write_snapshot, WarmEngine};
use rtex_core::capture::run_capture_with;
use rtex_core::fixtures::{generate, FontSet, Variant};
use rtex_core::texlive::TexLive;
use std::collections::BTreeMap;

#[test]
fn snapshot_refresh_updates_inputs_and_preserves_generated_files() {
    let Ok(tl) = TexLive::discover() else {
        eprintln!("SKIP: no lualatex");
        return;
    };
    let root = std::env::temp_dir().join(format!("rtex-snapshot-refresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let main = r#"\documentclass{article}
\begin{filecontents*}{filecontents-generated.dat}
\typeout{RTEX-FILECONTENTS-GENERATED}
\end{filecontents*}
\directlua{local f=assert(io.open("lua-generated.dat","w")); f:write(string.char(92).."typeout{RTEX-LUA-GENERATED}"); f:close()}
\begin{document}
\typeout{RTEX-BUFFERED-MAIN}
Buffered synthetic body.
\input{lua-generated.dat}
\input{filecontents-generated.dat}
\input{resource.dat}
\end{document}
"#;
    let files = BTreeMap::from([("main.tex".to_string(), main.to_string())]);
    for warm in [false, true] {
        let build = root.join(if warm { "warm" } else { "cold" });
        let project = build.join("project");
        let src = build.join("src");
        let out = build.join("out");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("main.tex"), main.replace("BUFFERED", "DISK")).unwrap();
        let resource = project.join("resource.dat");
        std::fs::write(&resource, "\\typeout{RTEX-RESOURCE-ALPHA}\n").unwrap();
        let mut copied_time = None;
        #[cfg(unix)]
        let mut root_inode = None;
        for (phase, marker) in ["ALPHA", "BRAVO", "MISSING", "DELTA"].iter().enumerate() {
            let engine = if warm {
                let engine = WarmEngine::spawn(rtex_core::background::StandbySpec {
                    tl: &tl,
                    project: &project,
                    files: &files,
                    main: "main.tex",
                    src_dir: &src,
                    out_dir: &out,
                    instrumented: true,
                    unit_envs: "",
                })
                .unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
                while !out.join("main.rtex-bg-ready").is_file() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "standby was not ready"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Some(engine)
            } else {
                write_snapshot(&project, &files, &src).unwrap();
                None
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let inode = std::fs::metadata(&src).unwrap().ino();
                assert_eq!(*root_inode.get_or_insert(inode), inode);
            }
            if let Ok(metadata) = std::fs::metadata(src.join("resource.dat")) {
                copied_time = Some(metadata.modified().unwrap());
            }
            match phase {
                1 | 3 => {
                    std::fs::write(&resource, format!("\\typeout{{RTEX-RESOURCE-{marker}}}\n"))
                        .unwrap();
                    std::fs::File::open(&resource)
                        .unwrap()
                        .set_times(std::fs::FileTimes::new().set_modified(copied_time.unwrap()))
                        .unwrap();
                    if phase == 1 {
                        let source = std::fs::metadata(&resource).unwrap();
                        let snapshot = std::fs::metadata(src.join("resource.dat")).unwrap();
                        assert_eq!(source.len(), snapshot.len());
                        assert_eq!(source.modified().unwrap(), snapshot.modified().unwrap());
                    }
                }
                2 => std::fs::remove_file(&resource).unwrap(),
                _ => {}
            }
            let result = if let Some(engine) = engine {
                engine.run(&project, &files, "main.tex")
            } else {
                write_snapshot(&project, &files, &src).unwrap();
                if phase > 0 {
                    assert!(src.join("lua-generated.dat").is_file());
                }
                run_capture_with(&tl, &src, "main.tex", &out, true, "")
            };
            assert!(
                src.join("lua-generated.dat").is_file(),
                "warm={warm}: Lua cwd output was deleted"
            );
            assert!(out.join("filecontents-generated.dat").is_file());
            assert!(!src.join("filecontents-generated.dat").exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(root_inode.unwrap(), std::fs::metadata(&src).unwrap().ino());
            }
            let log = std::fs::read_to_string(out.join("main.log")).unwrap();
            if phase == 2 {
                assert!(!src.join("resource.dat").exists());
                assert!(result.is_err() || !result.as_ref().unwrap().exit_ok);
                assert!(
                    log.contains("resource.dat") && log.contains("not found"),
                    "{log}"
                );
            } else {
                let cap = result.unwrap();
                assert!(cap.exit_ok, "warm={warm}, phase={phase}: {log}");
                assert_eq!(cap.json.pages, 1);
                assert!(log.contains(&format!("RTEX-RESOURCE-{marker}")), "{log}");
                assert!(log.contains("RTEX-LUA-GENERATED"));
                assert!(log.contains("RTEX-FILECONTENTS-GENERATED"));
                assert!(log.contains("RTEX-BUFFERED-MAIN"));
                assert!(!log.contains("RTEX-DISK-MAIN"));
            }
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_preamble_cannot_reuse_capture_and_recovers_in_the_same_directories() {
    let Ok(tl) = TexLive::discover() else {
        eprintln!("SKIP: no lualatex");
        return;
    };
    let root = std::env::temp_dir().join(format!("rtex-preamble-recovery-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let good = "\\documentclass{article}\n\\begin{document}\nOriginal synthetic paragraph.\n\\end{document}\n";
    let fixed = good.replace("Original", "Recovered");
    let broken = good.replace("\\begin{document}", "\\stop\n\\begin{document}");
    let source = project.join("main.tex");
    for warm in [false, true] {
        let out = root.join(if warm { "warm" } else { "cold" });
        let src_dir = root.join("body");
        for (text, should_succeed) in [
            (good, true),
            (broken.as_str(), false),
            (fixed.as_str(), true),
        ] {
            std::fs::write(&source, text).unwrap();
            let files = BTreeMap::from([("main.tex".to_string(), text.to_string())]);
            let result = if warm {
                WarmEngine::spawn(rtex_core::background::StandbySpec {
                    tl: &tl,
                    project: &project,
                    files: &files,
                    main: "main.tex",
                    src_dir: &src_dir,
                    out_dir: &out,
                    instrumented: true,
                    unit_envs: "",
                })
                .unwrap()
                .run(&project, &files, "main.tex")
            } else {
                run_capture_with(&tl, &project, "main.tex", &out, true, "")
            };
            if should_succeed {
                let cap = result.unwrap();
                assert!(
                    cap.exit_ok,
                    "warm={warm}: corrected preamble did not recover"
                );
                assert_eq!(cap.json.pages, 1);
                assert!(cap.pdf.is_file());
                assert!(!cap.json.paragraphs.is_empty());
            } else {
                let err = result.expect_err("early preamble stop reused a successful capture");
                assert!(
                    !out.join("main.rtex.json").exists(),
                    "warm={warm}: stale capture survived"
                );
                assert!(
                    !out.join("main.pdf").exists(),
                    "warm={warm}: stale PDF survived"
                );
                assert!(!out.join("main.rtex-page1.json").exists());
                let log = std::fs::read_to_string(out.join("main.log")).unwrap();
                assert!(
                    log.to_lowercase().contains("no pages of output"),
                    "failure log is stale: {log}"
                );
                if warm {
                    assert!(err
                        .to_string()
                        .contains("preamble terminated before the body"));
                }
            }
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn standby_verbose_preamble_does_not_block_readiness() {
    let Ok(tl) = TexLive::discover() else {
        eprintln!("SKIP: no lualatex");
        return;
    };
    let root = std::env::temp_dir().join(format!("rtex-standby-verbose-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    // More than a pipe buffer of terminal output before READY must not stall the preamble.
    let text = "\\documentclass{article}\n\\directlua{for i=1,10000 do texio.write_nl(\"term and log\",\"Synthetic verbose preamble output before readiness.\") end}\n\\begin{document}\nSynthetic body.\n\\end{document}\n";
    let files = BTreeMap::from([("main.tex".to_string(), text.to_string())]);
    std::fs::write(project.join("main.tex"), text).unwrap();
    let engine = WarmEngine::spawn(rtex_core::background::StandbySpec {
        tl: &tl,
        project: &project,
        files: &files,
        main: "main.tex",
        src_dir: &root.join("src-body"),
        out_dir: &root.join("out"),
        instrumented: true,
        unit_envs: "",
    })
    .unwrap();
    let cap = engine.run(&project, &files, "main.tex").unwrap();
    assert!(cap.exit_ok);
    assert_eq!(cap.json.pages, 1);
    assert!(std::fs::metadata(cap.log).unwrap().len() > 400_000);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn standby_pass_matches_fresh_pass() {
    let Ok(tl) = TexLive::discover() else {
        eprintln!("SKIP: no lualatex");
        return;
    };
    let root = std::env::temp_dir().join(format!("rtex-standby-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let project = root.join("project");
    generate(3, Variant::Units, FontSet::LmTfm, 1, &project).unwrap();
    let main = std::fs::read_to_string(project.join("main.tex")).unwrap();
    let mut files = BTreeMap::new();
    files.insert("main.tex".to_string(), main);
    // fresh run (two passes so labels exist on both sides)
    let fresh_out = root.join("fresh");
    run_capture_with(&tl, &project, "main.tex", &fresh_out, true, "").unwrap();
    let fresh = run_capture_with(&tl, &project, "main.tex", &fresh_out, true, "").unwrap();
    // standby: spawn, wait a moment (preamble loading), release
    let warm_out = root.join("warm");
    let body_dir = root.join("src-body");
    let w = WarmEngine::spawn(rtex_core::background::StandbySpec {
        tl: &tl,
        project: &project,
        files: &files,
        main: "main.tex",
        src_dir: &body_dir,
        out_dir: &warm_out,
        instrumented: true,
        unit_envs: "",
    })
    .unwrap();
    let first = w.run(&project, &files, "main.tex").unwrap();
    assert!(first.exit_ok, "standby pass failed");
    let w2 = WarmEngine::spawn(rtex_core::background::StandbySpec {
        tl: &tl,
        project: &project,
        files: &files,
        main: "main.tex",
        src_dir: &body_dir,
        out_dir: &warm_out,
        instrumented: true,
        unit_envs: "",
    })
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let t0 = std::time::Instant::now();
    let warm = w2.run(&project, &files, "main.tex").unwrap();
    let warm_wall = t0.elapsed();
    assert!(warm.exit_ok);
    eprintln!(
        "fresh pass {:.2}s, standby body pass {:.2}s",
        fresh.wall.as_secs_f64(),
        warm_wall.as_secs_f64()
    );
    assert_eq!(warm.json.pages, fresh.json.pages);
    assert_eq!(warm.json.units.len(), fresh.json.units.len());
    for (a, b) in warm.json.units.iter().zip(fresh.json.units.iter()) {
        // files are compared by name: the TOC unit comes from <out_dir>/main.toc on each side
        let base = |f: &Option<String>| {
            f.as_ref().map(|f| {
                std::path::Path::new(f)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            })
        };
        assert_eq!(
            (
                a.kind.clone(),
                a.name.clone(),
                base(&a.file),
                a.begin_line,
                a.end_line
            ),
            (
                b.kind.clone(),
                b.name.clone(),
                base(&b.file),
                b.begin_line,
                b.end_line
            )
        );
        assert_eq!(
            a.placements.len(),
            b.placements.len(),
            "unit {} rows",
            a.uid
        );
        for (pa, pb) in a.placements.iter().zip(b.placements.iter()) {
            assert_eq!((pa.page, pa.x, pa.y), (pb.page, pb.x, pb.y));
        }
    }
    assert_eq!(
        read_aux_labels(&warm_out.join("main.aux")),
        read_aux_labels(&fresh_out.join("main.aux"))
    );
    for n in 1..=fresh.json.pages {
        assert_eq!(
            warm.page(n).unwrap().glyphs,
            fresh.page(n).unwrap().glyphs,
            "page {n} glyphs"
        );
    }
}
