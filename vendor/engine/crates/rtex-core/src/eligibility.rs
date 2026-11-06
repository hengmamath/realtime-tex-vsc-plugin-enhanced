//! Conservative fast-path eligibility: an **allow-list** over a unit's source.
//!
//! A unit (paragraph, block environment or heading) may take the per-keystroke path only when
//! it can be typeset in isolation with no effect on, and no dependence on, state outside the
//! unit beyond what the captured context replays (parameters, fonts, counters, labels). Anything
//! not explicitly allowed — including every macro defined in the preamble — sends the unit to the
//! background path. See docs/how-it-works.md and docs/live-editing.md.

use std::collections::{BTreeMap, BTreeSet};

/// Why a unit is not fast-eligible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    Blank,
    UnbalancedBraces,
    UnbalancedMath,
    /// A known math construct is still missing a delimiter or argument. Unlike vocabulary
    /// refusals, this must not be sent to the live server to discover its meaning by probing.
    IncompleteMath,
    /// A standard text command or literal argument is still being typed.
    IncompleteCommand,
    UnbalancedEnvironment,
    DisplayMath,
    EnvironmentBoundary,
    /// Text continues after a block environment inside the same span.
    TextAfterEnvironment,
    DisallowedEnvironment(String),
    ParagraphBreak,
    Verbatim,
    DisallowedMacro(String),
    DisallowedMathMacro(String),
    /// A macro that is only meaningful inside a particular environment (`\item`, `\caption`, `\hline`).
    MacroOutsideContext(String),
    /// A package the construct needs is not loaded (amsmath, graphicx, booktabs).
    NeedsPackage(String),
    /// A counter command before the unit's first text runs in vertical mode, before the point
    /// where the unit's counters are captured; replaying it would count twice.
    LeadingCounter(String),
    /// The span is document setup (`\newcommand`, `\setlength`, `\renewcommand{\arraystretch}`
    /// … after `\begin{document}`): it draws nothing, and the server loads it with the preamble.
    SetupStatement,
    SizeDeclarationOutsideGroup(String),
    EngineFlag(String),
    NoContext,
    NoPlacement,
    NotTopLevel,
    NonDefaultEverypar,
    /// The unit's source shape (paragraph / environment / heading) does not match the layout's unit.
    KindMismatch,
    /// The last fast compile of this unit exceeded the session's budget (ms).
    OverBudget(u64),
    /// A run-in heading (`\paragraph`, `\subparagraph`): LaTeX typesets its title at the
    /// start of the following paragraph, whose lines the unit then shares.
    RunInHeading(String),
    /// The unit reads state that its context does not carry (enumitem's `resume` and
    /// `series`: the item count of an earlier list, kept in a macro, not a counter).
    OutsideState(String),
}

impl Reason {
    /// Transient source structures that can become live again as typing completes them.
    pub fn is_unfinished(&self) -> bool {
        matches!(
            self,
            Self::UnbalancedBraces
                | Self::UnbalancedMath
                | Self::UnbalancedEnvironment
                | Self::IncompleteMath
                | Self::IncompleteCommand
        )
    }
}

impl std::fmt::Display for Reason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reason::DisallowedMacro(m) => {
                write!(f, "macro \\{m} is not on the fast-path allow-list")
            }
            Reason::DisallowedMathMacro(m) => {
                write!(f, "math macro \\{m} is not on the fast-path allow-list")
            }
            Reason::DisallowedEnvironment(e) => {
                write!(f, "environment {e} is not on the fast-path allow-list")
            }
            Reason::MacroOutsideContext(m) => {
                write!(f, "\\{m} outside the environment it belongs to")
            }
            Reason::NeedsPackage(p) => {
                write!(f, "needs package {p}, which the preamble does not load")
            }
            Reason::SizeDeclarationOutsideGroup(m) => write!(
                f,
                "\\{m} outside a brace group would leak past the paragraph"
            ),
            Reason::EngineFlag(s) => write!(f, "engine saw {s} in this unit"),
            Reason::SetupStatement => write!(
                f,
                "document setup (definitions, lengths): loaded with the preamble, draws nothing"
            ),
            Reason::LeadingCounter(m) => write!(
                f,
                "\\{m} before the unit's text runs before its counters are captured; put it inside the paragraph or environment, or on its own line"
            ),
            Reason::OverBudget(ms) => write!(f, "last fast compile took {ms} ms, over the budget"),
            Reason::OutsideState(what) => write!(
                f,
                "{what} reads state from earlier in the document that the fast path does not replay"
            ),
            Reason::RunInHeading(h) => write!(
                f,
                "\\{h} is a run-in heading: its title is set in the following paragraph"
            ),
            other => write!(f, "{other:?}"),
        }
    }
}

/// The shape of a unit's source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitShape {
    Par,
    Env(String),
    Heading(String),
}

const TEXT_WRAPPERS: &[&str] = &[
    "emph",
    "textit",
    "textbf",
    "textsc",
    "textsf",
    "texttt",
    "textrm",
    "textmd",
    "textup",
    "textsl",
    "textnormal",
    "textsuperscript",
    "textsubscript",
    "text",
    "mbox",
];

const TEXT_MACROS: &[&str] = &[
    // spacing and breaks
    "\\",
    ",",
    ";",
    ":",
    "!",
    "quad",
    "qquad",
    "hspace",
    "hspace*",
    "phantom",
    "hphantom",
    "vphantom",
    "noindent",
    "indent",
    "thinspace",
    "enspace",
    "enskip",
    "nolinebreak",
    "linebreak",
    "newline",
    "allowbreak",
    "-",
    "/",
    "@",
    " ", // control space
    "hfill",
    "hfil",
    "hss",
    "vspace",
    "vspace*",
    "smallskip",
    "medskip",
    "bigskip",
    "strut",
    "relax",
    "par",
    "vfill",
    "vfil",
    "newpage",
    "clearpage",
    "pagebreak",
    "nopagebreak",
    "samepage",
    "thispagestyle",
    // boxes and rules (pure horizontal material)
    "parbox",
    "fbox",
    "framebox",
    "makebox",
    "raisebox",
    "colorbox",
    "fcolorbox",
    "underline",
    "rule",
    "hrulefill",
    "dotfill",
    // counters: the server restores the idle values after each compile and reports what the
    // unit advanced; the session schedules a pass when that changes (what follows renumbers)
    "setcounter",
    "addtocounter",
    "stepcounter",
    "refstepcounter",
    // counter formats (enumitem label specs, \alph{counter} …)
    "alph",
    "Alph",
    "arabic",
    "roman",
    "Roman",
    "fnsymbol",
    "arraybackslash",
    "tabularnewline",
    "checkmark",
    // color (xcolor)
    "textcolor",
    "color",
    // characters, accents, symbols
    "'",
    "`",
    "^",
    "\"",
    "~",
    "=",
    ".",
    "u",
    "v",
    "H",
    "t",
    "c",
    "d",
    "b",
    "r",
    "k",
    "ss",
    "SS",
    "ae",
    "AE",
    "oe",
    "OE",
    "o",
    "O",
    "l",
    "L",
    "aa",
    "AA",
    "i",
    "j",
    "dh",
    "DH",
    "th",
    "TH",
    "ng",
    "NG",
    "&",
    "%",
    "$",
    "#",
    "_",
    "{",
    "}",
    "ldots",
    "dots",
    "textellipsis",
    "LaTeX",
    "TeX",
    "LaTeXe",
    "textendash",
    "textemdash",
    "textquoteleft",
    "textquoteright",
    "textquotedblleft",
    "textquotedblright",
    "textregistered",
    "copyright",
    "texttrademark",
    "textbackslash",
    "textbar",
    "textless",
    "textgreater",
    "textasciitilde",
    "textasciicircum",
    "textbullet",
    "textdagger",
    "textdaggerdbl",
    "textsection",
    "textparagraph",
    "textdegree",
    "textperiodcentered",
    "textvisiblespace",
    "textunderscore",
    "textbraceleft",
    "textbraceright",
    "textdollar",
    "textsterling",
    "texteuro",
    "textminus",
    "textasteriskcentered",
    "slash",
    "textcompwordmark",
    "nobreakspace",
    "ensuremath",
    "lowercase",
    "uppercase",
    "MakeUppercase",
    "MakeLowercase",
    "today",
    // cross-references, notes, index (replayed from the last pass's aux)
    "ref",
    "pageref",
    "label",
    // manual bibliographies (thebibliography is a block environment)
    "bibitem",
    "newblock",
    // title block (article/report without titlepage: a center environment; the server keeps
    // the kernel macros usable between compiles)
    "title",
    "author",
    "date",
    "thanks",
    "and",
    "maketitle",
    // symbols
    "S",
    "P",
    "dag",
    "ddag",
    "pounds",
    "guillemotleft",
    "guillemotright",
    "protect",
    "selectfont",
    "footnote",
    "footnotemark",
    "footnotetext",
    "index",
    "nocite",
    // lengths usable inside arguments
    "textwidth",
    "linewidth",
    "columnwidth",
    "textheight",
    "baselineskip",
    "parindent",
    "paperwidth",
    "paperheight",
    // alignment declarations (local to the environment they appear in)
    "centering",
    "raggedright",
    "raggedleft",
];

/// Declarations that are only allowed *inside* a brace group or an environment (they would
/// otherwise leak).
const GROUP_ONLY_DECLARATIONS: &[&str] = &[
    "frenchspacing",
    "nonfrenchspacing",
    // LaTeX 2.09 font switches (article/report/book define them: \normalfont\rmfamily …)
    "rm",
    "bf",
    "it",
    "sl",
    "sc",
    "sf",
    "tt",
    "em",
    "itshape",
    "bfseries",
    "scshape",
    "sffamily",
    "ttfamily",
    "rmfamily",
    "mdseries",
    "upshape",
    "slshape",
    "normalfont",
    "em",
    "tiny",
    "scriptsize",
    "footnotesize",
    "small",
    "normalsize",
    "large",
    "Large",
    "LARGE",
    "huge",
    "Huge",
];

const MATH_MACROS: &[&str] = &[
    "frac",
    "dfrac",
    "tfrac",
    "sqrt",
    "sum",
    "prod",
    "int",
    "iint",
    "oint",
    "lim",
    "limsup",
    "liminf",
    "infty",
    "cdot",
    "cdots",
    "ldots",
    "dots",
    "vdots",
    "ddots",
    "times",
    "div",
    "pm",
    "mp",
    "leq",
    "le",
    "geq",
    "ge",
    "neq",
    "ne",
    "approx",
    "equiv",
    "sim",
    "simeq",
    "cong",
    "propto",
    "to",
    "rightarrow",
    "leftarrow",
    "Rightarrow",
    "Leftarrow",
    "leftrightarrow",
    "Leftrightarrow",
    "mapsto",
    "longrightarrow",
    "in",
    "notin",
    "ni",
    "subset",
    "subseteq",
    "supset",
    "supseteq",
    "cup",
    "cap",
    "setminus",
    "emptyset",
    "varnothing",
    "forall",
    "exists",
    "nexists",
    "neg",
    "lnot",
    "land",
    "lor",
    "wedge",
    "vee",
    "partial",
    "nabla",
    "triangle",
    "rm",
    "bf",
    "it",
    "sf",
    "tt",
    "sc",
    "cal",
    "mit",
    "uparrow",
    "downarrow",
    "Uparrow",
    "Downarrow",
    "updownarrow",
    "Updownarrow",
    "nearrow",
    "searrow",
    "swarrow",
    "nwarrow",
    "longleftarrow",
    "Longrightarrow",
    "Longleftarrow",
    "longleftrightarrow",
    "Longleftrightarrow",
    "longmapsto",
    "hookrightarrow",
    "hookleftarrow",
    "iiiint",
    "idotsint",
    "models",
    "vdash",
    "dashv",
    "smile",
    "frown",
    "asymp",
    "doteq",
    "ll",
    "gg",
    "prec",
    "succ",
    "preceq",
    "succeq",
    "nmid",
    "diamond",
    "ominus",
    "oslash",
    "bigodot",
    "bigotimes",
    "biguplus",
    "bigsqcup",
    "bigvee",
    "bigwedge",
    "sqcup",
    "sqcap",
    "sqsupseteq",
    "uplus",
    "amalg",
    "lhd",
    "rhd",
    "unlhd",
    "unrhd",
    "varkappa",
    "digamma",
    "beth",
    "gimel",
    "daleth",
    "ulcorner",
    "urcorner",
    "llcorner",
    "lrcorner",
    "prime",
    "angle",
    "perp",
    "parallel",
    "mid",
    "circ",
    "bullet",
    "star",
    "ast",
    "oplus",
    "otimes",
    "odot",
    "mathrm",
    "mathbf",
    "mathit",
    "mathsf",
    "mathtt",
    "mathcal",
    "mathbb",
    "mathfrak",
    "mathscr",
    "boldsymbol",
    "operatorname",
    "left",
    "right",
    "bigl",
    "bigr",
    "Bigl",
    "Bigr",
    "biggl",
    "biggr",
    "Biggl",
    "Biggr",
    "big",
    "Big",
    "bigg",
    "Bigg",
    "langle",
    "rangle",
    "lfloor",
    "rfloor",
    "lceil",
    "rceil",
    "vert",
    "Vert",
    "|",
    "{",
    "}",
    "lbrace",
    "rbrace",
    "backslash",
    "hat",
    "bar",
    "vec",
    "tilde",
    "dot",
    "ddot",
    "overline",
    "underline",
    "widehat",
    "widetilde",
    "overrightarrow",
    "overleftarrow",
    "acute",
    "grave",
    "breve",
    "check",
    "binom",
    "dbinom",
    "tbinom",
    "choose",
    "over",
    "atop",
    "stackrel",
    "overset",
    "underset",
    "substack",
    "lvert",
    "rvert",
    "lVert",
    "rVert",
    "overbrace",
    "underbrace",
    "xrightarrow",
    "xleftarrow",
    "iiint",
    "bigcup",
    "bigcap",
    "bigoplus",
    "coprod",
    "implies",
    "impliedby",
    "iff",
    "pmod",
    "bmod",
    "mod",
    "dotsc",
    "dotsb",
    "cfrac",
    "subsetneq",
    "supsetneq",
    "sqsubseteq",
    "triangleq",
    "coloneqq",
    "checkmark",
    "operatorname*",
    "sin",
    "cos",
    "tan",
    "cot",
    "sec",
    "csc",
    "arcsin",
    "arccos",
    "arctan",
    "sinh",
    "cosh",
    "tanh",
    "log",
    "ln",
    "lg",
    "exp",
    "min",
    "max",
    "sup",
    "inf",
    "arg",
    "det",
    "dim",
    "deg",
    "gcd",
    "hom",
    "ker",
    "Pr",
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "varepsilon",
    "zeta",
    "eta",
    "theta",
    "vartheta",
    "iota",
    "kappa",
    "lambda",
    "mu",
    "nu",
    "xi",
    "pi",
    "varpi",
    "rho",
    "varrho",
    "sigma",
    "varsigma",
    "tau",
    "upsilon",
    "phi",
    "varphi",
    "chi",
    "psi",
    "omega",
    "Gamma",
    "Delta",
    "Theta",
    "Lambda",
    "Xi",
    "Pi",
    "Sigma",
    "Upsilon",
    "Phi",
    "Psi",
    "Omega",
    "ell",
    "hbar",
    "imath",
    "jmath",
    "aleph",
    "Re",
    "Im",
    "wp",
    "top",
    "bot",
    "dagger",
    "ddagger",
    "colon",
    "quad",
    "qquad",
    ",",
    ";",
    ":",
    "!",
    " ",
    "displaystyle",
    "textstyle",
    "scriptstyle",
    "scriptscriptstyle",
    "limits",
    "nolimits",
    "not",
    "phantom",
    "hphantom",
    "vphantom",
    "label",
    "%",
    "$",
    "#",
    "&",
    "_",
    "\\",
    "nonumber",
    "notag",
    "tag",
    "tag*",
    "intertext",
    "eqref",
    "ref",
    "qquad",
    "hspace",
    "hfill",
    "quad",
    "left.",
    "right.",
    "mathop",
    "mathbin",
    "mathrel",
    "mathord",
    "mathpunct",
    "mathinner",
    "mathopen",
    "mathclose",
    "allowbreak",
    "textcolor",
    "color",
];

/// Patterns that make a unit background-only regardless of allow-lists.
const HARD_STOPS: &[(&str, Reason)] = &[];

/// Macros provided by a package: allowed when the package is loaded, `NeedsPackage` otherwise.
/// The document class counts as a package of its name.
const PKG_MACROS: &[(&str, &[&str])] = &[
    // list label setup, local to the list
    ("IEEEtran", &["IEEEsetlabelwidth", "IEEEusemathlabelsep"]),
    (
        "hyperref",
        &[
            "href",
            "url",
            "autoref",
            "nameref",
            "hyperref",
            "phantomsection",
            "texorpdfstring",
        ],
    ),
    ("caption", &["captionof", "captionof*"]),
    (
        "graphicx",
        &[
            "scalebox",
            "rotatebox",
            "resizebox",
            "resizebox*",
            "reflectbox",
        ],
    ),
    ("xspace", &["xspace"]),
    ("nicefrac", &["nicefrac"]),
    ("units", &["nicefrac"]),
    ("mhchem", &["ce"]),
    ("csquotes", &["enquote", "textquote", "foreignquote"]),
    ("pifont", &["ding"]),
    ("subfig", &["subfloat"]),
    (
        "biblatex",
        &[
            "parencite",
            "textcite",
            "autocite",
            "footcite",
            "citeauthor",
            "citetitle",
            "citeyear",
            "citedate",
            "Parencite",
            "Textcite",
            "Autocite",
            "Citeauthor",
            "smartcite",
            "supercite",
            "fullcite",
            "footfullcite",
            "nocite",
        ],
    ),
    (
        "natbib",
        &[
            "citep",
            "citet",
            "citealp",
            "citealt",
            "citeauthor",
            "citeyear",
            "citeyearpar",
            "citenum",
            "Citep",
            "Citet",
            "citetext",
        ],
    ),
    (
        "siunitx",
        &[
            "SI", "si", "num", "SIrange", "numrange", "qty", "unit", "ang", "qtyrange", "numlist",
            "qtylist",
        ],
    ),
    (
        "ulem",
        &[
            "sout",
            "uline",
            "uwave",
            "xout",
            "dashuline",
            "dotuline",
            "uuline",
        ],
    ),
    ("soul", &["hl", "so", "ul", "st", "caps"]),
    ("listings", &["lstinline"]),
    ("multirow", &["multirow"]),
    (
        "colortbl",
        &["rowcolor", "cellcolor", "rowcolors", "arrayrulecolor"],
    ),
    ("cancel", &["cancel", "bcancel", "xcancel", "cancelto"]),
    ("bm", &["bm"]),
    (
        "amssymb",
        &[
            "mathbb",
            "checkmark",
            "square",
            "blacksquare",
            "lesssim",
            "gtrsim",
            "nexists",
            "varnothing",
            "therefore",
            "because",
        ],
    ),
];

