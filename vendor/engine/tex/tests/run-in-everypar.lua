-- texlua tex/tests/run-in-everypar.lua (run from vendor/engine; no TeX run needed).
local prefix = "\\if@noskipsec \\global \\@noskipsecfalse {\\setbox \\z@ \\lastbox }\\clubpenalty \\@M \\begingroup \\@svsechd \\endgroup \\unskip \\@tempskipa "
local suffix = "\\relax \\hskip -\\@tempskipa \\else \\clubpenalty \\@clubpenalty \\everypar {}\\fi "
local canonical = "\\clubpenalty \\@clubpenalty \\everypar {}"
local function capture(ep, pending, kind)
  local state = { ep = ep, pending = pending }
  local env = setmetatable({
    dofile = function() return {} end,
    kpse = { find_file = function(name) return name end },
    os = { getenv = function() return nil end },
    status = { filename = "synthetic.tex" },
    tex = {
      inputlineno = 1, nest = { ptr = kind == "par" and 1 or 0 },
      get = function() return 0 end, getglue = function() return 0, 0, 0, 0, 0 end,
      gettoks = function() return state.ep end, setattribute = function() end,
    },
    token = {
      create = function(name) return { cmdname = "if_test", mode =
        (name == "iftrue" or name == "if@noskipsec" and state.pending) and 1 or 0 } end,
      get_macro = function() return nil end,
    },
    font = { current = function() return 1 end },
    luatexbase = { new_attribute = function() return 1 end },
    node = { traverse = function() return function() return nil end end },
  }, { __index = _G })
  local c = assert(loadfile("tex/rtex-capture.lua", "t", env))()
  if kind == "par" then c.parbegin() else c.heading("subsection") end
  return c, env, state
end
local function unit(ep, pending)
  return capture(ep, pending, "heading").units[1].everypar
end
local raw = prefix .. "-.5em" .. suffix
assert(unit(raw, false) == canonical, "exhausted literal run-in context must replay only its false branch")
assert(unit(raw, true) == raw, "pending run-in context must retain its rejection")
for _, dim in ipairs({ "-1em", "-.25ex", "-12pt", "0pt", "1.5cm" }) do
  assert(unit(prefix .. dim .. suffix, false) == canonical, dim)
end
for _, dim in ipairs({ "\\customskip", "-\\fontdimen 2\\font ", "1junk", "\\fi \\evil \\iftrue ", "1pt plus 1pt" }) do
  local ep = prefix .. dim .. suffix
  assert(unit(ep, false) == ep, "unknown dimension tokens must remain rejected: " .. dim)
end
for _, ep in ipairs({ "", "\\customhook ", raw .. "\\evil ", (raw:gsub("\\unskip ", "\\evil ")) }) do
  assert(unit(ep, false) == ep, "only the complete known kernel template may normalize")
end
for _, edge in ipairs({ { "\\leftprotrusion ", "" }, { "", "\\leftprotrusion " }, { "\\leftprotrusion ", "\\leftprotrusion " } }) do
  assert(unit(edge[1] .. raw .. edge[2], false) == edge[1] .. canonical .. edge[2])
end
local ordinary = capture(raw, false, "par")
ordinary.pre_linebreak(nil, "")
assert(ordinary.units[1].everypar == canonical and ordinary.paras[1].everypar == canonical,
  "standalone paragraph unit and legacy context must agree")
local heading, env, state = capture(raw, false, "heading")
state.pending = true
env.tex.nest.ptr = 1
heading.parbegin()
state.pending = false
heading.pre_linebreak(nil, "")
assert(heading.paras[1].everypar == raw, "heading-owned paragraph cannot replay without its title")
local inserted, insenv, insstate = capture(raw, false, "heading")
insstate.pending, insenv.tex.nest.ptr = true, 1
inserted.parbegin()
inserted.heading("subsection")
assert(inserted.cur.uid == 1 and inserted.pending_heading == "subsection",
  "heading insertion must leave the preceding run-in paragraph open until its linebreak")
inserted.pre_linebreak(nil, "")
assert(inserted.paras[1].unit == 1, "preceding paragraph rows belong to the preceding heading")
insenv.tex.nest.ptr = 0
inserted.parafter()
assert(inserted.cur.uid == 2 and inserted.pending_heading == nil, "paragraph end opens the inserted heading")
insenv.tex.nest.ptr = 1
inserted.parbegin()
insstate.pending = false
inserted.pre_linebreak(nil, "")
assert(inserted.paras[2].unit == 2, "inserted heading owns only its own title and first paragraph")
print("all run-in everypar tests passed")
