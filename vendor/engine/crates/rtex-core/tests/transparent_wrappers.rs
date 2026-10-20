//! Local revision scopes and appendix containers preserve the source and its captured
//! context while their paragraphs and proofs remain live. Skipped without LuaLaTeX.

use rtex_core::texlive::TexLive;
use rtex_core::{Convergence, Edit, Event, Session, SessionConfig};
use rtex_dl::Item;
use std::path::PathBuf;
use std::time::Duration;

const DOC: &str = r#"\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{xcolor,amsthm,amsmath}
\newenvironment{OLD}{\color{gray}}{\ignorespacesafterend}
\newenvironment{REV}{\color{red}}{\ignorespacesafterend}
\newcommand{\fixtureprobe}{\iftrue\relax\fi}
\begin{document}
Main text before the revision scopes.

\begin{REV}
FIRSTPAR \fixtureprobe A revised paragraph.

SECONDPAR A second revised paragraph in the same color group.
\end{REV}

\begin{OLD}

\begin{proof}
OLDPROOF \fixtureprobe This entire proof is gray.
\begin{REV}
The nested revision is red and includes $x=x$.
\end{REV}
\end{proof}
\end{OLD}
\begin{REV}
\begin{proof}
REVPROOF \fixtureprobe This entire proof is red.
\end{proof}
\end{REV}
\begin{equation*}
x=x
\end{equation*}

\begin{appendix}
\section{First appendix}
\begin{REV}
\begin{proof}
APPENDIXA \fixtureprobe The first appendix has its own live proof.
\end{proof}
\end{REV}

\section{Second appendix}
\begin{OLD}
\begin{proof}
APPENDIXB \fixtureprobe The second appendix has a separate live proof.
\end{proof}
\end{OLD}
\end{appendix}
\end{document}
"#;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn revision_paragraphs_wrapped_proofs_and_both_appendices_update_live() {
    if let Err(e) = TexLive::discover() {
        eprintln!("SKIP: {e}");
        return;
    }
    let root = Scratch(
        std::env::temp_dir().join(format!("rtex-transparent-wrappers-{}", std::process::id())),
    );
    let _ = std::fs::remove_dir_all(&root.0);
    let project = root.0.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let main = project.join("main.tex");
    std::fs::write(&main, DOC).unwrap();
    let mut cfg = SessionConfig::new(&project, "main.tex");
    cfg.build_dir = root.0.join("build");
    let session = Session::open(cfg).unwrap();
    let (layout, events) = session.wait_for(Duration::from_secs(90), |event| {
        matches!(
            event,
            Event::LayoutUpdate {
                convergence: Convergence::Converged,
                ..
            }
        )
    });
    assert!(layout.is_some(), "no converged fixture layout: {events:?}");
    session.pause_background(true);
    for marker in [
        "FIRSTPAR",
        "SECONDPAR",
        "OLDPROOF",
        "REVPROOF",
        "APPENDIXA",
        "APPENDIXB",
    ] {
        let source = session.document_text("main.tex").unwrap();
        let at = source.find(marker).unwrap() + marker.len();
        let edit = session
            .apply_edit(
                "main.tex",
                Edit {
                    start_byte: at,
                    end_byte: at,
                    text: "X".into(),
                },
            )
            .unwrap();
        assert_eq!(edit.routed, "fast", "{marker}: {:?}", edit.reasons);
        let (update, events) = session.wait_for(Duration::from_secs(30), |event| {
            matches!(event, Event::ParagraphUpdate { edit_id, .. } | Event::BackgroundScheduled { edit_id, .. } if *edit_id == edit.edit_id)
        });
        let Some(Event::ParagraphUpdate {
            status,
            reasons,
            fragments,
            dl,
            timing,
            ..
        }) = update
        else {
            panic!("{marker} fell back rather than updating live: {update:?}; {events:?}");
        };
        assert_eq!(status, "ok", "{marker}: {reasons:?}");
        assert!(!fragments.is_empty(), "{marker}: missing placement");
        let text: String = dl
            .lines
            .iter()
            .flat_map(|line| line.items.iter())
            .filter_map(|item| match item {
                Item::Glyph { char, .. } => char::from_u32(*char as u32),
                _ => None,
            })
            .collect();
        assert!(
            text.contains(&format!("{marker}X")),
            "{marker}: edited text missing from live display list {text}"
        );
        eprintln!("{marker}: live {} us", timing.total_us);
    }
    assert_eq!(
        std::fs::read_to_string(main).unwrap(),
        DOC,
        "edits must remain in memory"
    );
}