/// Commands that set up the document rather than typeset: a body span made only of them (and
/// their arguments) is loaded with the preamble by the fast server, so macros defined after
/// `\begin{document}` and global settings (`\renewcommand{\arraystretch}`) reach the fast path.
pub const SETUP_MACROS: &[&str] = &[
    "newcommand",
    "renewcommand",
    "providecommand",
    "newenvironment",
    "renewenvironment",
    "def",
    "edef",
    "gdef",
    "let",
    "newif",
    "newlength",
    "newcounter",
    "newtheorem",
    "theoremstyle",
    "DeclareMathOperator",
    "newcolumntype",
    "setlength",
    "addtolength",
    "linespread",
    "setstretch",
    "selectfont",
    "pagestyle",
    "pagenumbering",
    "graphicspath",
    "lstset",
    "captionsetup",
    "hypersetup",
    "setlist",
    "definecolor",
    "colorlet",
    "numberwithin",
    "allowdisplaybreaks",
    "raggedbottom",
    "flushbottom",
    "sloppy",
    "fussy",
    "bibliographystyle",
    "frenchspacing",
    "nonfrenchspacing",
    "sisetup",
    "fancyhf",
    "fancyhead",
    "fancyfoot",
    "lhead",
    "chead",
    "rhead",
    "lfoot",
    "cfoot",
    "rfoot",
    "setmainfont",
    "setsansfont",
    "setmonofont",
    "setmathfont",
    "newfontfamily",
    "DeclareRobustCommand",
    "NewDocumentCommand",
    "RenewDocumentCommand",
    "ProvideDocumentCommand",
    "NewDocumentEnvironment",
    "RenewDocumentEnvironment",
];

/// `Some(text)` when `text` (comments stripped) consists only of setup statements: each
/// statement a `SETUP_MACROS` command with its arguments (`*`, `[…]`, `{…}`, control-sequence
/// and `#n` parameters, `=`).
pub fn setup_statements(text: &str) -> Option<String> {
    let (end, any) = setup_prefix(text);
    if any && text[end..].trim().is_empty() {
        Some(text.trim().to_string())
    } else {
        None
    }
}

/// The leading run of setup statements of `text`: the offset where the first other content
/// starts (the text's length when it is setup statements only) and whether there was any.
pub fn setup_prefix(text: &str) -> (usize, bool) {
    let b = text.as_bytes();
    let mut i = 0;
    let mut any = false;
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let stmt = i; // start of the statement being scanned
        if b[i] != b'\\' {
            return (stmt, any);
        }
        let mut j = i + 1;
        while j < b.len() && is_letter(b[j]) {
            j += 1;
        }
        if j == i + 1 || !SETUP_MACROS.contains(&&text[i + 1..j]) {
            return (stmt, any);
        }
        i = j;
        // arguments
        loop {
            while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
                i += 1;
            }
            if i >= b.len() {
                break;
            }
            match b[i] {
                b'*' | b'=' => i += 1,
                b'[' => match text[i..].find(']') {
                    Some(k) => i += k + 1,
                    None => return (stmt, any),
                },
                b'{' => {
                    let mut depth = 0i32;
                    let mut k = i;
                    let mut closed = None;
                    while k < b.len() {
                        match b[k] {
                            b'\\' => k += 1,
                            b'{' => depth += 1,
                            b'}' => {
                                depth -= 1;
                                if depth == 0 {
                                    closed = Some(k);
                                    break;
                                }
                            }
                            _ => {}
                        }
                        k += 1;
                    }
                    let Some(c) = closed else {
                        return (stmt, any);
                    };
                    i = c + 1;
                }
                b'#' => {
                    i += 1;
                    while i < b.len() && b[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                b'\\' => {
                    // a control-sequence argument (\def\foo, \setlength\parindent); a setup
                    // command starts the next statement instead
                    let mut k = i + 1;
                    while k < b.len() && is_letter(b[k]) {
                        k += 1;
                    }
                    if k == i + 1 {
                        k += 1; // control symbol
                    } else if SETUP_MACROS.contains(&&text[i + 1..k]) {
                        break;
                    }
                    i = k;
                }
                b'\n' => break,
                _ => return (stmt, any),
            }
        }
        any = true;
    }
    (text.len(), any)
}

/// Is `name` a package macro? `Some(Ok(()))` when one of the packages providing it is loaded,
/// `Some(Err(first provider))` when none is, `None` for macros no package list names.
fn package_macro(name: &str, policy: &Policy) -> Option<Result<(), &'static str>> {
    let mut first: Option<&'static str> = None;
    for (pkg, ms) in PKG_MACROS {
        if ms.contains(&name) {
            if policy.has_package(pkg) {
                return Some(Ok(()));
            }
            first.get_or_insert(pkg);
        }
    }
    first.map(Err)
}

/// Picture environments (`piccache::PICTURE_ENVS`): block units when they start the unit,
/// inline boxes after text, in either case with vocabulary the allow-list does not cover.
use crate::piccache::PICTURE_ENVS;

/// Macros whose argument(s) are opaque (URLs, units, verbatim): skipped, not classified.
/// (name, brace arguments to skip; 0 = delimited like \verb|…|).
const OPAQUE_ARGS: &[(&str, usize)] = &[
    ("ce", 1),
    ("url", 1),
    ("href", 1),
    ("nolinkurl", 1),
    ("path", 1),
    ("SI", 2),
    ("si", 1),
    ("num", 1),
    ("SIrange", 3),
    ("numrange", 2),
    ("qty", 2),
    ("unit", 1),
    ("ang", 1),
    ("qtyrange", 3),
    ("numlist", 1),
    ("qtylist", 2),
    ("verb", 0),
    ("verb*", 0),
    ("lstinline", 0),
];

const URL_MACROS: &[&str] = &["url", "href", "nolinkurl", "path"];

/// Environments whose body is opaque (verbatim material): skipped to `\end{name}`.
const OPAQUE_ENVS: &[&str] = &["verbatim", "verbatim*", "lstlisting", "Verbatim", "alltt"];

/// Settings that are fine inside a group or environment (local), not at a unit's top level,
/// where they would change the document state the next units are typeset in.
const GROUP_ONLY_SETTERS: &[&str] = &[
    "setlength",
    "addtolength",
    "setstretch",
    "linespread",
    "fontsize",
];

/// Block environments that form units (or end a paragraph unit) and may nest.
pub use crate::document::BLOCK_ENVS;
pub const FLOAT_ENVS: &[&str] = &["figure", "figure*", "table", "table*"];
/// Display-math environments (inside paragraph units).
pub const DISPLAY_ENVS: &[&str] = &[
    "equation",
    "equation*",
    "displaymath",
    "eqnarray",
    "eqnarray*",
];
pub const AMSMATH_DISPLAY_ENVS: &[&str] = &[
    "align",
    "align*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "flalign",
    "flalign*",
    "alignat",
    "alignat*",
];
/// Environments allowed inside units (not units themselves).
const INNER_ENVS: &[&str] = &[
    "tabular",
    "tabular*",
    "tabularx",
    "minipage",
    "subfigure",
    "subtable",
    "math",
    "em",
    "small",
    "footnotesize",
    "scriptsize",
    "large",
    "Large",
    "bfseries",
    "itshape",
    "sloppypar",
];
const AMSMATH_INNER_ENVS: &[&str] = &[
    "split",
    "aligned",
    "gathered",
    "cases",
    "pmatrix",
    "bmatrix",
    "vmatrix",
    "Vmatrix",
    "matrix",
    "smallmatrix",
    "array",
    "subarray",
];
const LIST_ENVS: &[&str] = &["itemize", "enumerate", "description", "IEEEdescription"];
const TABULAR_MACROS: &[&str] = &["hline", "cline", "multicolumn", "multirow"];
const BOOKTABS_MACROS: &[&str] = &[
    "toprule",
    "midrule",
    "bottomrule",
    "cmidrule",
    "addlinespace",
    "specialrule",
];
const FLOAT_MACROS: &[&str] = &["caption", "caption*"];
const HEADINGS: &[&str] = &[
    "part",
    "chapter",
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
];

#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// Extra text-mode macros the host vouches for (pure, no global side effects).
    pub trusted_macros: BTreeSet<String>,
    /// Preamble aliases whose checked bodies have no semantic keys or page/state effects.
    pub semantic_pure_macros: BTreeSet<String>,
    /// Theorem-like environments (from `\newtheorem` in the preamble or the host) treated as units.
    pub theorem_envs: BTreeSet<String>,
    pub amsmath: bool,
    pub graphicx: bool,
    pub booktabs: bool,
    pub tabularx: bool,
    /// `\cite` is replayable from the aux (plain or natbib `\bibcite`); false with biblatex.
    pub cite_ok: bool,
    /// Packages loaded by the preamble (`\usepackage`/`\RequirePackage`, options resolved for
    /// `xcolor[table]` → colortbl).
    pub packages: BTreeSet<String>,
    /// Math-mode macros defined in the preamble whose bodies are allow-listed (`\newcommand{\R}{\mathbb{R}}`).
    pub trusted_math: BTreeSet<String>,
    /// Research mode: unknown macros, environments and missing packages do not make a unit
    /// ineligible (structural reasons still do); the fast result is validated against the layout
    /// instead (`rtex verify --permissive`).
    pub permissive: bool,
    /// User macros whose body starts with a heading command (`\newcommand{\unnumberedsection}[1]{\section*{#1}…}`):
    /// macro name → heading name. A span starting with one has that heading's shape.
    pub heading_macros: BTreeMap<String, String>,
    /// Environments defined in the preamble (`\newenvironment`) whose begin/end code is
    /// allow-listed text (font switches, `\noindent`, a label): typeset inside the paragraph
    /// they wrap. Ones whose code opens a block environment are in `theorem_envs` instead.
    pub user_inner_envs: BTreeSet<String>,
    /// User environment bodies not established to be free of semantic state/key effects.
    pub semantic_unverified_envs: BTreeSet<String>,
    /// Argument-free environments whose definitions only set local color/font declarations
    /// and whitespace handling. Their complete source stays intact, but a wrapped block
    /// retains its own shape for matching the capture. They still require a fidelity probe.
    pub transparent_envs: BTreeSet<String>,
    /// Lists the preamble defines with enumitem's `\newlist`, besides `itemize`, `enumerate`
    /// and `description` (their options are checked for `resume`/`series`).
    pub list_envs: BTreeSet<String>,
}

impl Policy {
    /// Derive package facts and theorem environments from the document preamble.
    pub fn from_preamble(preamble: &str, trusted: &[String], unit_envs: &[String]) -> Policy {
        let text = strip_comments(preamble);
        let has_pkg = |name: &str| -> bool {
            let mut idx = 0;
            while let Some(p) = text[idx..].find("\\usepackage") {
                let s = idx + p;
                let rest = &text[s..];
                let end = rest.find('\n').map(|e| s + e).unwrap_or(text.len());
                // the braced list may follow an optional argument
                if let Some(bo) = text[s..end.max(s)].find('{') {
                    if let Some(bc) = text[s + bo..].find('}') {
                        if text[s + bo + 1..s + bo + bc]
                            .split(',')
                            .any(|n| n.trim() == name)
                        {
                            return true;
                        }
                    }
                }
                idx = s + 11;
            }
            text.contains(&format!("\\RequirePackage{{{name}}}"))
        };
        let mut theorem_envs = BTreeSet::new();
        let mut idx = 0;
        while let Some(p) = text[idx..].find("\\newtheorem") {
            let s = idx + p + "\\newtheorem".len();
            let rest = &text[s..];
            let rest = rest.strip_prefix('*').unwrap_or(rest);
            if let Some(b) = rest.strip_prefix('{') {
                if let Some(e) = b.find('}') {
                    theorem_envs.insert(b[..e].trim().to_string());
                }
            }
            idx = s;
        }
        for e in unit_envs {
            theorem_envs.insert(e.clone());
        }
        let mut list_envs = BTreeSet::new();
        let mut idx = 0;
        while let Some(p) = text[idx..].find("\\newlist") {
            let s = idx + p + "\\newlist".len();
            if let Some(b) = text[s..].trim_start().strip_prefix('{') {
                if let Some(e) = b.find('}') {
                    list_envs.insert(b[..e].trim().to_string());
                }
            }
            idx = s;
        }
        let mut packages = BTreeSet::new();
        for (opts, names) in usepackages(&text) {
            for n in names {
                packages.insert(n.clone());
                if n == "xcolor" && opts.iter().any(|o| o == "table") {
                    packages.insert("colortbl".into());
                }
                if n == "hyperref" {
                    packages.insert("url".into());
                }
                if n == "mathtools" {
                    packages.insert("amsmath".into());
                }
                // \mathbb and the AMS symbols also come with amsfonts and unicode-math
                if n == "amsfonts" || n == "unicode-math" {
                    packages.insert("amssymb".into());
                }
            }
        }
        let mut policy = Policy {
            trusted_macros: trusted.iter().cloned().collect(),
            semantic_pure_macros: BTreeSet::new(),
            theorem_envs,
            amsmath: has_pkg("amsmath") || has_pkg("mathtools"),
            graphicx: has_pkg("graphicx") || has_pkg("graphics"),
            booktabs: has_pkg("booktabs"),
            tabularx: has_pkg("tabularx"),
            cite_ok: true,
            packages,
            trusted_math: BTreeSet::new(),
            permissive: false,
            heading_macros: BTreeMap::new(),
            user_inner_envs: BTreeSet::new(),
            semantic_unverified_envs: BTreeSet::new(),
            transparent_envs: BTreeSet::new(),
            list_envs,
        };
        // Macros defined in the preamble whose bodies are themselves allow-listed are trusted:
        // in text mode, in math mode, or both, depending on how the body classifies. Two rounds
        // let a macro use one defined before it.
        let defs = user_macro_definitions(&text);
        // heading wrappers: the body starts with a heading command (the rest is bookkeeping:
        // \phantomsection, \addcontentsline, \markboth); the capture sees the heading
        for (name, _, body) in &defs {
            let b = body.trim_start();
            for h in HEADINGS {
                if let Some(rest) = b.strip_prefix(&format!("\\{h}")) {
                    if rest.starts_with('*') || rest.starts_with('{') || rest.starts_with('[') {
                        policy.heading_macros.insert(name.clone(), (*h).to_string());
                    }
                }
            }
        }
        for _round in 0..2 {
            for (name, nargs, body) in &defs {
                let mut b = body.clone();
                for k in 1..=*nargs {
                    b = b.replace(&format!("#{k}"), "x");
                }
                if b.contains('#')
                    || b.contains("\\def")
                    || b.contains("\\let")
                    || b.contains("\\global")
                    || b.contains("\\gdef")
                    || b.contains("\\xdef")
                    || b.contains("\\newcommand")
                    || b.contains("\\renewcommand")
                {
                    continue;
                }
                let text = format!("x {b} x");
                let math = format!("$x {b} x$");
                let text_ok = classify_source(&text, &policy).1.is_empty();
                let math_ok = classify_source(&math, &policy).1.is_empty();
                if text_ok { policy.trusted_macros.insert(name.clone()); }
                if math_ok { policy.trusted_math.insert(name.clone()); }
                if (text_ok && !semantic_keys_changed_with("", &text, &policy))
                    || (math_ok && !semantic_keys_changed_with("", &math, &policy))
                {
                    policy.semantic_pure_macros.insert(name.clone());
                }
            }
        }
        // Environments defined in the preamble: allowed when their begin and end code is
        // allow-listed. One that opens a block environment (quote, itemize, center, a theorem)
        // is a block unit itself (the capture tags it like a theorem); otherwise it is typeset
        // inside the paragraph that uses it.
        let env_defs = user_environment_definitions(&text);
        for (name, _, _, _) in &env_defs {
            policy.semantic_unverified_envs.insert(name.clone());
        }
        for (name, nargs, begin, end) in env_defs.iter().cloned() {
            let unique = env_defs.iter().filter(|(other, _, _, _)| other == &name).count() == 1;
            if policy.transparent_envs.remove(&name) {
                policy.user_inner_envs.remove(&name);
            }
            if nargs == 0
                && !name.is_empty()
                && !policy.is_block_env(&name)
                && local_wrapper_code(&begin)
                && local_wrapper_code(&end)
            {
                if unique { policy.semantic_unverified_envs.remove(&name); }
                policy.user_inner_envs.insert(name.clone());
                policy.transparent_envs.insert(name);
                continue;
            }
            let mut b = format!("{begin} x {end}");
            for k in 1..=nargs {
                b = b.replace(&format!("#{k}"), "x");
            }
            if b.contains('#')
                || b.contains("\\def")
                || b.contains("\\let")
                || b.contains("\\global")
                || b.contains("\\gdef")
                || b.contains("\\xdef")
                || b.contains("\\newcommand")
                || b.contains("\\renewcommand")
                || name.is_empty()
            {
                continue;
            }
            let (shape, mut reasons) = classify_source(&b, &policy);
            // declarations in the begin code are local to the environment's group
            reasons.retain(|r| !matches!(r, Reason::SizeDeclarationOutsideGroup(_)));
            if !reasons.is_empty() {
                continue;
            }
            if unique && !semantic_keys_changed_with("", &b, &policy) {
                policy.semantic_unverified_envs.remove(&name);
            }
            match shape {
                UnitShape::Env(_) => {
                    policy.theorem_envs.insert(name);
                }
                UnitShape::Par => {
                    policy.user_inner_envs.insert(name);
                }
                UnitShape::Heading(_) => {}
            }
        }
        policy
    }

    pub fn has_package(&self, name: &str) -> bool {
        self.packages.contains(name)
    }

    pub fn is_block_env(&self, name: &str) -> bool {
        BLOCK_ENVS.contains(&name) || FLOAT_ENVS.contains(&name) || self.theorem_envs.contains(name)
    }
    pub fn is_display_env(&self, name: &str) -> bool {
        DISPLAY_ENVS.contains(&name) || AMSMATH_DISPLAY_ENVS.contains(&name)
    }
    /// Comma-separated extra unit environments for the capture run (`$RTEX_UNIT_ENVS`).
    pub fn unit_envs_env(&self) -> String {
        self.theorem_envs
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// Recognize only declarations that remain local to the environment's implicit group.
/// Text-producing code, assignments, argument-dependent wrappers and arbitrary macros are
/// deliberately excluded; knowing the environment's name alone never makes it transparent.
fn local_wrapper_code(code: &str) -> bool {
    let mut rest = code.trim();
    while !rest.is_empty() {
        let Some(tail) = rest.strip_prefix('\\') else {
            return false;
        };
        let n = tail.bytes().take_while(|c| c.is_ascii_alphabetic()).count();
        let (name, tail) = tail.split_at(n);
        rest = tail.trim_start();
        if name == "color" {
            if let Some(tail) = rest.strip_prefix('[') {
                let Some(end) = tail.find(']') else {
                    return false;
                };
                if tail[..end].contains(['\\', '{', '}', '#', '%']) {
                    return false;
                }
                rest = tail[end + 1..].trim_start();
            }
            let Some(tail) = rest.strip_prefix('{') else {
                return false;
            };
            let Some(end) = tail.find('}') else {
                return false;
            };
            if tail[..end].contains(['\\', '{', '#', '%']) {
                return false;
            }
            rest = tail[end + 1..].trim_start();
        } else if !matches!(
            name,
            "normalcolor"
                | "ignorespaces"
                | "ignorespacesafterend"
                | "unskip"
                | "relax"
                | "normalfont"
                | "rmfamily"
                | "sffamily"
                | "ttfamily"
                | "mdseries"
                | "bfseries"
                | "upshape"
                | "itshape"
                | "slshape"
                | "scshape"
                | "tiny"
                | "scriptsize"
                | "footnotesize"
                | "small"
                | "normalsize"
                | "large"
                | "Large"
                | "LARGE"
                | "huge"
                | "Huge"
        ) {
            return false;
        }
    }
    true
}

/// `\usepackage[opts]{a,b}` / `\RequirePackage` occurrences as (options, names), and
/// `\documentclass`: commands a class provides are allowed like a package's.
fn usepackages(text: &str) -> Vec<(Vec<String>, Vec<String>)> {
    let mut out = Vec::new();
    for key in ["\\usepackage", "\\RequirePackage", "\\documentclass"] {
        let mut idx = 0;
        while let Some(p) = text[idx..].find(key) {
            let s = idx + p + key.len();
            let rest = text[s..].trim_start();
            let mut opts = Vec::new();
            let mut r = rest;
            if let Some(after) = r.strip_prefix('[') {
                if let Some(e) = after.find(']') {
                    opts = after[..e]
                        .split(',')
                        .map(|o| o.split('=').next().unwrap_or("").trim().to_string())
                        .collect();
                    r = after[e + 1..].trim_start();
                }
            }
            if let Some(after) = r.strip_prefix('{') {
                if let Some(e) = after.find('}') {
                    let names = after[..e]
                        .split(',')
                        .map(|n| n.trim().to_string())
                        .filter(|n| !n.is_empty())
                        .collect();
                    out.push((opts, names));
                }
            }
            idx = s;
        }
    }
    out
}

/// Simple macro definitions in the preamble: `\newcommand{\name}[n]{body}` (also `*`,
/// `\renewcommand`, `\providecommand`, an optional default argument), `\DeclareMathOperator`
/// and parameterless `\def\name{body}`. Returns (name, argument count, body).
/// `\newenvironment{name}[n][default]{begin}{end}` / `\renewenvironment` in `text`:
/// (name, argument count, begin code, end code).
fn user_environment_definitions(text: &str) -> Vec<(String, usize, String, String)> {
    fn balanced(text: &str, open_at: usize) -> Option<usize> {
        let b = text.as_bytes();
        if b.get(open_at) != Some(&b'{') {
            return None;
        }
        let mut depth = 0i32;
        let mut i = open_at;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 1,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }
    let mut out = Vec::new();
    let b = text.as_bytes();
    for key in ["\\newenvironment", "\\renewenvironment"] {
        let mut idx = 0;
        while let Some(p) = text[idx..].find(key) {
            let mut i = idx + p + key.len();
            idx = i;
            if i < b.len() && b[i] == b'*' {
                i += 1;
            }
            while i < b.len() && b[i] == b' ' {
                i += 1;
            }
            let Some(e) = balanced(text, i) else { continue };
            let name = text[i + 1..e].trim().to_string();
            i = e + 1;
            let mut nargs = 0usize;
            let mut has_default = false;
            for round in 0..2 {
                while i < b.len() && (b[i] == b' ' || b[i] == b'\n') {
                    i += 1;
                }
                if i < b.len() && b[i] == b'[' {
                    if let Some(k) = text[i..].find(']') {
                        if round == 0 {
                            nargs = text[i + 1..i + k].trim().parse().unwrap_or(0);
                        } else {
                            has_default = true;
                        }
                        i += k + 1;
                    }
                }
            }
            while i < b.len() && (b[i] == b' ' || b[i] == b'\n') {
                i += 1;
            }
            let Some(e1) = balanced(text, i) else {
                continue;
            };
            let begin = text[i + 1..e1].to_string();
            i = e1 + 1;
            while i < b.len() && (b[i] == b' ' || b[i] == b'\n') {
                i += 1;
            }
            let Some(e2) = balanced(text, i) else {
                continue;
            };
            let end = text[i + 1..e2].to_string();
            out.push((name, nargs.max(if has_default { 1 } else { 0 }), begin, end));
        }
    }
    out
}

fn user_macro_definitions(text: &str) -> Vec<(String, usize, String)> {
    fn balanced(text: &str, open_at: usize) -> Option<usize> {
        let b = text.as_bytes();
        if b.get(open_at) != Some(&b'{') {
            return None;
        }
        let mut depth = 0i32;
        let mut i = open_at;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 1,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }
    let mut out = Vec::new();
    let b = text.as_bytes();
    for key in [
        "\\newcommand",
        "\\renewcommand",
        "\\providecommand",
        "\\DeclareMathOperator",
        "\\def",
    ] {
        let mut idx = 0;
        while let Some(p) = text[idx..].find(key) {
            let mut i = idx + p + key.len();
            idx = i;
            if i < b.len() && b[i] == b'*' {
                i += 1;
            }
            // control sequence, braced or bare
            while i < b.len() && b[i] == b' ' {
                i += 1;
            }
            let braced = i < b.len() && b[i] == b'{';
            if braced {
                i += 1;
            }
            if i >= b.len() || b[i] != b'\\' {
                continue;
            }
            let mut j = i + 1;
            while j < b.len() && (b[j] as char).is_ascii_alphabetic() {
                j += 1;
            }
            if j == i + 1 {
                continue;
            }
            let name = text[i + 1..j].to_string();
            i = j;
            if braced {
                if i < b.len() && b[i] == b'}' {
                    i += 1;
                } else {
                    continue;
                }
            }
            if key == "\\DeclareMathOperator" {
                out.push((name, 0, "\\operatorname{x}".to_string()));
                continue;
            }
            if key == "\\def" {
                // only the parameterless form
                if i < b.len() && b[i] == b'{' {
                    if let Some(e) = balanced(text, i) {
                        out.push((name, 0, text[i + 1..e].to_string()));
                    }
                }
                continue;
            }
            let mut nargs = 0usize;
            let mut has_default = false;
            for _ in 0..2 {
                if i < b.len() && b[i] == b'[' {
                    if let Some(e) = text[i..].find(']') {
                        let inner = text[i + 1..i + e].trim();
                        if nargs == 0 && !has_default {
                            nargs = inner.parse().unwrap_or(0);
                        } else {
                            has_default = true;
                        }
                        if nargs == 0 && !has_default {
                            has_default = true;
                        }
                        i += e + 1;
                    }
                }
            }
            if i < b.len() && b[i] == b'{' {
                if let Some(e) = balanced(text, i) {
                    out.push((
                        name,
                        nargs.max(if has_default { 1 } else { 0 }),
                        text[i + 1..e].to_string(),
                    ));
                }
            }
        }
    }
    out
}

/// Strip `%` comments (respecting `\%`). Like TeX, a comment also removes the end of its
/// line, so comment-only lines inside a paragraph do not leave a blank line behind.
pub fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let b = src.as_bytes();
    let (mut i, mut copied) = (0, 0);
    while i < b.len() {
        if b[i] == b'\\' {
            let start = i + 1;
            i = start;
            while i < b.len() && is_letter(b[i]) {
                i += 1;
            }
            let name = &src[start..i];
            if name == "begin" {
                if let Some((env, after)) = env_name(src, start - 1, "\\begin") {
                    if OPAQUE_ENVS.contains(&env.as_str()) {
                        let end = format!("\\end{{{env}}}");
                        i = src[after..].find(&end).map_or(src.len(), |n| after + n + end.len());
                    }
                }
            } else if URL_MACROS.contains(&name) || matches!(name, "verb" | "lstinline") {
                if name == "verb" && b.get(i) == Some(&b'*') { i += 1; }
                // URL and verbatim percent signs are data, including while their argument is open.
                i = literal_argument_end(src, i, name).unwrap_or_else(|| {
                    if src[i..].trim_start().starts_with('}') {
                        i // A surrounding macro may discard this command without reading an argument.
                    } else if name == "verb" || name == "lstinline" {
                        src[i..].find('\n').map_or(src.len(), |n| i + n)
                    } else { src.len() }
                });
            } else if i == start && i < b.len() {
                i += src[i..].chars().next().unwrap().len_utf8();
            }
            continue;
        }
        if b[i] == b'%' {
            out.push_str(&src[copied..i]);
            i = src[i..].find('\n').map_or(src.len(), |n| i + n + 1);
            copied = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&src[copied..]);
    if copied < src.len() && !src.ends_with('\n') { out.push('\n'); }
    out
}

/// End-exclusive brace group; escaped braces do not change its depth.
fn braced_end(text: &str, from: usize) -> Option<usize> {
    let b = text.as_bytes();
    if b.get(from) != Some(&b'{') { return None; }
    let (mut i, mut depth) = (from, 0);
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 { return Some(i + 1); }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The literal argument of a URL or verbatim command, using whole Unicode delimiters.
fn literal_argument_end(text: &str, from: usize, name: &str) -> Option<usize> {
    let mut at = from;
    if name != "verb" {
        at = text.len() - text[at..].trim_start().len();
        if matches!(name, "href" | "lstinline") && text[at..].starts_with('[') {
            at += optional_arg(&text[at..])?.len() + 2;
            at = text.len() - text[at..].trim_start().len();
        }
    }
    let delim = text[at..].chars().next()?;
    if delim.is_whitespace() { return None; }
    if delim == '{' && name != "verb" { return braced_end(text, at); }
    if name == "href" { return None; }
    let start = at + delim.len_utf8();
    let end = text[start..].find(delim)?;
    if name == "verb" && text[start..start + end].contains('\n') { return None; }
    Some(start + end + delim.len_utf8())
}

fn is_letter(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'@'
}

/// Parse `\begin{name}` / `\end{name}` at `text[i..]` (i at the backslash); returns (name, index after `}`).
fn env_name(text: &str, i: usize, what: &str) -> Option<(String, usize)> {
    let rest = &text[i..];
    let rest2 = rest.strip_prefix(what)?;
    let rest3 = rest2.trim_start();
    let body = rest3.strip_prefix('{')?;
    let e = body.find('}')?;
    let name = body[..e].trim().to_string();
    let consumed = rest.len() - body.len() + e + 1;
    Some((name, i + consumed))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Text,
    Math,
}

/// What opened a math frame. A closing delimiter must match it: TeX's recovery from a
/// mismatched pair (`\[ a $`, `\begin{align} a \]`) can leave a group open, which the live
/// server only notices at the end of the compile, so the pair is not balanced for the scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Delim {
    /// Text groups, environments (closed by their own `\end`) and the outer frame.
    None,
    /// `$`
    Dollar,
    /// `$$`
    DoubleDollar,
    /// `\(`
    Paren,
    /// `\[`
    Bracket,
}

struct Frame {
    mode: Mode,
    env: Option<String>,
    depth_at_entry: i32,
    delim: Delim,
}

/// The position after the `\end{env}` that closes an environment whose body starts at `from`
/// (`\begin{env}` already consumed), counting nested environments of the same name. None when
/// the environment is not closed.
fn skip_env_body(text: &str, from: usize, env: &str) -> Option<usize> {
    let begin = format!("\\begin{{{env}}}");
    let end = format!("\\end{{{env}}}");
    let mut depth = 1usize;
    let mut i = from;
    loop {
        let e = text[i..].find(&end)?;
        let b = text[i..].find(&begin);
        match b {
            Some(b) if b < e => {
                depth += 1;
                i += b + begin.len();
            }
            _ => {
                depth -= 1;
                i += e + end.len();
                if depth == 0 {
                    return Some(i);
                }
            }
        }
    }
}

/// Lexical check of a unit's source. Returns its shape and the (possibly empty) list of reasons.
/// Reasons about the unit's vocabulary (what the allow-list knows), as opposed to its structure.
/// In probe mode these do not decide eligibility: the fast result is compared with the layout.
pub fn is_vocabulary_reason(r: &Reason) -> bool {
    matches!(
        r,
        Reason::DisallowedMacro(_)
            | Reason::DisallowedMathMacro(_)
            | Reason::DisallowedEnvironment(_)
            | Reason::NeedsPackage(_)
            | Reason::MacroOutsideContext(_)
            | Reason::SizeDeclarationOutsideGroup(_)
            | Reason::LeadingCounter(_)
            | Reason::Verbatim
    )
}

/// Compare cross-unit keys and explicit page effects using the eligibility scanner's
/// command boundaries and opaque-body rules. Unknown or unfinished syntax proves no equality.
pub fn semantic_keys_changed(before: &str, after: &str) -> bool {
    semantic_keys_changed_with(before, after, &Policy::default())
}

/// Use the active preamble facts so known wrappers do not become unknown side effects.
pub fn semantic_keys_changed_with(before: &str, after: &str, policy: &Policy) -> bool {
    if before == after { return false; }
    // Only checked pure bodies can carry eligibility trust into semantic comparison.
    let mut semantic_policy = policy.clone();
    semantic_policy.trusted_macros.retain(|name| policy.semantic_pure_macros.contains(name));
    semantic_policy.trusted_math.retain(|name| policy.semantic_pure_macros.contains(name));
    semantic_policy.heading_macros.clear();
    let ((_, old_reasons), old) = source_evidence(before, &semantic_policy, false);
    let ((_, new_reasons), new) = source_evidence(after, &semantic_policy, false);
    // Literal math cannot hide a numbered environment or a command with external effects.
    let literal_math = !before.contains('\\') && !after.contains('\\');
    old.keys != new.keys || ((old.uncertain || new.uncertain
        || old_reasons.iter().chain(&new_reasons).any(|reason| reason.is_unfinished()
            && !(literal_math && matches!(reason, Reason::IncompleteMath | Reason::UnbalancedMath))))
        && strip_comments(before) != strip_comments(after))
}

/// Existing probe-verified vocabulary remains usable; only a new refusal needs a new probe.
/// Force full classification even when the session permits unknown vocabulary.
pub fn new_unverified_vocabulary(before: &str, after: &str, policy: &Policy) -> bool {
    let (_, old) = source_evidence(before, policy, false);
    let (_, new) = source_evidence(after, policy, false);
    new.vocabulary.iter().any(|entry| !old.vocabulary.contains(entry))
}

#[derive(Default)]
struct SemanticEvidence {
    keys: Vec<(String, Vec<String>)>,
    vocabulary: Vec<(String, Reason)>,
    uncertain: bool,
}

/// Required braced arguments and optional brackets for keys or explicit page effects.
fn semantic_arguments(name: &str) -> Option<(usize, bool)> {
    if matches!(name, "label" | "ref" | "pageref" | "eqref" | "autoref" | "nameref"
        | "cref" | "Cref" | "vref" | "bibitem" | "cite" | "nocite" | "index" | "tag")
        || PKG_MACROS.iter().any(|(pkg, names)| matches!(*pkg, "biblatex" | "natbib") && names.contains(&name))
    {
        Some((1, true))
    } else if matches!(name, "newlabel" | "bibcite" | "setcounter" | "addtocounter") {
        Some((2, false))
    } else if matches!(name, "stepcounter" | "refstepcounter" | "enlargethispage" | "vspace"
        | "addvspace" | "needspace" | "Needspace" | "thispagestyle" | "pagenumbering")
    {
        Some((1, false))
    } else if matches!(name, "newpage" | "clearpage" | "cleardoublepage" | "pagebreak"
        | "nopagebreak" | "vfill" | "vfil" | "samepage" | "smallskip" | "medskip"
        | "bigskip" | "smallbreak" | "medbreak" | "bigbreak")
    {
        Some((0, true))
    } else { None }
}

/// Headings the standard classes set run-in, recognised by name in the source (a heading the
/// layout has not seen yet). Other classes' run-in headings are recognised from the capture
/// (`check_engine_unit`).
const RUN_IN_HEADINGS: &[&str] = &["paragraph", "subparagraph"];

pub fn classify_source(src: &str, policy: &Policy) -> (UnitShape, Vec<Reason>) {
    classify_source_with(src, policy, policy.permissive)
}

/// `classify_source` with the permissive flag given explicitly (`false`: every reason,
/// vocabulary included).
pub fn classify_source_with(
    src: &str,
    policy: &Policy,
    permissive: bool,
) -> (UnitShape, Vec<Reason>) {
    source_evidence(src, policy, permissive).0
}

fn source_evidence(
    src: &str,
    policy: &Policy,
    permissive: bool,
) -> ((UnitShape, Vec<Reason>), SemanticEvidence) {
    let text = strip_comments(src);
    if text.trim().is_empty() {
        return ((UnitShape::Par, vec![Reason::Blank]), SemanticEvidence::default());
    }
    if setup_statements(&text).is_some() {
        return ((UnitShape::Par, vec![Reason::SetupStatement]),
            SemanticEvidence { uncertain: true, ..Default::default() });
    }
    let (shape, heading_base) = unit_shape(&text, policy);
    let run_in = match &shape {
        UnitShape::Heading(h) if RUN_IN_HEADINGS.contains(&h.as_str()) => Some(h.clone()),
        _ => None,
    };
    let mut scan = Scan {
        text: &text,
        b: text.as_bytes(),
        policy,
        shape,
        heading_base,
        reasons: Vec::new(),
        i: 0,
        depth: 0,
        stack: vec![Frame {
            mode: Mode::Text,
            env: None,
            depth_at_entry: 0,
            delim: Delim::None,
        }],
        env_depth: 0,
        block_env_closed_at: None,
        text_group_pending: false,
        frame_checks: BTreeMap::new(),
        line_start: 0,
        semantic: SemanticEvidence::default(),
        command: String::new(),
    };
    scan.hard_stops();
    scan.leading_counter();
    scan.run();
    if let Some(h) = run_in {
        scan.push(Reason::RunInHeading(h));
    }
    let semantic = std::mem::take(&mut scan.semantic);
    (scan.finish(permissive), semantic)
}

/// The optional argument `[...]` at the start of `s` (after spaces), without its brackets;
/// brackets inside braces (`label={[\arabic*]}`) do not end it.
fn optional_arg(s: &str) -> Option<&str> {
    let t = s.trim_start();
    let off = s.len() - t.len();
    if !t.starts_with('[') {
        return None;
    }
    let b = t.as_bytes();
    let mut depth = 0i32;
    let mut i = 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b']' if depth == 0 => return Some(&s[off + 1..off + i]),
            _ => {}
        }
        i += 1;
    }
    None
}

/// `s` split at `sep` outside braces.
fn top_level_split(s: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '{' => depth += 1,
            '}' => depth -= 1,
            c if c == sep && depth == 0 => {
                out.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// The unit's shape: a block/float/theorem environment spanning the whole unit (possibly after
/// setup statements and vertical material such as \vspace or \noindent, which the unit box
/// absorbs), a heading, or a paragraph. Also returns where the unit's own heading command may
/// start (a heading macro further in is not the unit's heading).
fn unit_shape(text: &str, policy: &Policy) -> (UnitShape, usize) {
    let mut offset = setup_prefix(text).0;
    let tail = &text[offset..];
    offset += tail.len() - tail.trim_start().len();
    let mut trimmed = tail.trim();
    // A local color/font wrapper does not create a capture unit. Keep its complete source
    // for the compile, but compare the enclosed block's shape with the captured block.
    // Only peel a wrapper that closes at the very end: trailing text or a second block is
    // not silently discarded, and ambiguous capture mappings remain ineligible.
    loop {
        let start = vertical_prefix_len(trimmed);
        let Some((name, after)) = env_name(trimmed, start, "\\begin") else {
            break;
        };
        if !policy.transparent_envs.contains(&name)
            || skip_env_body(trimmed, after, &name) != Some(trimmed.len())
        {
            break;
        }
        let end = trimmed.len() - format!("\\end{{{name}}}").len();
        let inner = &trimmed[after..end];
        offset += after + inner.len() - inner.trim_start().len();
        trimmed = inner.trim();
    }
    let mut shape = UnitShape::Par;
    let env_start = vertical_prefix_len(trimmed);
    if let Some((name, _)) = env_name(trimmed, env_start, "\\begin") {
        let end = format!("\\end{{{name}}}");
        if trimmed.ends_with(&end) && policy.is_block_env(&name) {
            shape = UnitShape::Env(name);
        }
    } else if trimmed[env_start..].starts_with('\\') {
        let b = &trimmed.as_bytes()[env_start..];
        let mut j = 1;
        while j < b.len() && is_letter(b[j]) {
            j += 1;
        }
        let name = &trimmed[env_start + 1..env_start + j];
        if HEADINGS.contains(&name) {
            shape = UnitShape::Heading(name.to_string());
        } else if let Some(h) = policy.heading_macros.get(name) {
            shape = UnitShape::Heading(h.clone());
        }
    }
    (shape, env_start + offset)
}

/// The scan state of `classify_source_with`: a position in the comment-stripped source, the
/// brace depth, the open groups and environments, and the reasons found so far. One method per
/// construct; a method returning means "go on with the next character".
struct Scan<'a> {
    text: &'a str,
    b: &'a [u8],
    policy: &'a Policy,
    shape: UnitShape,
    /// Where the unit's own heading command may start (see `unit_shape`).
    heading_base: usize,
    reasons: Vec<Reason>,
    i: usize,
    depth: i32,
    stack: Vec<Frame>,
    /// Block environments open.
    env_depth: i32,
    /// Index after the last `\end{block}` at env_depth 0.
    block_env_closed_at: Option<usize>,
    /// The next brace group is text mode (`\text{...}` in math).
    text_group_pending: bool,
    /// Literal left/right pairs belong to one math frame and one brace group. An unknown
    /// macro can supply either partner, so its frame's fence check remains inconclusive.
    frame_checks: BTreeMap<usize, FrameChecks>,
    line_start: usize,
    semantic: SemanticEvidence,
    command: String,
}

#[derive(Default)]
struct FrameChecks {
    left_depths: Vec<i32>,
    broken: bool,
    missing_argument: bool,
    missing_command_argument: bool,
    uncertain: bool,
}

enum MathArgument {
    Present(usize),
    OpenGroup,
    Missing,
}

impl<'a> Scan<'a> {
    fn record_semantic(&mut self, name: &str) {
        let Some((nargs, optional)) = semantic_arguments(name) else { return; };
        let mut at = self.i;
        let mut args = Vec::new();
        // Some control words have already consumed their star; others leave it here.
        if self.b.get(at.wrapping_sub(1)) == Some(&b'*') {
            args.push("*".into());
        } else if self.b.get(at) == Some(&b'*') {
            args.push("*".into());
            at += 1;
        }
        at = self.text.len() - self.text[at..].trim_start().len();
        if optional {
            while self.b.get(at) == Some(&b'[') {
                let Some(arg) = optional_arg(&self.text[at..]) else {
                    self.semantic.uncertain = true;
                    return;
                };
                args.push(format!("[{arg}]"));
                at += arg.len() + 2;
                at = self.text.len() - self.text[at..].trim_start().len();
            }
        }
        for _ in 0..nargs {
            let Some(end) = braced_end(self.text, at) else {
                self.semantic.uncertain = true;
                return;
            };
            let arg = &self.text[at + 1..end - 1];
            if arg.contains(['\\', '#']) { self.semantic.uncertain = true; }
            args.push(arg.to_string());
            at = self.text.len() - self.text[end..].trim_start().len();
        }
        self.semantic.keys.push((name.into(), args));
    }

    fn push(&mut self, r: Reason) {
        if is_vocabulary_reason(&r) {
            let entry = (self.command.clone(), r.clone());
            if !self.semantic.vocabulary.contains(&entry) { self.semantic.vocabulary.push(entry); }
        }
        if !self.reasons.contains(&r) {
            self.reasons.push(r);
        }
    }

    fn in_math(&self) -> bool {
        self.stack
            .last()
            .map(|f| f.mode == Mode::Math)
            .unwrap_or(false)
    }

    /// Inspect one TeX argument without expanding macros: a balanced group or a single token.
    /// Closing math/group/cell tokens cannot supply a field. All other control sequences are
    /// accepted as tokens, including user macros and unbraced `\frac\alpha\beta` arguments.
    fn math_argument(&self, from: usize) -> MathArgument {
        let mut i = from;
        while i < self.b.len() && self.b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == self.b.len() || matches!(self.b[i], b'}' | b'$' | b'&') {
            return MathArgument::Missing;
        }
        if self.b[i] == b'{' {
            return braced_end(self.text, i).map_or(MathArgument::OpenGroup, MathArgument::Present);
        }
        if self.b[i] == b'\\' {
            let start = i + 1;
            if start == self.b.len() {
                return MathArgument::Missing;
            }
            if !is_letter(self.b[start]) {
                return if matches!(self.b[start], b')' | b']' | b'\\') {
                    MathArgument::Missing
                } else {
                    MathArgument::Present(
                        start + self.text[start..].chars().next().unwrap().len_utf8(),
                    )
                };
            }
            i = start;
            while i < self.b.len() && is_letter(self.b[i]) {
                i += 1;
            }
            return if matches!(&self.text[start..i], "right" | "end" | "par") {
                MathArgument::Missing
            } else {
                MathArgument::Present(i)
            };
        }
        MathArgument::Present(i + self.text[i..].chars().next().unwrap().len_utf8())
    }

    fn arguments_missing(&self, count: usize, optional: bool) -> bool {
        let mut at = self.i;
        if optional {
            let rest = self.text[at..].trim_start();
            if rest.starts_with('[') {
                if let Some(arg) = optional_arg(rest) {
                    at = self.text.len() - rest.len() + arg.len() + 2;
                } else {
                    return true;
                }
            }
        }
        for _ in 0..count {
            match self.math_argument(at) {
                MathArgument::Present(end) => at = end,
                MathArgument::OpenGroup => return false,
                MathArgument::Missing => return true,
            }
        }
        false
    }

    fn math_arguments(&mut self, count: usize, optional: bool) {
        if self.arguments_missing(count, optional) { self.incomplete_math_argument(); }
    }

    fn incomplete_command_argument(&mut self) {
        self.frame_checks.entry(self.stack.len()).or_default().missing_command_argument = true;
    }

    fn incomplete_math_argument(&mut self) {
        self.frame_checks
            .entry(self.stack.len())
            .or_default()
            .missing_argument = true;
    }

    fn math_macro(&mut self, name: &str) {
        match name {
            "left" | "right" => {
                self.math_arguments(1, false);
                let fences = self.frame_checks.entry(self.stack.len()).or_default();
                if name == "left" {
                    fences.left_depths.push(self.depth);
                } else if fences.left_depths.last() == Some(&self.depth) {
                    fences.left_depths.pop();
                } else {
                    fences.broken = true;
                }
            }
            "frac" | "dfrac" | "tfrac" | "binom" | "dbinom" | "tbinom"
                | "overset" | "underset" | "stackrel" => {
                self.math_arguments(2, false);
            }
            "cfrac" => self.math_arguments(2, true),
            "sqrt" => self.math_arguments(1, true),
            "textcolor" => self.math_arguments(2, true),
            "overline" | "underline" | "operatorname" | "mathop" | "hat" | "widehat"
                | "bar" | "vec" | "dot" | "ddot" | "tilde" | "widetilde"
                | "overbrace" | "underbrace" => self.math_arguments(1, false),
            _ if TEXT_WRAPPERS.contains(&name) => self.math_arguments(1, false),
            _ => {
                // Do not guess that `\lef` or `\fr` is an unfinished built-in: a package or
                // document macro may legitimately have that name (including in probe mode).
                if !MATH_MACROS.contains(&name)
                    && !TEXT_WRAPPERS.contains(&name)
                    && package_macro(name, self.policy).is_none()
                    && name != "middle"
                {
                    self.frame_checks
                        .entry(self.stack.len())
                        .or_default()
                        .uncertain = true;
                }
            }
        }
    }

    fn finish_frame(&mut self) {
        if let Some(fences) = self.frame_checks.remove(&self.stack.len()) {
            if !fences.uncertain && fences.missing_command_argument {
                self.push(Reason::IncompleteCommand);
            }
            if !fences.uncertain
                && (fences.broken || fences.missing_argument || !fences.left_depths.is_empty())
            {
                self.push(Reason::IncompleteMath);
            }
        }
    }

    /// Control words that stop the fast path wherever they are.
    fn hard_stops(&mut self) {
        let text = self.text;
        for (pat, r) in HARD_STOPS {
            if let Some(mut idx) = text.find(pat) {
                // must be a whole control word
                let b = text.as_bytes();
                loop {
                    let end = idx + pat.len();
                    if end >= b.len() || !is_letter(b[end]) {
                        self.push(r.clone());
                        break;
                    }
                    match text[end..].find(pat) {
                        Some(p) => idx = end + p,
                        None => break,
                    }
                }
            }
        }
    }

    /// A leading counter assignment whose argument does not close the unit.
    fn leading_counter(&mut self) {
        let text = self.text;
        {
            let t = text.trim_start();
            for m in [
                "setcounter",
                "addtocounter",
                "stepcounter",
                "refstepcounter",
            ] {
                if t.starts_with(&format!("\\{m}{{")) && !t.trim_end().ends_with('}') {
                    self.push(Reason::LeadingCounter(m.into()));
                    break;
                }
            }
        }
    }

    fn run(&mut self) {
        while self.i < self.b.len() {
            let c = self.b[self.i];
            if c == b'\n' {
                self.line_break();
                continue;
            }
            let in_math = self.in_math();
            if c == b'\\' {
                if !self.control_sequence(in_math) {
                    break;
                }
                continue;
            }
            self.character(c, in_math);
            self.i += 1;
        }
    }

    /// Blank lines are fine inside blocks and their known local color/font wrappers.
    fn line_break(&mut self) {
        let (text, b) = (self.text, self.b);
        let line = &text[self.line_start..self.i];
        if line.trim().is_empty()
            && self.i > 0
            && self.env_depth == 0
            && self.i + 1 < b.len()
            && !text[self.i + 1..].trim().is_empty()
            && self.line_start > 0
        {
            let before_first_body = matches!(self.shape, UnitShape::Heading(_))
                && crate::document::heading_title_end(&text[..self.i]).is_some_and(|end|
                    !has_content(&text[end..self.i]));
            if !before_first_body {
                self.push(Reason::ParagraphBreak);
            }
        }
        self.line_start = self.i + 1;
        self.i += 1;
    }

    /// A control sequence at `i`: math delimiters, environments, opaque arguments, macros.
    /// False at the end of the source.
    fn control_sequence(&mut self, in_math: bool) -> bool {
        let (text, b) = (self.text, self.b);
        if self.i + 1 >= b.len() {
            if in_math {
                self.incomplete_math_argument();
            }
            return false;
        }
        let n = b[self.i + 1];
        let name: String;
        if is_letter(n) {
            let mut j = self.i + 1;
            while j < b.len() && is_letter(b[j]) {
                j += 1;
            }
            name = text[self.i + 1..j].to_string();
            // `\tag*`, `\caption*`, `\hspace*`
            if j < b.len()
                && b[j] == b'*'
                && matches!(
                    name.as_str(),
                    "tag"
                        | "caption"
                        | "hspace"
                        | "vspace"
                        | "section"
                        | "subsection"
                        | "subsubsection"
                        | "chapter"
                        | "part"
                        | "paragraph"
                        | "subparagraph"
                        | "alph"
                        | "Alph"
                        | "arabic"
                        | "roman"
                        | "Roman"
                        | "operatorname"
                        | "verb"
                )
            {
                self.i = j + 1;
            } else {
                self.i = j;
            }
        } else if n == b'(' {
            if in_math {
                self.push(Reason::UnbalancedMath);
            }
            self.stack.push(Frame {
                mode: Mode::Math,
                env: None,
                depth_at_entry: self.depth,
                delim: Delim::Paren,
            });
            self.i += 2;
            return true;
        } else if n == b')' || n == b']' {
            // `\)` closes only `\(`, `\]` only `\[`, at the brace depth they opened at
            let opener = if n == b')' {
                Delim::Paren
            } else {
                Delim::Bracket
            };
            if !in_math
                || self
                    .stack
                    .last()
                    .map(|f| f.depth_at_entry != self.depth || f.delim != opener)
                    .unwrap_or(true)
            {
                self.push(Reason::UnbalancedMath);
            }
            if in_math {
                self.finish_frame();
                self.stack.pop();
            }
            self.i += 2;
            return true;
        } else if n == b'[' {
            if in_math {
                self.push(Reason::UnbalancedMath);
            }
            self.stack.push(Frame {
                mode: Mode::Math,
                env: None,
                depth_at_entry: self.depth,
                delim: Delim::Bracket,
            });
            self.i += 2;
            return true;
        } else {
            let c = text[self.i + 1..].chars().next().unwrap();
            name = c.to_string();
            self.i += 1 + c.len_utf8();
        }
        self.command = name.clone();
        self.record_semantic(&name);
        if name == "begin" {
            self.begin_environment(in_math);
            return true;
        }
        if name == "end" {
            self.end_environment();
            return true;
        }
        if in_math {
            self.math_macro(&name);
        } else {
            let (count, optional) = if TEXT_WRAPPERS.contains(&name.as_str()) {
                (1, false)
            } else if name == "textcolor" {
                (2, true)
            } else { (0, false) };
            if self.arguments_missing(count, optional) { self.incomplete_command_argument(); }
        }
        // opaque arguments (URLs, units, verbatim): skip them, check the package
        if let Some((_, nargs)) = OPAQUE_ARGS.iter().find(|(n, _)| *n == name.as_str()) {
            self.opaque_arguments(&name, *nargs);
            return true;
        }
        self.macro_word(name, in_math);
        true
    }

    fn begin_environment(&mut self, in_math: bool) {
        let (text, policy) = (self.text, self.policy);
        let begin_pos = self.i - 6;
        let Some((env, after)) = env_name(text, begin_pos, "\\begin") else {
            self.push(Reason::UnbalancedEnvironment);
            return;
        };
        self.i = after;
        self.command = format!("begin{{{env}}}");
        if policy.semantic_unverified_envs.contains(&env) { self.semantic.uncertain = true; }
        if self.block_env_closed_at.is_some() && self.env_depth == 0 {
            // a second block environment after one closed: still fine (both inside the unit)
        }
        // enumitem: `resume`, `resume*` and `series=` continue an earlier list's numbering
        let base = env.trim_end_matches('*');
        if LIST_ENVS.contains(&base) || policy.list_envs.contains(base) {
            if let Some(opts) = optional_arg(&text[after..]) {
                let keys = top_level_split(opts, ',');
                if keys.iter().any(|kv| {
                    let key = kv.split('=').next().unwrap_or("").trim();
                    matches!(key, "resume" | "resume*" | "series")
                }) {
                    self.push(Reason::OutsideState(format!("\\begin{{{env}}}[resume]")));
                }
            }
        }
        let is_amsmath_display = AMSMATH_DISPLAY_ENVS.contains(&env.as_str());
        let is_amsmath_inner = AMSMATH_INNER_ENVS.contains(&env.as_str());
        if OPAQUE_ENVS.contains(&env.as_str()) {
            // verbatim material: skip to \end{env}; the environment is a block unit
            if env == "lstlisting" && !policy.has_package("listings") {
                self.push(Reason::NeedsPackage("listings".into()));
            }
            let end = format!("\\end{{{env}}}");
            match text[self.i..].find(&end) {
                Some(e) => {
                    self.i += e + end.len();
                    if policy.is_block_env(&env) && self.env_depth == 0 {
                        self.block_env_closed_at = Some(self.i);
                    }
                }
                None => self.push(Reason::UnbalancedEnvironment),
            }
            return;
        }
        if policy.is_display_env(&env) {
            if is_amsmath_display && !policy.amsmath {
                self.push(Reason::NeedsPackage("amsmath".into()));
            }
            if in_math {
                self.push(Reason::UnbalancedMath);
            }
            self.stack.push(Frame {
                mode: Mode::Math,
                env: Some(env),
                depth_at_entry: self.depth,
                delim: Delim::None,
            });
        } else if policy.is_block_env(&env) || policy.transparent_envs.contains(&env) {
            let transparent = policy.transparent_envs.contains(&env);
            if transparent {
                // Structural transparency does not bypass the fidelity guard. The first
                // edit proves the full, unchanged wrapper source against its capture.
                self.push(Reason::DisallowedEnvironment(env.clone()));
            }
            if in_math {
                self.push(Reason::UnbalancedMath);
            }
            if self.block_env_closed_at.is_some()
                && self.env_depth == 0
                && self.shape == UnitShape::Par
                && !transparent
            {
                // text (or another environment) after a block environment: the capture
                // closes the paragraph unit at the first environment's end
                self.push(Reason::TextAfterEnvironment);
            }
            if PICTURE_ENVS.contains(&env.as_str()) {
                // a unit of its own (block), but its drawing commands are not
                // allow-listed: probe mode compiles and compares it, or takes it from
                // the picture cache. The body is the environment's business (one
                // reason, not one per drawing command): skipped to its \end.
                self.push(Reason::DisallowedEnvironment(env.clone()));
                // inside a paragraph's text it is an inline box: the paragraph goes on
                // after it (the capture keeps one unit)
                let inline = self.env_depth == 0
                    && self.shape == UnitShape::Par
                    && !text[content_start(text).min(begin_pos)..begin_pos]
                        .trim()
                        .is_empty();
                match skip_env_body(text, self.i, &env) {
                    Some(e) => {
                        // Preserve opaque effects without treating surrounding prose as picture changes.
                        self.semantic.keys.push(("picture".into(), vec![text[begin_pos..e].into()]));
                        self.i = e;
                        if self.env_depth == 0 && !inline {
                            self.block_env_closed_at = Some(self.i);
                        }
                    }
                    None => self.push(Reason::UnbalancedEnvironment),
                }
                return;
            }
            self.env_depth += 1;
            self.stack.push(Frame {
                mode: Mode::Text,
                env: Some(env),
                depth_at_entry: self.depth,
                delim: Delim::None,
            });
        } else if INNER_ENVS.contains(&env.as_str())
            || is_amsmath_inner
            || policy.user_inner_envs.contains(&env)
        {
            if is_amsmath_inner && !policy.amsmath {
                self.push(Reason::NeedsPackage("amsmath".into()));
            }
            if env == "tabularx" && !policy.tabularx {
                self.push(Reason::NeedsPackage("tabularx".into()));
            }
            let mode = if is_amsmath_inner || env == "math" {
                Mode::Math
            } else {
                Mode::Text
            };
            if env == "math" && in_math {
                self.push(Reason::UnbalancedMath);
            }
            self.stack.push(Frame {
                mode: if is_amsmath_inner { Mode::Math } else { mode },
                env: Some(env),
                depth_at_entry: self.depth,
                delim: Delim::None,
            });
        } else {
            self.semantic.uncertain = true;
            self.push(Reason::DisallowedEnvironment(env.clone()));
            self.stack.push(Frame {
                mode: Mode::Text,
                env: Some(env),
                depth_at_entry: self.depth,
                delim: Delim::None,
            });
        }
    }

    fn end_environment(&mut self) {
        let (text, policy) = (self.text, self.policy);
        let Some((env, after)) = env_name(text, self.i - 4, "\\end") else {
            self.push(Reason::UnbalancedEnvironment);
            return;
        };
        self.i = after;
        match self
            .stack
            .iter()
            .rposition(|f| f.env.as_deref() == Some(env.as_str()))
        {
            Some(pos) if pos == self.stack.len() - 1 => {
                self.finish_frame();
                let f = self.stack.pop().unwrap();
                if f.depth_at_entry != self.depth {
                    self.push(Reason::UnbalancedBraces);
                    self.depth = f.depth_at_entry;
                }
                if policy.is_block_env(&env) || policy.transparent_envs.contains(&env) {
                    self.env_depth -= 1;
                    if self.env_depth == 0 && policy.is_block_env(&env) {
                        self.block_env_closed_at = Some(self.i);
                    }
                }
            }
            _ => self.push(Reason::UnbalancedEnvironment),
        }
    }

    /// Opaque arguments (URLs, units, verbatim): skipped; the package is checked.
    fn opaque_arguments(&mut self, name: &str, nargs: usize) {
        let text = self.text;
        if let Some(Err(pkg)) = package_macro(name, self.policy) {
            self.push(Reason::NeedsPackage(pkg.into()));
        }
        if nargs == 0 || URL_MACROS.contains(&name) {
            match literal_argument_end(text, self.i, name) {
                Some(end) => {
                    self.i = end;
                    // Only the URL is opaque; link text must still be scanned normally.
                    if name == "href" && self.arguments_missing(1, false) {
                        self.incomplete_command_argument();
                    }
                }
                None => {
                    self.incomplete_command_argument();
                }
            }
        } else {
            self.i = text.len() - text[self.i..].trim_start().len();
            if text[self.i..].starts_with('[') {
                if let Some(arg) = optional_arg(&text[self.i..]) {
                    self.i += arg.len() + 2;
                } else {
                    self.incomplete_command_argument();
                    self.i = text.len();
                    return;
                }
            }
            for _ in 0..nargs {
                match self.math_argument(self.i) {
                    MathArgument::Present(end) => self.i = end,
                    MathArgument::OpenGroup => {
                        self.push(Reason::UnbalancedBraces);
                        self.i = text.len();
                        break;
                    }
                    MathArgument::Missing => {
                        self.incomplete_command_argument();
                        break;
                    }
                }
            }
        }
    }

    /// A macro: allowed by the vocabulary for its mode and context, or a reason.
    fn macro_word(&mut self, name: String, in_math: bool) {
        let (text, policy) = (self.text, self.policy);
        let allowed = if let Some(provided) = package_macro(&name, policy) {
            if let Err(pkg) = provided {
                self.push(Reason::NeedsPackage(pkg.into()));
            }
            if in_math && matches!(name.as_str(), "text" | "mbox") {
                self.text_group_pending = text[self.i..].trim_start().starts_with('{');
            }
            true
        } else if GROUP_ONLY_SETTERS.contains(&name.as_str())
            || ((name == "renewcommand" || name == "renewcommand*")
                && text[self.i..].trim_start().starts_with("{\\arraystretch}"))
        {
            if self.depth == 0 && self.env_depth == 0 {
                self.push(Reason::SizeDeclarationOutsideGroup(name.clone()));
            }
            // the first argument names the length or macro being set: skip it
            let rest = &text[self.i..];
            let lead = rest.len() - rest.trim_start().len();
            if let Some(after) = rest.trim_start().strip_prefix('{') {
                if let Some(e) = after.find('}') {
                    self.i += lead + 1 + e + 1;
                }
            }
            true
        } else if in_math {
            let ok = MATH_MACROS.contains(&name.as_str())
                || TEXT_WRAPPERS.contains(&name.as_str())
                || policy.trusted_math.contains(&name)
                || policy.trusted_macros.contains(&name);
            if ok && (TEXT_WRAPPERS.contains(&name.as_str()) || name == "intertext")
            {
                self.text_group_pending = text[self.i..].trim_start().starts_with('{');
            }
            if (name == "tag"
                || name == "notag"
                || name == "nonumber"
                || name == "intertext"
                || name == "eqref")
                && !policy.amsmath
                && name != "nonumber"
            {
                self.push(Reason::NeedsPackage("amsmath".into()));
            }
            ok
        } else if GROUP_ONLY_DECLARATIONS.contains(&name.as_str()) {
            if self.depth == 0
                && self.env_depth == 0
                && !matches!(self.shape, UnitShape::Heading(_))
            {
                self.push(Reason::SizeDeclarationOutsideGroup(name.clone()));
            }
            true
        } else if HEADINGS.contains(&name.as_str()) || policy.heading_macros.contains_key(&name) {
            // only as the unit's own heading command (possibly after leading vertical
            // material such as \newpage), or a user macro wrapping one
            let h = policy
                .heading_macros
                .get(&name)
                .cloned()
                .unwrap_or_else(|| name.clone());
            matches!(&self.shape, UnitShape::Heading(sh) if *sh == h)
                && self.i <= self.heading_base + name.len() + 2
        } else if name == "item" {
            let in_list = self.stack.iter().any(|f| {
                f.env
                    .as_deref()
                    .map(|e| LIST_ENVS.contains(&e))
                    .unwrap_or(false)
            });
            if !in_list {
                self.push(Reason::MacroOutsideContext(name.clone()));
            }
            true
        } else if FLOAT_MACROS.contains(&name.as_str()) {
            let in_float = self.stack.iter().any(|f| {
                f.env
                    .as_deref()
                    .map(|e| FLOAT_ENVS.contains(&e))
                    .unwrap_or(false)
            });
            if !in_float {
                self.push(Reason::MacroOutsideContext(name.clone()));
            }
            true
        } else if TABULAR_MACROS.contains(&name.as_str())
            || BOOKTABS_MACROS.contains(&name.as_str())
        {
            let in_tab = self.stack.iter().any(|f| {
                f.env
                    .as_deref()
                    .map(|e| e.starts_with("tabular") || e == "array")
                    .unwrap_or(false)
            });
            if !in_tab {
                self.push(Reason::MacroOutsideContext(name.clone()));
            }
            if BOOKTABS_MACROS.contains(&name.as_str()) && !policy.booktabs {
                self.push(Reason::NeedsPackage("booktabs".into()));
            }
            true
        } else if name == "includegraphics" {
            if !policy.graphicx {
                self.push(Reason::NeedsPackage("graphicx".into()));
            }
            true
        } else if name == "cite" {
            if !policy.cite_ok {
                self.push(Reason::DisallowedMacro(name.clone()));
            }
            true
        } else if name == "eqref" {
            if !policy.amsmath {
                self.push(Reason::NeedsPackage("amsmath".into()));
            }
            true
        } else {
            TEXT_MACROS.contains(&name.as_str()) || TEXT_WRAPPERS.contains(&name.as_str())
                || policy.trusted_macros.contains(&name)
        };
        // A custom macro can discard a token that only looks like a missing argument.
        if !in_math && (!allowed || policy.trusted_macros.contains(&name)) {
            self.frame_checks.entry(self.stack.len()).or_default().uncertain = true;
        }
        if !allowed {
            // Reading the current page cannot change keys or state outside this unit.
            if semantic_arguments(&name).is_none() && name != "thepage" {
                self.semantic.uncertain = true;
            }
            let r = if in_math {
                Reason::DisallowedMathMacro(name)
            } else {
                Reason::DisallowedMacro(name)
            };
            self.push(r);
        }
    }

    /// A character other than a backslash or a newline: groups, math shifts, text after a
    /// block environment.
    fn character(&mut self, c: u8, in_math: bool) {
        let b = self.b;
        match c {
            b'{' => {
                self.depth += 1;
                if self.text_group_pending {
                    self.text_group_pending = false;
                    self.stack.push(Frame {
                        mode: Mode::Text,
                        env: None,
                        depth_at_entry: self.depth,
                        delim: Delim::None,
                    });
                }
            }
            b'}' => {
                if in_math {
                    if let Some(fences) = self.frame_checks.get_mut(&self.stack.len()) {
                        if fences.left_depths.iter().any(|depth| *depth == self.depth) {
                            fences.broken = true;
                            fences.left_depths.retain(|depth| *depth != self.depth);
                        }
                    }
                }
                self.depth -= 1;
                if self.depth < 0 {
                    self.push(Reason::UnbalancedBraces);
                    self.depth = 0;
                }
                // leaving a \text{...} group
                if let Some(f) = self.stack.last() {
                    if f.env.is_none()
                        && f.mode == Mode::Text
                        && self.stack.len() > 1
                        && f.depth_at_entry == self.depth + 1
                    {
                        self.finish_frame();
                        self.stack.pop();
                    }
                }
            }
            b'$' => {
                let double = self.i + 1 < b.len() && b[self.i + 1] == b'$';
                if double {
                    self.i += 1;
                }
                let depth = self.depth;
                let dollar = move |delim| Frame {
                    mode: Mode::Math,
                    env: None,
                    depth_at_entry: depth,
                    delim,
                };
                if in_math {
                    let f = self.stack.last().unwrap();
                    let same_depth = f.depth_at_entry == self.depth;
                    match (f.delim, double) {
                        (Delim::Dollar, false) | (Delim::DoubleDollar, true) if same_depth => {
                            self.finish_frame();
                            self.stack.pop();
                        }
                        // `$a$$b$`: the first `$` ends the formula, the second starts the next
                        (Delim::Dollar, true) if same_depth => {
                            self.finish_frame();
                            self.stack.pop();
                            let next = dollar(Delim::Dollar);
                            self.stack.push(next);
                        }
                        // `\[ a $`, `$$ a $`, `\begin{equation} a $`, or at another depth
                        _ => self.push(Reason::UnbalancedMath),
                    }
                } else {
                    let open = dollar(if double {
                        Delim::DoubleDollar
                    } else {
                        Delim::Dollar
                    });
                    self.stack.push(open);
                }
            }
            b'^' | b'_' if in_math => {
                // Repeated/invalid scripts are ordinary live TeX errors. Here only the
                // missing field is known without expansion; primes (x'^2, x^\prime) work
                // as usual and an empty group is a perfectly valid script argument.
                if matches!(self.math_argument(self.i + 1), MathArgument::Missing) {
                    self.incomplete_math_argument();
                }
            }
            _ => {
                if self.block_env_closed_at.is_some()
                    && self.env_depth == 0
                    && self.shape == UnitShape::Par
                    && !c.is_ascii_whitespace()
                {
                    self.push(Reason::TextAfterEnvironment);
                }
            }
        }
    }

    fn finish(mut self, permissive: bool) -> (UnitShape, Vec<Reason>) {
        let text = self.text;
        if self.frame_checks.values().any(|f| !f.uncertain && f.missing_command_argument) {
            self.push(Reason::IncompleteCommand);
        }
        if self.frame_checks.values().any(|fences| {
            !fences.uncertain
                && (fences.broken || fences.missing_argument || !fences.left_depths.is_empty())
        }) {
            self.push(Reason::IncompleteMath);
        }
        if self.depth != 0 {
            self.push(Reason::UnbalancedBraces);
        }
        if self.stack.len() > 1 {
            let f = self.stack.last().unwrap();
            if f.env.is_some() {
                self.push(Reason::UnbalancedEnvironment);
            } else if f.mode == Mode::Math {
                self.push(Reason::UnbalancedMath);
            }
        }
        let _ = Reason::EnvironmentBoundary;
        let _ = Reason::DisplayMath;
        // the title block is a center environment in the capture (article's \@maketitle)
        if self.shape == UnitShape::Par && text.contains("\\maketitle") {
            self.shape = UnitShape::Env("center".into());
        }
        if permissive {
            self.reasons.retain(|r| !is_vocabulary_reason(r));
        }
        (self.shape, self.reasons)
    }
}

/// Length of the vertical material at the start of `s` (`\vspace`, `\noindent`, `\centering`,
/// page breaks …), which a unit's box absorbs without typesetting anything.
pub fn vertical_prefix_len(trimmed: &str) -> usize {
    let mut k = 0;
    loop {
        let rest = trimmed[k..].trim_start();
        let off = trimmed.len() - rest.len();
        let mut matched = None;
        for v in [
            "\\vspace*",
            "\\vspace",
            "\\noindent",
            "\\newpage",
            "\\clearpage",
            "\\pagebreak",
            "\\smallskip",
            "\\medskip",
            "\\bigskip",
            "\\vfill",
            "\\centering",
        ] {
            if rest.starts_with(v)
                && !rest[v.len()..].starts_with(|c: char| c.is_ascii_alphabetic())
            {
                let mut e = v.len();
                if rest[e..].starts_with('{') {
                    if let Some(c) = rest[e..].find('}') {
                        e += c + 1;
                    }
                }
                matched = Some(off + e);
                break;
            }
        }
        match matched {
            Some(e) => k = e,
            None => break off,
        }
    }
}

/// Offset of the first substantive content of a unit's (comment-stripped) text: after setup
/// statements and vertical material. A block environment starting there is the unit; one
/// starting after other content is an inline box of a paragraph.
pub fn content_start(text: &str) -> usize {
    let (k, _) = setup_prefix(text);
    let rest = &text[k..];
    let ws = rest.len() - rest.trim_start().len();
    k + ws + vertical_prefix_len(rest.trim_start())
}

/// Does `src` (comments allowed) contain substantive content, i.e. anything a paragraph would
/// be open for, beyond setup statements and vertical material?
pub fn has_content(src: &str) -> bool {
    let text = strip_comments(src);
    content_start(&text) < text.trim_end().len()
}

/// Lexical check of a unit's source. Returns the (possibly empty) list of reasons.
pub fn check_source(src: &str, policy: &Policy) -> Vec<Reason> {
    classify_source(src, policy).1
}

/// `\everypar` contents the server may replay verbatim at a unit's start: the kernel's own
/// patterns (after a heading, after an environment, first paragraph of a box) and microtype's
/// `\leftprotrusion`. Everything else makes the unit background-only.
pub fn everypar_allowed(ep: &str) -> bool {
    let e = ep
        .trim_start_matches("\\leftprotrusion ")
        .trim_end_matches("\\leftprotrusion ");
    if e.is_empty() {
        return true;
    }
    const PATTERNS: &[&str] = &[
        // Exhausted kernel run-in state, normalized by the capture after its title ran.
        "\\clubpenalty \\@clubpenalty \\everypar {}",
        // \@afterheading (with and without the \if@afterindent branch)
        "\\if@nobreak \\@nobreakfalse \\clubpenalty \\@M \\if@afterindent \\else {\\setbox \\z@ \\lastbox }\\fi \\else \\clubpenalty \\@clubpenalty \\everypar {}\\fi ",
        "\\if@nobreak \\@nobreakfalse \\clubpenalty \\@M \\setbox \\z@ \\lastbox \\else \\clubpenalty \\@clubpenalty \\everypar {}\\fi ",
        // \@doendpe (first paragraph after an environment)
        "{\\setbox \\z@ \\lastbox }\\everypar {}\\@endpefalse ",
        // \@setminipage (first paragraph in a float or minipage)
        "\\@minipagefalse \\everypar {}",
    ];
    PATTERNS.contains(&e)
}

/// Engine-side check of a unit from the capture: `everypar` pattern, node flags, members.
/// `run_in`: the heading's name when the capture saw it set run-in (`CapturedUnit::runin`).
pub fn check_engine_unit(
    kind: &str,
    everypar: &str,
    has_context: bool,
    rows: i64,
    flags: &std::collections::BTreeMap<String, i64>,
    run_in: Option<&str>,
) -> Vec<Reason> {
    let mut reasons = Vec::new();
    // `classify_source` reports the run-in headings it knows by name from the source
    if let Some(h) = run_in.filter(|h| !RUN_IN_HEADINGS.contains(h)) {
        reasons.push(Reason::RunInHeading(h.to_string()));
    }
    if !everypar_allowed(everypar) {
        reasons.push(Reason::NonDefaultEverypar);
    }
    if !has_context {
        reasons.push(Reason::NoContext);
    }
    if rows == 0 {
        reasons.push(Reason::NoPlacement);
    }
    let _ = kind;
    for (k, v) in flags {
        if *v == 0 {
            continue;
        }
        // inserts (footnotes), marks (running heads) and adjust material are placed by the page
        // builder and refreshed by the next layout; direction changes are not supported.
        if k == "dir" {
            reasons.push(Reason::EngineFlag(format!("{k}={v}")));
        }
    }
    reasons
}

/// Legacy per-paragraph engine check (kept for the verification tools).
pub fn check_engine(
    groupcode: &str,
    nest: i64,
    everypar: &str,
    has_begin: bool,
    flags: &std::collections::BTreeMap<String, i64>,
) -> Vec<Reason> {
    let mut reasons = Vec::new();
    if !(groupcode.is_empty() && nest == 1) {
        reasons.push(Reason::NotTopLevel);
    }
    if !everypar_allowed(everypar) {
        reasons.push(Reason::NonDefaultEverypar);
    }
    if !has_begin {
        reasons.push(Reason::NoContext);
    }
    for (k, v) in flags {
        if *v != 0 && k == "dir" {
            reasons.push(Reason::EngineFlag(format!("{k}={v}")));
        }
    }
    reasons
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pol() -> Policy {
        Policy {
            amsmath: true,
            graphicx: true,
            booktabs: true,
            tabularx: true,
            cite_ok: true,
            permissive: false,
            heading_macros: BTreeMap::new(),
            packages: [
                "hyperref", "url", "natbib", "siunitx", "ulem", "listings", "multirow", "colortbl",
                "cancel", "bm", "amssymb",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            ..Default::default()
        }
    }
    fn ok(s: &str) -> bool {
        check_source(s, &pol()).is_empty()
    }
    fn reasons(s: &str) -> Vec<Reason> {
        check_source(s, &pol())
    }

    #[test]
    fn vocabulary_only_flags_new_unverified_reasons_even_in_permissive_mode() {
        let mut policy = Policy::default();
        policy.permissive = true;
        for (before, after, expected) in [
            (r"Text \existing{x}", r"Other \existing{y}", false),
            (r"Text \existing{x}", r"Text \introduced{x}", true),
            (r"Text \existing{x}", "Text", false),
            ("Text", r"Text $\unknownmath{x}$", true),
            (r"\citet{a}", r"\citep{a}", true),
            ("Text", "Text % \\unknown{x}", false),
            (r"\verb|\old|", r"\verb|\new|", false),
            (r"\begin{verbatim}\old\end{verbatim}", r"\begin{verbatim}\new\end{verbatim}", false),
        ] {
            assert_eq!(new_unverified_vocabulary(before, after, &policy), expected, "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_evidence_uses_active_policy_for_user_environments_and_package_wrappers() {
        let policy = Policy::from_preamble(
            "\\usepackage{graphicx}\n\\newenvironment{solution}{\\par\\noindent\\textbf{Solution.}\\ \\itshape}{\\par}\n\\newenvironment{hint}[1]{\\begin{quote}\\small\\textbf{#1:}\\ }{\\end{quote}}\n",
            &[], &[],
        );
        for (before, after, expected) in [
            (r"\begin{hint}{Idea}Original words.\end{hint}", r"\begin{hint}{Idea}Different words.\end{hint}", false),
            (r"\begin{solution}\label{a}Original words.\end{solution}", r"\begin{solution}\label{a}Different words.\end{solution}", false),
            (r"Original \scalebox{2}{x} words.", r"Different \scalebox{2}{x} words.", false),
            (r"\begin{solution}\label{a}Words.\end{solution}", r"\begin{solution}\label{b}Words.\end{solution}", true),
            (r"Original \unknown{a} words.", r"Original \unknown{b} words.", true),
        ] {
            assert_eq!(semantic_keys_changed_with(before, after, &policy), expected, "{before} -> {after}");
        }
    }

    #[test]
    fn unfinished_known_math_does_not_invalidate_other_units_semantically() {
        let policy = Policy::default();
        for (before, after) in [
            ("Known $XY$.", "Known $XY^$."),
            ("Known $XY^$.", "Edited known $XY^$."),
            ("Known $XY$.", "Known $"),
            ("Known $", "Edited known $"),
        ] {
            assert!(classify_source(after, &policy).1.iter().any(Reason::is_unfinished), "{after}");
            assert!(!semantic_keys_changed_with(before, after, &policy), "{before} -> {after}");
        }
    }

    #[test]
    fn unfinished_semantic_keys_and_unknown_effects_still_invalidate_other_units() {
        let policy = Policy::from_preamble(
            "\\usepackage{tikz}\n\\newcommand{\\key}[1]{\\label{#1}}\n\\newenvironment{keyed}[1]{\\label{#1}}{}\n",
            &[], &[],
        );
        for (before, after) in [
            (r"\label{removed} Known $XY$.", "Known $XY^$."),
            ("Known text.", r"Known \label{"),
            ("Known text.", r"\begin{equation}x"),
            ("Known text.", r"\begin{enumerate}\item x"),
            ("Known text.", r"Known \textbf{"),
            (r"\begin{equation}XY\end{equation}", r"\begin{equation}XY^\end{equation}"),
            (r"Words \begin{equation}XY\end{equation}", r"Edited words \begin{equation}XY^\end{equation}"),
            (r"\begin{equation}XY^\end{equation}", r"\begin{equation}\notag XY^\end{equation}"),
            (r"\begin{equation}XY^\end{equation}", r"\begin{equation}\nonumber XY^\end{equation}"),
            (r"Known \unknown{a}", r"Known \unknown{"),
            (r"Known \key{a}", r"Known \key{"),
            (r"\begin{keyed}{a}x\end{keyed}", r"\begin{keyed}{"),
            (r"\begin{mystery}x\end{mystery}", r"\begin{mystery}x"),
            (r"\begin{tikzpicture}\draw (0,0);", r"\begin{tikzpicture}\draw (1,1);"),
        ] {
            assert!(semantic_keys_changed_with(before, after, &policy), "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_picture_evidence_survives_a_blank_line_split_or_prose_edit() {
        let policy = Policy::from_preamble(r"\usepackage{tikz}", &[], &[]);
        let before = "Sentence before the plot:\n\\begin{center}\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\\end{center}";
        let split = before.replacen(":\n", ":\n\n", 1);
        assert!(!semantic_keys_changed_with(before, &split, &policy), "a span boundary is not a changed picture body");
        let prose = before.replacen("Sentence", "Edited sentence", 1);
        assert!(!semantic_keys_changed_with(before, &prose, &policy));
        assert!(!new_unverified_vocabulary(before, &split, &policy));
    }

    #[test]
    fn semantic_picture_evidence_keeps_changed_missing_and_incomplete_bodies_conservative() {
        let policy = Policy::from_preamble(r"\usepackage{tikz}", &[], &[]);
        let before = r"Words \begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}";
        for after in [
            r"Words \begin{tikzpicture}\draw (0,0)--(2,2);\end{tikzpicture}",
            "Words",
            r"Words \begin{tikzpicture}\draw (0,0)--(1,1);",
        ] {
            assert!(semantic_keys_changed_with(before, after, &policy), "{after}");
        }
        assert!(semantic_keys_changed_with(r"Words \unknown{a}", r"Edited words \unknown{a}", &policy),
            "arbitrary unknown macro effects are still conservative");
        assert!(semantic_keys_changed_with(
            r"\begin{tikzpicture}\label{a}\end{tikzpicture}",
            r"\begin{tikzpicture}\label{b}\end{tikzpicture}", &policy));
        assert!(!semantic_keys_changed_with(
            "\\begin{tikzpicture}% \\label{a}\n\\draw (0,0);\\end{tikzpicture}",
            "\\begin{tikzpicture}% \\label{b}\n\\draw (0,0);\\end{tikzpicture}", &policy));
    }

    #[test]
    fn semantic_policy_does_not_trust_inline_environment_label_effects() {
        let policy = Policy::from_preamble(r"\newenvironment{keyed}[1]{\label{#1}}{}", &[], &[]);
        let before = r"Words \begin{keyed}{a}x\end{keyed}";
        let after = r"Words \begin{keyed}{b}x\end{keyed}";
        assert!(classify_source(before, &policy).1.is_empty(), "eligibility remains unchanged");
        assert!(!new_unverified_vocabulary(before, after, &policy));
        assert!(semantic_keys_changed_with(before, after, &policy));
    }

    #[test]
    fn semantic_policy_does_not_trust_block_or_transitive_environment_effects() {
        let policy = Policy::from_preamble(
            "\\newcommand{\\key}[1]{\\label{#1}}\n\\newenvironment{keyblock}[1]{\\begin{quote}\\label{#1}}{\\end{quote}}\n\\newenvironment{indirect}[1]{\\key{#1}}{}\n",
            &[], &[],
        );
        for (before, after) in [
            (r"\begin{keyblock}{a}x\end{keyblock}", r"\begin{keyblock}{b}x\end{keyblock}"),
            (r"Words \begin{indirect}{a}x\end{indirect}", r"Words \begin{indirect}{b}x\end{indirect}"),
        ] {
            assert!(classify_source(before, &policy).1.is_empty(), "{before}");
            assert!(semantic_keys_changed_with(before, after, &policy), "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_policy_keeps_pure_style_environments_local() {
        let policy = Policy::from_preamble(
            "\\usepackage{xcolor}\n\\newenvironment{NEW}{\\color{blue}}{\\ignorespacesafterend}\n\\newenvironment{solution}{\\par\\noindent\\textbf{Solution.}\\ \\itshape}{\\par}\n\\newenvironment{hint}[1]{\\begin{quote}\\small\\textbf{#1:}\\ }{\\end{quote}}\n",
            &[], &[],
        );
        for (before, after) in [
            (r"\begin{NEW}Original words.\end{NEW}", r"\begin{NEW}Different words.\end{NEW}"),
            (r"\begin{solution}Original words.\end{solution}", r"\begin{solution}Different words.\end{solution}"),
            (r"\begin{hint}{Idea}Original words.\end{hint}", r"\begin{hint}{Idea}Different words.\end{hint}"),
        ] {
            assert!(!semantic_keys_changed_with(before, after, &policy), "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_policy_keeps_checked_pure_math_aliases_local() {
        let policy = Policy::from_preamble(
            "\\usepackage{amsfonts}\n\\newcommand{\\probability}[1]{\\P(\\abs{#1})}\n\\renewcommand{\\P}{\\mathbb{P}}\n\\newcommand{\\E}{\\mathbb{E}}\n\\newcommand{\\abs}[1]{\\left|#1\\right|}\n\\newcommand{\\strong}[1]{\\textbf{#1}}\n",
            &[], &[],
        );
        for (before, after) in [
            (r"Original $\P(A)=\E[X]$.", r"Different $\P(B)=\E[Y]$."),
            (r"Original $\abs{x}$.", r"Different $\abs{y}$."),
            (r"Original $\probability{x}$.", r"Different $\probability{y}$."),
            (r"Original \strong{words}.", r"Different \strong{text}."),
        ] {
            assert!(!semantic_keys_changed_with(before, after, &policy), "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_policy_keeps_effectful_aliases_and_bodyless_trust_conservative() {
        let policy = Policy::from_preamble(
            "\\usepackage{amsmath}\n\\newcommand{\\key}[1]{\\label{#1}}\n\\newcommand{\\entry}[1]{\\index{#1}}\n\\newcommand{\\numbertag}[1]{\\tag{#1}}\n\\newcommand{\\advance}[1]{\\stepcounter{#1}}\n\\newcommand{\\gap}[1]{\\vspace{#1}}\n\\newcommand{\\keyalias}[1]{\\key{#1}}\n\\newcommand{\\record}[1]{\\write16{#1}}\n",
            &["opaque".into()], &[],
        );
        for (before, after) in [
            (r"Words \key{a}", r"Words \key{b}"),
            (r"Words \entry{a}", r"Words \entry{b}"),
            (r"$\numbertag{A}x$", r"$\numbertag{B}x$"),
            (r"Words \advance{a}", r"Words \advance{b}"),
            (r"Words \gap{1pt}", r"Words \gap{2pt}"),
            (r"Words \keyalias{a}", r"Words \keyalias{b}"),
            (r"Words \opaque{a}", r"Words \opaque{b}"),
            (r"Words \record{a}", r"Words \record{b}"),
        ] {
            assert!(semantic_keys_changed_with(before, after, &policy), "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_policy_does_not_hide_changed_arguments_of_a_custom_label_wrapper() {
        let policy = Policy::from_preamble(r"\newcommand{\key}[1]{\label{#1}}", &[], &[]);
        assert!(policy.trusted_macros.contains("key"));
        assert!(semantic_keys_changed_with(r"Text \key{a}", r"Text \key{b}", &policy));
    }

    #[test]
    fn semantic_evidence_does_not_invalidate_for_an_existing_read_only_page_command() {
        let policy = Policy::from_preamble(r"\documentclass{article}", &[], &[]);
        let before = r"Paged: on page \thepage{} text.";
        let after = r"Paged: edited on page \thepage{} text.";
        assert!(!semantic_keys_changed_with(before, after, &policy));
        assert!(!new_unverified_vocabulary(before, after, &policy));
        // Semantic read-only treatment must not grant eligibility to new unknown vocabulary.
        assert!(new_unverified_vocabulary("Paged: text.", after, &policy));
        assert!(classify_source_with(after, &policy, false).1.contains(&Reason::DisallowedMacro("thepage".into())));
        assert!(semantic_keys_changed_with(before, r"Paged: on page \newunknown{} text.", &policy));
    }

    #[test]
    fn semantic_evidence_tracks_index_entries_but_ignores_literal_index_commands() {
        for (before, after, expected) in [
            (r"Words\index{a}", r"Words\index{b}", true),
            (r"Words\index{a}", r"Other words\index{a}", false),
            (r"Words\index[authors]{a}", r"Words\index[subjects]{a}", true),
            (r"Words\index{a}", r"Words\index{", true),
            ("Words % \\index{a}", "Words % \\index{b}", false),
            (r"\verb|\index{a}|", r"\verb|\index{b}|", false),
            (r"\begin{verbatim}\index{a}\end{verbatim}", r"\begin{verbatim}\index{b}\end{verbatim}", false),
        ] {
            assert_eq!(semantic_keys_changed(before, after), expected, "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_evidence_tracks_explicit_equation_tags_and_their_star() {
        for (before, after, expected) in [
            (r"\begin{equation}\tag{A}\label{x}x\end{equation}", r"\begin{equation}\tag{B}\label{x}x\end{equation}", true),
            (r"\begin{equation}\tag*{A}\label{x}x\end{equation}", r"\begin{equation}\tag*{B}\label{x}x\end{equation}", true),
            (r"\begin{equation}\tag{A}\label{x}x\end{equation}", r"\begin{equation}\tag*{A}\label{x}x\end{equation}", true),
            (r"\begin{equation}\tag*{A}\label{x}x\end{equation}", r"\begin{equation}\tag*{A}\label{x}y\end{equation}", false),
            (r"$\tag{A}x$", r"$\tag{x$", true),
            ("Words % \\tag*{A}", "Words % \\tag{B}", false),
            (r"\verb|\tag*{A}|", r"\verb|\tag{B}|", false),
            (r"\begin{verbatim}\tag*{A}\end{verbatim}", r"\begin{verbatim}\tag{B}\end{verbatim}", false),
        ] {
            assert_eq!(semantic_keys_changed(before, after), expected, "{before} -> {after}");
        }
    }

    #[test]
    fn semantic_evidence_distinguishes_labelled_prose_from_keys_and_page_effects() {
        for (before, after, expected) in [
            (r"\begin{proof}\label{proof:a} Original words.\end{proof}", r"\begin{proof}\label{proof:a} Different words.\end{proof}", false),
            (r"\label{a} words", r"\label{b} words", true),
            (r"\ref{a}", r"\ref{b}", true),
            (r"\cite[see]{a,b}", r"\cite[see]{a,c}", true),
            (r"\citep[see][p. 2]{a}", r"\citep[see][p. 2]{b}", true),
            ("Words", r"Words\newpage", true),
            ("Words", r"Words\clearpage", true),
            (r"Words\vspace{1pt}", r"Words\vspace{2pt}", true),
            (r"Words\pagebreak[2]", r"Words\pagebreak[3]", true),
            (r"Words\enlargethispage{1pt}", r"Words\enlargethispage{2pt}", true),
            ("Words % \\label{a}", "Words % \\label{b}", false),
            (r"\verb|\label{a}|", r"\verb|\label{b}|", false),
            (r"\begin{verbatim}\cite{a}\newpage\end{verbatim}", r"\begin{verbatim}\cite{b}\clearpage\end{verbatim}", false),
            (r"\url{https://x/\label{a}}", r"\url{https://x/\label{b}}", false),
            (r"\begin{verbatim}A% \label{a}\end{verbatim}", r"\begin{verbatim}B% \label{b}\end{verbatim}", false),
            (r"\label{a}", r"\label{", true),
            (r"\cite{a}", r"\cite[", true),
            (r"\mystery{a}", r"\mystery{b}", true),
        ] {
            assert_eq!(semantic_keys_changed(before, after), expected, "{before} -> {after}");
        }
    }

    #[test]
    fn plain_and_fonts_ok() {
        assert!(ok(
            "Plain text, with \\emph{emphasis} and \\textbf{bold}, ``quotes'' and a dash---here."
        ));
        assert!(ok(
            "Inline $x^2 + \\frac{1}{2} \\leq \\alpha$ math and \\(a_i\\) too.\nSecond line."
        ));
        assert!(ok("{\\itshape grouped declaration} and {\\small small}."));
        assert!(ok(
            "A \\textcolor{red}{red} word and \\'e accents, 50\\% and \\&."
        ));
    }

    #[test]
    fn incomplete_command_arguments_wait_without_rejecting_complete_tokens() {
        for src in [
            r"Text \url", r"Text \url{https://example.com", r"Text \url|https://example.com",
            r"Text \href{https://example.com", r"Text \href{https://example.com}",
            r"Text \href[page=2]{https://example.com}", r"Text \verb|unfinished",
            r"Text \textbf", r"Text \emph", r"Text \textcolor{red}",
        ] {
            let r = reasons(src);
            assert!(r.iter().any(Reason::is_unfinished), "{src}: {r:?}");
        }
        for src in [
            r"Text \url{https://example.com/a%20b}", r"Text \url|https://example.com/a%20b|",
            r"Text \href{https://example.com/a%20b}{\textbf{Link}}",
            r"Text \href[page=2]{https://example.com}{Link}",
            r"Text \textbf X", r"Text \emph\LaTeX", r"Text \textcolor{red}X",
            r"Text \verb|percent % and braces { }|", r"Text \verb}braces}",
            r"Text \verb{braces{", "Text \\url{https://example.com/a%20b\n/path}",
            "Text \\textbf% comment\n{Bold}",
        ] {
            assert!(ok(src), "{src}: {:?}", reasons(src));
        }
        assert!(reasons(r"\href{https://example.com}{\textbf{Link}")
            .contains(&Reason::UnbalancedBraces));
        assert!(reasons(r"\url{https://example.com/a%20b} then $x")
            .contains(&Reason::UnbalancedMath), "literal percent must not hide later source");
    }

    #[test]
    fn verbatim_delimiters_never_split_unicode_characters() {
        for src in [r"\verb汉", r"\verb*😀", r"\lstinline😀", r"\verb😀text😀", r"\verb*😀%😀"] {
            let _ = classify_source(src, &pol());
        }
        assert!(ok(r"\verb*😀%😀 then text"));
        assert!(reasons(r"\verb*😀%😀 then $x").contains(&Reason::UnbalancedMath));
    }

    #[test]
    fn standard_text_wrappers_keep_nested_math_live() {
        for name in ["textnormal", "textsf", "texttt", "textsc", "textmd", "textup", "textsl", "emph", "textrm", "text"] {
            let src = format!(r"$\{name}{{$x$}}$");
            assert!(ok(&src), "{src}: {:?}", reasons(&src));
            let single_token = format!(r"$\{name} x+\frac{{\alpha}}{{b}}$");
            assert!(ok(&single_token), "{single_token}: {:?}", reasons(&single_token));
        }
    }

    #[test]
    fn standard_math_arguments_wait_until_the_field_is_present() {
        for src in [r"$\overline$", r"$\underline$", r"$\overset{a}$", r"$\underset{a}$",
            r"$\stackrel{a}$", r"$\operatorname$", r"$\text$", r"$\mathop$", r"$\textcolor{red}$"] {
            assert!(reasons(src).contains(&Reason::IncompleteMath), "{src}: {:?}", reasons(src));
        }
        for src in [r"$\overline x$", r"$\overset ab$", r"$\underset{a}{b}$", r"$\operatorname{rank}$",
            r"$\text{plain ^ and _}$", r"$\mathop{x}$", r"$\textcolor{red}x$"] {
            assert!(ok(src), "{src}: {:?}", reasons(src));
        }
        let p = Policy::from_preamble(r"\usepackage{hyperref}\newcommand{\ignore}[1]{}", &[], &[]);
        for src in [r"$\ignore{\overline}$", r"$\ignore{\overset}$", r"\ignore{\textbf}",
            r"\ignore{\url}", r"\ignore{\href}", r"\ignore{\verb}"] {
            assert!(check_source(src, &p).is_empty(), "{src}: {:?}", check_source(src, &p));
        }
    }

    #[test]
    fn ignored_literal_commands_do_not_hide_later_comments() {
        let p = Policy::from_preamble(r"\usepackage{hyperref}\newcommand{\ignore}[1]{}", &[], &[]);
        for name in ["url", "href", "verb"] {
            let src = format!(r"\ignore{{\{name}}} text % $");
            assert!(check_source(&src, &p).is_empty(), "{src}: {:?}", check_source(&src, &p));
        }
    }
    #[test]
    fn disallowed() {
        assert!(reasons("Footnote\\footnote{x} here.").is_empty());
        assert!(reasons("\\mymacro{x}").contains(&Reason::DisallowedMacro("mymacro".into())));
        assert!(reasons("Text \\large leaking.")
            .contains(&Reason::SizeDeclarationOutsideGroup("large".into())));
        assert!(reasons("one\n\ntwo").contains(&Reason::ParagraphBreak));
        // an explicit \par is fine: a span may hold several consecutive paragraphs (one unit)
        assert!(!reasons("a \\par b").contains(&Reason::ParagraphBreak));
        // comment lines are not blank lines: `%` also removes the end of its line
        for src in [
            "% one\n% two\nHello world.\nMore.",
            "Hello world.\n% one\nMore.",
            "Hello world.\n% one\n% two\nMore.",
            "Hello % note\n% two\nworld.",
        ] {
            assert!(!reasons(src).contains(&Reason::ParagraphBreak), "{src:?}");
        }
        assert!(reasons("one\n% c\n\ntwo").contains(&Reason::ParagraphBreak));
        let r = reasons("{\\Large\\bfseries Title\\par}\nName \\hfill 22 September 2026");
        assert!(r.is_empty(), "{r:?}");
        assert!(!ok("a \\parbox-like? no: \\parskip is disallowed"));
        assert!(reasons("\\begin{tikzpicture}\\end{tikzpicture}")
            .contains(&Reason::DisallowedEnvironment("tikzpicture".into())));
        // opaque arguments and verbatim
        assert!(reasons(
            "see \\url{https://a.b/c_d%e#f} and \\href{https://x.y/_z}{the \\textbf{notes}}"
        )
        .is_empty());
        assert!(reasons("call \\verb|\\foo{bar}| and \\lstinline|add(2, 3)| here").is_empty());
        assert!(reasons("and \\verb+%percent+ signs").is_empty());
        assert_eq!(
            classify_source("\\vspace{1cm}\n\\begin{quote}x\\end{quote}", &pol()).0,
            UnitShape::Env("quote".into())
        );
        assert!(reasons("\\SI{2.5}{\\metre} and \\num{3.2e-1} \\si{\\ohm}").is_empty());
        assert!(reasons("\\begin{verbatim}\n\\foo \\bar{\n%x\n\\end{verbatim}").is_empty());
        assert!(
            reasons("\\begin{lstlisting}[language=C]\nint x; /* } */\n\\end{lstlisting}")
                .is_empty()
        );
        // package-gated macros without the package
        let bare = Policy::default();
        assert!(classify_source("\\url{x}", &bare)
            .1
            .contains(&Reason::NeedsPackage("hyperref".into())));
        assert!(classify_source("\\sout{x}", &bare)
            .1
            .contains(&Reason::NeedsPackage("ulem".into())));
        // natbib citations, boxes, counters, setters
        assert!(
            reasons("as \\citep{a} and \\citet[p.~3]{b} say \\citeauthor{a}").is_empty(),
            "{:?}",
            reasons("as \\citep{a} and \\citet[p.~3]{b} say \\citeauthor{a}")
        );
        assert!(reasons(
            "\\fbox{\\parbox{3cm}{x}} \\colorbox{yellow}{y} \\underline{z} \\rule{1cm}{1pt}"
        )
        .is_empty());
        assert!(reasons("\\begin{enumerate}[label=(\\alph*)]\\item a\\end{enumerate}").is_empty());
        let r = reasons("\\begin{table}\\setlength{\\tabcolsep}{2pt}\\renewcommand{\\arraystretch}{1.2}\\begin{tabular}{l}a\\end{tabular}\\end{table}");
        assert!(r.is_empty(), "{r:?}");
        assert!(reasons("\\setlength{\\parindent}{0pt} text")
            .contains(&Reason::SizeDeclarationOutsideGroup("setlength".into())));
    }
    #[test]
    fn balance() {
        assert!(reasons("Unbalanced { brace").contains(&Reason::UnbalancedBraces));
        assert!(reasons("Unbalanced } brace").contains(&Reason::UnbalancedBraces));
        assert!(reasons("Unbalanced $ math").contains(&Reason::UnbalancedMath));
        assert!(reasons("$a { b $ c }").contains(&Reason::UnbalancedMath));
        // a closing delimiter must match its opener (TeX's recovery from a mismatched pair can
        // leave a group open in the live server)
        for mismatched in [
            "$ a \\]",
            "\\[ a $",
            "\\( a \\]",
            "\\[ a \\)",
            "$$ a $",
            "\\begin{equation} a \\]",
            "\\begin{align} a \\]",
            "\\[ a { b \\] }",
        ] {
            assert!(
                reasons(mismatched).contains(&Reason::UnbalancedMath),
                "{mismatched}"
            );
        }
        for balanced in [
            "$a$",
            "$a$$b$",
            "$$ a $$",
            "\\( a \\)",
            "\\[ a \\]",
            "\\[\\]",
            "$\\text{x $y$} z$",
        ] {
            assert!(ok(balanced), "{balanced}: {:?}", reasons(balanced));
        }
        assert!(ok("Escaped \\{ \\} \\$ are fine."));
        assert!(reasons("\\begin{itemize}\\item x").contains(&Reason::UnbalancedEnvironment));
    }
    #[test]
    fn math_vocabulary() {
        assert!(reasons("$\\mycmd{x}$").contains(&Reason::DisallowedMathMacro("mycmd".into())));
        assert!(ok("$\\sum_{i=1}^{n} \\mathbf{v}_i \\cdot \\hat{w}$"));
        assert!(ok("$\\text{for all } x$ and $\\mbox{the \\emph{text}} y$"));
    }

    #[test]
    fn incomplete_math_is_structural_but_does_not_guess_unknown_macro_prefixes() {
        let mut p = pol();
        p.permissive = true;
        for source in [
            r"$\left( x$",
            r"$x \right)$",
            r"$\left$",
            r"$\left( x \right$",
            r"$\frac$",
            r"$\frac{a}$",
            r"$\frac a$",
            r"$\dfrac{a}$",
            r"$\tfrac$",
            r"$\binom{n}$",
            r"$\dbinom n$",
            r"$\tbinom$",
            r"$\cfrac[l]{a}$",
            r"$\sqrt$",
            r"$\sqrt[3]$",
            r"$\sqrt[3$",
            r"$x^$",
            r"$x_ $",
            r"$x'^$",
            r"$x''_ $",
            r"$\frac{x^}{y}$",
            r"$\left(x^\right)$",
            r"\(x_\)",
            r"\[x^\]",
            r"\begin{equation}x_\end{equation}",
            r"\begin{align}x^ & = y\end{align}",
            r"\begin{align}x_ \\ y=z\end{align}",
        ] {
            let reasons = check_source(source, &p);
            assert!(
                reasons.contains(&Reason::IncompleteMath),
                "{source}: {reasons:?}"
            );
        }
        assert_eq!(check_source("$x", &p), vec![Reason::UnbalancedMath]);
        // TeX treats an end-of-line backslash as a control space. The math is unfinished,
        // but no control-word prefix can be inferred without changing those token rules.
        assert_eq!(check_source("$x+\\", &p), vec![Reason::UnbalancedMath]);
        assert_eq!(
            check_source("${x", &p),
            vec![Reason::UnbalancedBraces, Reason::UnbalancedMath]
        );
        // Prefixes of built-ins are still names that a document or package may define.
        for source in [r"$\fr$", r"$\fra$", r"$\lef$", r"$\sqr$", r"$x^\custom$"] {
            assert!(check_source(source, &p).is_empty(), "{source}");
        }
        for reason in [
            Reason::UnbalancedMath,
            Reason::UnbalancedBraces,
            Reason::UnbalancedEnvironment,
            Reason::IncompleteMath,
        ] {
            assert!(reason.is_unfinished());
            assert!(!is_vocabulary_reason(&reason));
        }
        assert!(!Reason::DisallowedMathMacro("fra".into()).is_unfinished());
    }

    #[test]
    fn complete_math_arguments_and_primes_stay_live() {
        for source in [
            r"$\frac12 + \frac{a}b + \frac a{b}$",
            r"$\frac\alpha\beta$",
            r"$\frac{\{a\}}{\{b\}}$",
            "$\\frac{a}% comment\n{b}$",
            r"$\dfrac ab + \tfrac{a}{b}$",
            r"$\binom nk + \dbinom{n}k + \tbinom n{k}$",
            r"$\cfrac[l]{a}{b} + \cfrac{a}{b}$",
            r"$\sqrt x + \sqrt{x} + \sqrt[3]{x} + \sqrt[{a]}]{x}$",
            r"$x^2 + x_2 + x^{} + x_{} + x^{ { } }$",
            r"$x^\prime + x'^2 + x''^2 + x'_i + x'_i{}^2$",
            r"$x^2^3$", // A complete, invalid script remains a live TeX error.
            r"$\left. x\right| + \left\{y\right\}$",
            r"$\left(\left[x\right]\right)$",
            r"$\left({x}\right) + {\left[y\right]}$",
            r"$\left(\text{plain ^ and _ and \$} x\right)$",
            r"$\left(\text{inner $\left[y\right]$} x\right)$",
            r"$\frac{α}{β} + x^𝔸$",
        ] {
            let reasons = reasons(source);
            assert!(reasons.is_empty(), "{source}: {reasons:?}");
        }
        let mut p = pol();
        p.permissive = true;
        for source in [
            r"$\text{\frac{} and \left and ^}$", // Existing vocabulary refusal, no new math reason.
            r"$\left. x\middle|y\right\rangle$",
            r"$\left\customdelim x\right\customdelim$",
            r"$\open x \right)$", // A document macro may provide the literal pair's opener.
            r"$\left( x \close$",
            r"$\custom{\left(x\right)}$",
            r"$\sqrt[\custom]{x}$",
            r"$\ignore{\frac}$",
            r"$\ignore{x^}$",
            r"$\ignore{\left}$",
            r"$\ignore{\sqrt[}$",
        ] {
            assert!(
                check_source(source, &p).is_empty(),
                "{source}: {:?}",
                check_source(source, &p)
            );
        }
    }

    #[test]
    fn trusted_math_macros_can_discard_incomplete_looking_arguments() {
        // Trust establishes vocabulary, not whether TeX expands an apparent incomplete
        // construct in the macro's arguments at all.
        let p = Policy::from_preamble(r"\newcommand{\ignore}[1]{}", &[], &[]);
        for source in [r"$\ignore{\frac}$", r"$\ignore{x^}$", r"$\ignore{\left}$"] {
            assert!(check_source(source, &p).is_empty(), "{source}");
        }
    }

    #[test]
    fn math_fences_do_not_cross_brace_math_text_or_environment_scopes() {
        for source in [
            r"$\left( {x\right)}$",
            r"${\left(x} \right)$",
            r"$\left(x$ $y\right)$",
            r"$\left(\text{inner $y\right)$} x\right)$",
            r"$\left(x\begin{matrix}y\right)\end{matrix}\right)$",
            r"$\left(x\begin{matrix}\left[y\end{matrix}\right)$",
        ] {
            let reasons = reasons(source);
            assert!(
                reasons.contains(&Reason::IncompleteMath),
                "{source}: {reasons:?}"
            );
        }
        assert!(ok(r"$\left(\begin{matrix}a&b\\c&d\end{matrix}\right)$"));
    }
    #[test]
    fn display_math_and_refs() {
        let (shape, r) = classify_source("Text before\n\\[ x = y \\]\ntext after with \\eqref{eq:a} and\n\\begin{equation} a = b \\label{eq:a} \\end{equation}\nand \\begin{align} a &= b \\\\ c &= d \\end{align} done.", &pol());
        assert_eq!(shape, UnitShape::Par);
        assert!(r.is_empty(), "{r:?}");
        assert!(ok(
            "See Section~\\ref{sec:x} on page~\\pageref{sec:x} and \\cite{knuth}."
        ));
        let mut p = pol();
        p.amsmath = false;
        assert!(check_source("\\begin{align} a &= b \\end{align}", &p)
            .contains(&Reason::NeedsPackage("amsmath".into())));
        p.cite_ok = false;
        assert!(
            check_source("See \\cite{k}.", &p).contains(&Reason::DisallowedMacro("cite".into()))
        );
    }
    #[test]
    fn environments() {
        let (shape, r) = classify_source(
            "\\begin{itemize}\n\\item First\n\\item Second with $x$\n\\end{itemize}",
            &pol(),
        );
        assert_eq!(shape, UnitShape::Env("itemize".into()));
        assert!(r.is_empty(), "{r:?}");
        let (shape, r) = classify_source("\\begin{figure}[tbp]\\centering\\includegraphics[width=0.5\\textwidth]{figure.png}\\caption{Figure 1.}\\label{fig:1}\\end{figure}", &pol());
        assert_eq!(shape, UnitShape::Env("figure".into()));
        assert!(r.is_empty(), "{r:?}");
        let (shape, r) = classify_source("\\begin{table}[h]\\centering\\begin{tabular}{lr}\\toprule a & b \\\\ \\midrule 1 & 2 \\\\ \\bottomrule\\end{tabular}\\caption{T}\\end{table}", &pol());
        assert_eq!(shape, UnitShape::Env("table".into()));
        assert!(r.is_empty(), "{r:?}");
        assert!(reasons("\\item outside").contains(&Reason::MacroOutsideContext("item".into())));
        assert!(reasons("\\caption{x}").contains(&Reason::MacroOutsideContext("caption".into())));
        // a paragraph ending in a list is one unit; text after the list is not
        assert!(ok("Intro text:\n\\begin{itemize}\\item a\\end{itemize}"));
        assert!(
            reasons("Intro:\n\\begin{itemize}\\item a\\end{itemize}\nmore text")
                .contains(&Reason::TextAfterEnvironment)
        );
        // blank lines inside a block environment are fine
        assert!(ok("\\begin{quote}\nfirst\n\nsecond\n\\end{quote}"));
        let mut p = pol();
        p.theorem_envs.insert("theorem".into());
        assert_eq!(
            classify_source("\\begin{theorem}\\label{t}Let $x$.\\end{theorem}", &p).0,
            UnitShape::Env("theorem".into())
        );
    }
    #[test]
    fn headings() {
        let (shape, r) = classify_source("\\section{A \\emph{title}}\\label{sec:a}", &pol());
        assert_eq!(shape, UnitShape::Heading("section".into()));
        assert!(r.is_empty(), "{r:?}");
        assert!(reasons("Text \\section{x}").contains(&Reason::DisallowedMacro("section".into())));
    }
    #[test]
    fn counters_and_package_macros() {
        let p = pol();
        assert!(check_source(
            "Text \\stepcounter{foo} and \\setcounter{enumi}{3} \\addtocounter{x}{-1}.",
            &p
        )
        .is_empty());
        // before the first text the command runs before the unit's counters are captured
        assert!(check_source("\\stepcounter{equation}\nText with $x$.", &p)
            .contains(&Reason::LeadingCounter("stepcounter".into())));
        // a lone counter line is a unit of its own (no rows): fine
        assert!(check_source("\\setcounter{section}{3}", &p).is_empty());
        // pol() has hyperref loaded but not caption
        assert!(reasons("\\captionof{figure}{A caption}")
            .contains(&Reason::NeedsPackage("caption".into())));
        assert!(classify_source("\\section{\\texorpdfstring{$x$}{x}}", &p)
            .1
            .is_empty());
        let p0 = Policy::from_preamble("\\documentclass{article}\n", &[], &[]);
        assert!(check_source("\\section{\\texorpdfstring{$x$}{x}}", &p0)
            .contains(&Reason::NeedsPackage("hyperref".into())));
        let p2 = Policy::from_preamble("\\usepackage{caption}\\usepackage{hyperref}\n", &[], &[]);
        assert!(check_source("\\captionof{figure}{A caption}", &p2).is_empty());
        assert!(classify_source("\\section{\\texorpdfstring{$x$}{x}}", &p2)
            .1
            .is_empty());
    }
    #[test]
    fn user_environments() {
        let p = Policy::from_preamble(
            "\\newenvironment{solution}{\\par\\noindent\\textbf{Solution.}\\ \\itshape}{\\par}\n\\newenvironment{hint}[1]{\\begin{quote}\\small\\textbf{#1:}\\ }{\\end{quote}}\n\\newenvironment{bad}{\\tikz{x}}{}\n\\renewenvironment{abstract}{\\small}{\\par}\n",
            &[],
            &[],
        );
        assert!(
            p.user_inner_envs.contains("solution") && p.user_inner_envs.contains("abstract"),
            "inner {:?} block {:?}",
            p.user_inner_envs,
            p.theorem_envs
        );
        assert!(p.theorem_envs.contains("hint"));
        assert!(!p.user_inner_envs.contains("bad") && !p.theorem_envs.contains("bad"));
        let (shape, r) = classify_source("\\begin{solution}\nText.\n\\end{solution}", &p);
        assert!(r.is_empty(), "{r:?}");
        assert_eq!(shape, UnitShape::Par);
        let (shape, r) = classify_source("\\begin{hint}{Idea}\nText.\n\\end{hint}", &p);
        assert!(r.is_empty(), "{r:?}");
        assert_eq!(shape, UnitShape::Env("hint".into()));
        assert!(!check_source("\\begin{bad}x\\end{bad}", &p).is_empty());
    }

    #[test]
    fn local_revision_wrappers_preserve_block_shape_and_require_a_probe() {
        let p = Policy::from_preamble(
            "\\usepackage{xcolor,amsthm}\n\\newenvironment{OLD}{\\color{gray}}{\\ignorespacesafterend}\n\\newenvironment{REV}{\\color[rgb]{0.6,0,0}}{\\ignorespacesafterend}\n",
            &[],
            &[],
        );
        assert!(p.transparent_envs.contains("OLD") && p.transparent_envs.contains("REV"));
        let src = "\\begin{OLD}\n\n\\begin{REV}\n\\begin{proof}\nFirst paragraph.\n\nSecond paragraph.\n\\end{proof}\n\\end{REV}\n\n\\end{OLD}";
        let (shape, reasons) = classify_source(src, &p);
        assert_eq!(shape, UnitShape::Env("proof".into()));
        assert!(reasons.iter().all(is_vocabulary_reason), "{reasons:?}");
        assert!(reasons.contains(&Reason::DisallowedEnvironment("OLD".into())));
        assert!(reasons.contains(&Reason::DisallowedEnvironment("REV".into())));
        // The unchanged complete source, not just the inner proof, is what gets compiled
        // and compared. No unknown wrapper is given structural trust by its name alone.
        let unknown = Policy::from_preamble("\\usepackage{xcolor,amsthm}", &[], &[]);
        assert_eq!(classify_source(src, &unknown).0, UnitShape::Par);
        assert!(classify_source(src, &unknown)
            .1
            .contains(&Reason::ParagraphBreak));
    }

    #[test]
    fn revision_wrapper_recognition_rejects_text_assignments_and_arguments() {
        let p = Policy::from_preamble(
            "\\usepackage{xcolor,amsthm}\n\\newenvironment{captioned}{Text }{}\n\\newenvironment{globalcolor}{\\global\\color{red}}{}\n\\newenvironment{parameterized}[1]{\\color{#1}}{}\n\\newenvironment{dynamic}{\\color{\\mycolor}}{}\n\\newenvironment{localfont}{\\small\\itshape}{\\ignorespacesafterend}\n\\newenvironment{changed}{\\color{red}}{}\n\\renewenvironment{changed}{Text }{}\n\\renewenvironment{proof}{\\small}{}\n",
            &[],
            &[],
        );
        for name in [
            "captioned",
            "globalcolor",
            "parameterized",
            "dynamic",
            "proof",
            "changed",
        ] {
            assert!(!p.transparent_envs.contains(name), "{name}");
        }
        assert!(p.transparent_envs.contains("localfont"));
        let src = "\\begin{localfont}\\begin{proof}Text.\\end{proof}\\end{localfont} after";
        assert_eq!(
            classify_source(src, &p).0,
            UnitShape::Par,
            "trailing text must not be discarded"
        );
        let src = "\\begin{localfont}\\begin{proof}Text.\\end{proof}\\end{localfont}\n\\begin{proof}Other.\\end{proof}";
        assert_eq!(
            classify_source(src, &p).0,
            UnitShape::Par,
            "a second block must not be peeled away"
        );
    }
    #[test]
    fn pictures_and_setup_prefix() {
        let p = pol();
        // an inline picture does not end the paragraph unit
        let (shape, r) = classify_source(
            "Text \\begin{tikzpicture}\\draw (0,0)--(1,0);\\end{tikzpicture} goes on.",
            &p,
        );
        assert_eq!(shape, UnitShape::Par);
        assert!(!r.contains(&Reason::TextAfterEnvironment), "{r:?}");
        assert!(r.contains(&Reason::DisallowedEnvironment("tikzpicture".into())));
        // a block picture followed by text still is
        let (_, r) = classify_source(
            "\\begin{tikzpicture}\\draw (0,0)--(1,0);\\end{tikzpicture}\nText after.",
            &p,
        );
        assert!(r.contains(&Reason::TextAfterEnvironment), "{r:?}");
        // the body of a picture is the environment's business: one reason for the picture,
        // none for its drawing commands (a cached picture is then the unit's only unknown)
        let (shape, r) = classify_source(
            "\\begin{center}\n\\begin{tikzpicture}\n\\begin{axis}[xlabel=$u$]\n\\addplot[blue] {x};\n\\end{axis}\n\\end{tikzpicture}\n\\end{center}",
            &p,
        );
        assert_eq!(shape, UnitShape::Env("center".into()));
        assert_eq!(r, vec![Reason::DisallowedEnvironment("tikzpicture".into())]);
        let (_, r) = classify_source(
            "A plot: \\begin{tikzpicture}\\foo{x}\\end{tikzpicture} and \\bar.",
            &p,
        );
        assert_eq!(
            r,
            vec![
                Reason::DisallowedEnvironment("tikzpicture".into()),
                Reason::DisallowedMacro("bar".into())
            ]
        );
        // an unclosed picture
        assert!(reasons("\\begin{tikzpicture}\\draw;").contains(&Reason::UnbalancedEnvironment));
        assert_eq!(
            skip_env_body("a\\begin{x}b\\end{x}c\\end{x}d", 0, "x"),
            Some(26)
        );
        assert_eq!(skip_env_body("a\\end{x}", 0, "x"), Some(8));
        assert_eq!(skip_env_body("a\\begin{x}", 0, "x"), None);
        // setup statements before a block environment: the unit's shape is the environment
        let (shape, r) = classify_source("\\def\\R{1.2}\n\\begin{center}\nx\n\\end{center}", &p);
        assert_eq!(shape, UnitShape::Env("center".into()));
        assert!(!r.contains(&Reason::SetupStatement), "{r:?}");
        assert_eq!(setup_prefix("\\def\\R{1.2}\n\\begin{center}"), (12, true));
        assert_eq!(setup_prefix("Text \\def\\R{1}"), (0, false));
        assert_eq!(setup_prefix("\\def\\R{1.2"), (0, false));
        assert!(setup_statements("\\def\\R{1.2}\n\\setlength\\parindent{0pt}").is_some());
        assert!(setup_statements("\\def\\R{1.2}\nText").is_none());
    }
    #[test]
    fn title_block_and_symbols() {
        let p = pol();
        let (shape, r) = classify_source("\\title{A Report}\n\\author{Henry Yang \\and A. Reader\\thanks{Supported.}}\n\\date{\\today}\n\\maketitle", &p);
        assert!(r.is_empty(), "{r:?}");
        assert_eq!(shape, UnitShape::Env("center".into()));
        assert!(ok("\\S~3, \\P, \\dag, \\pounds 5, {\\fontsize{10}{12}\\selectfont x}, {\\frenchspacing y.} \\protect\\cite{k}"));
        assert!(reasons("\\frenchspacing x")
            .contains(&Reason::SizeDeclarationOutsideGroup("frenchspacing".into())));
        let p2 = Policy::from_preamble(
            "\\usepackage{xspace,csquotes,mhchem}\n\\newcommand{\\eg}{e.g.\\xspace}\n",
            &[],
            &[],
        );
        assert!(p2.trusted_macros.contains("eg"));
        assert!(check_source("\\enquote{quoted} and \\ce{H2O + CO2} \\eg", &p2).is_empty());
        assert!(!reasons("\\enquote{x}").is_empty());
    }
    #[test]
    fn permissive_keeps_structural_reasons() {
        let mut p = pol();
        p.permissive = true;
        assert!(check_source("Text with \\scalebox{2}{x} and \\foo.", &p).is_empty());
        assert!(check_source("Text {unbalanced", &p).contains(&Reason::UnbalancedBraces));
        assert!(check_source("\\begin{center}x\\end{center} more text", &p)
            .contains(&Reason::TextAfterEnvironment));
        let (_, strict) = classify_source_with("\\foo{x}", &p, false);
        assert!(strict.iter().all(is_vocabulary_reason) && !strict.is_empty());
    }
    #[test]
    fn heading_macros_and_old_font_switches() {
        let p = Policy::from_preamble(
            "\\usepackage{hyperref,graphicx}\n\\newcommand{\\unnumberedsection}[1]{\\section*{#1}\\phantomsection\\addcontentsline{toc}{section}{#1}\\markboth{\\MakeUppercase{#1}}{}}\n",
            &[],
            &[],
        );
        assert_eq!(
            p.heading_macros
                .get("unnumberedsection")
                .map(String::as_str),
            Some("section")
        );
        let (shape, r) = classify_source(
            "\\newpage\n\\unnumberedsection{\\texorpdfstring{0\\quad Premises}{0 Premises}}",
            &p,
        );
        assert!(r.is_empty(), "{r:?}");
        assert_eq!(shape, UnitShape::Heading("section".into()));
        let (shape, r) = classify_source("\\newpage\n\\subsection{After a page break}", &p);
        assert!(r.is_empty(), "{r:?}");
        assert_eq!(shape, UnitShape::Heading("subsection".into()));
        // enumitem's resume continues numbering kept outside the counters
        let r = check_source(
            "Then:\n\\begin{enumerate}[resume]\n  \\item Third\n\\end{enumerate}",
            &p,
        );
        assert!(
            r.contains(&Reason::OutsideState("\\begin{enumerate}[resume]".into())),
            "{r:?}"
        );
        // ... matched as a key of a list's options, not as text in other environments' titles
        let r = check_source(
            "\\begin{enumerate}[label={[\\arabic*]}, resume]\n  \\item x\n\\end{enumerate}",
            &p,
        );
        assert!(
            r.iter().any(|x| matches!(x, Reason::OutsideState(_))),
            "{r:?}"
        );
        let r = check_source(
            "\\begin{enumerate}[label=\\roman*]\n  \\item A series of items\n\\end{enumerate}",
            &p,
        );
        assert!(
            !r.iter().any(|x| matches!(x, Reason::OutsideState(_))),
            "{r:?}"
        );
        let r = check_source(
            "\\begin{quote}[Convergence of the series]\nText.\n\\end{quote}",
            &p,
        );
        assert!(
            !r.iter().any(|x| matches!(x, Reason::OutsideState(_))),
            "{r:?}"
        );
        let mut pl = p.clone();
        pl.list_envs.insert("steps".into());
        let r = check_source("\\begin{steps}[resume*]\n  \\item x\n\\end{steps}", &pl);
        assert!(
            r.iter().any(|x| matches!(x, Reason::OutsideState(_))),
            "{r:?}"
        );
        assert_eq!(optional_arg(" [a={[x]}, b] tail"), Some("a={[x]}, b"));
        // run-in headings share the following paragraph's lines
        let (shape, r) = classify_source("\\paragraph{Run-in.} With text.", &p);
        assert_eq!(shape, UnitShape::Heading("paragraph".into()));
        assert_eq!(r, vec![Reason::RunInHeading("paragraph".into())]);
        let (_, r) = classify_source_with("\\subparagraph{Deeper.} Text.", &p, true);
        assert_eq!(r, vec![Reason::RunInHeading("subparagraph".into())]);
        let r = check_source(
            "Text {\\rm roman} and $\\rm x \\uparrow \\iint$ and \\scalebox{2}{big}",
            &p,
        );
        assert!(r.is_empty(), "{r:?}");
        assert!(check_source("\\rm leaks out", &p)
            .contains(&Reason::SizeDeclarationOutsideGroup("rm".into())));
    }
    #[test]
    fn setup_spans() {
        assert!(setup_statements(
            "\\newcommand{\\kw}[1]{\\textbf{#1}}\n\\renewcommand{\\arraystretch}{1.3}"
        )
        .is_some());
        assert!(setup_statements(
            "\\setlength\\parindent{0pt}\\def\\foo#1{x #1}\\let\\a=\\b\n\\pagestyle{empty}"
        )
        .is_some());
        assert!(setup_statements("\\newcommand{\\kw}{x} Text after it").is_none());
        assert!(setup_statements("Text \\newcommand{\\kw}{x}").is_none());
        assert!(setup_statements("\\setcounter{page}{3}").is_none());
        assert!(setup_statements("\\newcommand{\\kw}{x").is_none());
        let p = pol();
        assert_eq!(
            check_source("\\newcommand{\\kw}[1]{\\textbf{#1}}", &p),
            vec![Reason::SetupStatement]
        );
    }
    #[test]
    fn trusted() {
        let mut p = pol();
        p.trusted_macros.insert("mymacro".into());
        assert!(check_source("\\mymacro{x}", &p).is_empty());
    }
    #[test]
    fn comments_stripped() {
        assert!(ok("Text % \\mymacro{x} in a comment\nmore text"));
        assert!(!ok("Text \\% \\mymacro{x} not a comment"));
    }
    #[test]
    fn preamble_policy() {
        let p = Policy::from_preamble("\\documentclass{book}\n\\usepackage{amsmath,graphicx}\n\\usepackage[backend=biber]{biblatex}\n\\newtheorem{theorem}{Theorem}\n% \\usepackage{booktabs}\n", &[], &[]);
        assert!(p.amsmath && p.graphicx && !p.booktabs && p.cite_ok);
        // user macros: trusted when their bodies are allow-listed, in the mode they classify in
        let p2 = Policy::from_preamble("\\usepackage{amsmath,amssymb}\n\\usepackage[table]{xcolor}\n\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\abs}[1]{\\left\\lvert #1 \\right\\rvert}\n\\newcommand{\\code}[1]{\\texttt{#1}}\n\\newcommand{\\bad}{\\tikz{x}}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}\n\\newcommand{\\absR}[1]{\\abs{#1}\\in\\R}\n", &[], &[]);
        assert!(
            p2.trusted_math.contains("R")
                && p2.trusted_math.contains("abs")
                && p2.trusted_math.contains("argmax")
                && p2.trusted_math.contains("absR"),
            "math {:?} text {:?}",
            p2.trusted_math,
            p2.trusted_macros
        );
        assert!(
            p2.trusted_macros.contains("code")
                && !p2.trusted_macros.contains("bad")
                && !p2.trusted_math.contains("bad")
        );
        assert!(p2.has_package("colortbl"));
        assert!(classify_source("$\\abs{x} \\in \\R$ and \\code{y}", &p2)
            .1
            .is_empty());
        assert!(p.theorem_envs.contains("theorem"));
    }
    #[test]
    fn everypar_patterns() {
        assert!(everypar_allowed(""));
        assert!(everypar_allowed("\\leftprotrusion "));
        assert!(everypar_allowed(
            "{\\setbox \\z@ \\lastbox }\\everypar {}\\@endpefalse "
        ));
        assert!(!everypar_allowed("\\@itemlabel"));
        let mut flags = std::collections::BTreeMap::new();
        flags.insert("ins".to_string(), 1);
        assert!(check_engine_unit("par", "", true, 3, &flags, None).is_empty());
        flags.insert("dir".to_string(), 1);
        assert_eq!(
            check_engine_unit("par", "", true, 3, &flags, None),
            vec![Reason::EngineFlag("dir=1".into())]
        );
    }
    #[test]
    fn ieeetran_lists() {
        let list = "\\begin{IEEEdescription}[\\IEEEusemathlabelsep\\IEEEsetlabelwidth{$\\alpha,\\beta$}]\n\
                    \\item[$\\alpha$] First symbol.\n\\item[$\\beta$] Second symbol.\n\\end{IEEEdescription}";
        let keywords = "\\begin{IEEEkeywords}\nReliability, topology.\n\\end{IEEEkeywords}";
        let ieee = Policy::from_preamble("\\documentclass[journal]{IEEEtran}\n", &[], &[]);
        for (src, env) in [(list, "IEEEdescription"), (keywords, "IEEEkeywords")] {
            let (shape, r) = classify_source(src, &ieee);
            assert_eq!(shape, UnitShape::Env(env.into()));
            assert!(r.is_empty(), "{env}: {r:?}");
        }
        // the label setup commands are the class's own
        let article = Policy::from_preamble("\\documentclass{article}\n", &[], &[]);
        assert_eq!(
            classify_source(list, &article).1,
            vec![Reason::NeedsPackage("IEEEtran".into())]
        );
    }
    #[test]
    fn run_in_headings_from_the_capture() {
        let p = pol();
        let flags = BTreeMap::new();
        // a heading the capture saw set run-in, whatever its name (IEEEtran's \subsubsection)
        assert_eq!(
            check_engine_unit("heading", "", true, 2, &flags, Some("subsubsection")),
            vec![Reason::RunInHeading("subsubsection".into())]
        );
        assert!(check_engine_unit("heading", "", true, 2, &flags, None).is_empty());
        // each heading says so once, whether the source, the capture or both know it is run-in
        for (src, run_in, name) in [
            (
                "\\subsubsection{Paths}",
                Some("subsubsection"),
                "subsubsection",
            ),
            ("\\paragraph{Paths.}", Some("paragraph"), "paragraph"),
            ("\\paragraph{Paths.}", None, "paragraph"),
        ] {
            let mut r = classify_source(src, &p).1;
            r.extend(check_engine_unit("heading", "", true, 2, &flags, run_in));
            assert_eq!(
                r,
                vec![Reason::RunInHeading(name.into())],
                "{src} {run_in:?}"
            );
        }
    }

    #[test]
    fn blank_lines_before_a_headings_first_body_are_vertical_material() {
        assert!(!reasons("\\subsection{Title}\n\nFirst paragraph.").contains(&Reason::ParagraphBreak));
        assert!(!reasons("\\subsection{Title}\n\n\\label{sec:test}\nFirst paragraph.").contains(&Reason::ParagraphBreak));
        assert!(reasons("\\subsection{Title}\nFirst paragraph.\n\nSecond paragraph.").contains(&Reason::ParagraphBreak));
    }
}
