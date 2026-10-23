-- texlua tex/tests/run.lua : unit tests for the Lua side that need no TeX run.
package.path = "tex/?.lua;" .. package.path
local failures = 0
local function check(name, cond, detail)
  if cond then print("ok   " .. name) else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- JSON round trip
local json = dofile("tex/rtex-json.lua")
local v = { a = 1, b = { 1, 2, 3 }, c = "x\"y\\z\n", d = true, e = 2.5, f = {} }
local s = json.encode(v)
local back = json.decode(s)
check("json roundtrip scalars", back.a == 1 and back.c == v.c and back.d == true and back.e == 2.5)
check("json roundtrip arrays", #back.b == 3 and back.b[3] == 3)
check("json decode unicode escape", json.decode('"\\u00e9\\ud83d\\ude00"') == "é😀")
check("json decode nested", json.decode('{"x":[{"y":null},{"y":-3e2}]}').x[2].y == -300)

-- rtex-dl arithmetic (stub the node library enough to load the module)
node = node or {}
node.types = node.types or function() return { [0] = "hlist", [1] = "vlist", [2] = "rule", [29] = "glyph", [12] = "glue", [13] = "kern", [28] = "margin_kern", [7] = "disc", [11] = "math", [8] = "whatsit", [14] = "penalty", [9] = "local_par", [10] = "dir", [3] = "ins", [4] = "mark", [5] = "adjust", [6] = "boundary" } end
node.whatsits = node.whatsits or function() return { [0] = "open", [1] = "write", [2] = "close", [8] = "late_lua", [22] = "pdf_literal", [28] = "pdf_colorstack", [3] = "special", [6] = "save_pos", [7] = "user_defined", [29] = "pdf_setmatrix", [30] = "pdf_save", [31] = "pdf_restore" } end
node.subtypes = node.subtypes or function() return { [0] = "normal", [1] = "box", [2] = "image", [3] = "empty", [4] = "user", [9] = "outline" } end
-- direct nodes are plain tables, enough to walk boxes of whatsits
local function field(k) return function(n) return n[k] end end
local function dim(k) return function(n) return n[k] or 0 end end
node.direct = node.direct or setmetatable({
  todirect = function(n) return n end, getid = field("id"), getnext = field("next"),
  getlist = field("list"), getsubtype = field("subtype"), getfield = function(n, k) return n[k] end,
  getwidth = dim("width"), getshift = dim("shift"),
  getwhd = function(n) return n.width or 0, n.height or 0, n.depth or 0 end,
}, { __index = function() return function() end end })
node.type = node.type or function(id) return node.types()[id] end
font = font or { getfont = function() return nil end }
tex = tex or { hoffset = 0, voffset = 0, pagewidth = 0, pageheight = 0 }
kpse = { find_file = function(name) return "tex/" .. name end }
local dl = dofile("tex/rtex-dl.lua")
check("tex_round positive", dl.tex_round(2.5) == 3 and dl.tex_round(2.4999) == 2)
check("tex_round negative", dl.tex_round(-2.5) == -3 and dl.tex_round(-2.4999) == -2)
-- round_xn_over_d against exact rational rounding
local function ref(x, n, d) local q = x * n / d; return q >= 0 and math.floor(q + 0.5) or -math.floor(-q + 0.5) end
local okc = true
for _, c in ipairs{ {431102, 1020000, 1000000}, {431102, 980000, 1000000}, {705419, 983000, 1000000}, {123456789, 1001000, 1000000}, {-358810, 1017000, 1000000}, {1, 1, 3}, {2, 1, 4} } do
  local a, b = dl.round_xn_over_d(c[1], c[2], c[3]), ref(c[1], c[2], c[3])
  if a ~= b then okc = false; print("  mismatch", c[1], c[2], c[3], a, b) end
end
check("round_xn_over_d matches exact rounding", okc)
-- expansion formula: ef in millionths, 2% stretch of 431102 sp
check("expansion 2%", dl.round_xn_over_d(431102, 1020000, 1000000) == 439724)

-- specials: LuaTeX's PDF backend draws only those starting with "pdf:" or "PDF:" and ignores
-- the rest ("Non-PDF special ignored!"), so only those make the display list inexact
local function special(data) return { id = 8, subtype = 3, data = data } end
local function special_flags(data)
  local in_row = dl.paragraph({ id = 1, list = { id = 0, list = special(data) } }).flags.special
  local in_vlist = dl.paragraph({ id = 1, list = special(data) }).flags.special
  return in_row, in_vlist
end
for _, data in ipairs{ "papersize=597.50787pt,845.04684pt", "Pdf: 0 0 m", " pdf: 0 0 m", "pdf", "color push gray 0" } do
  local a, b = special_flags(data)
  check("ignored special not flagged: " .. data, a == nil and b == nil, tostring(a) .. " " .. tostring(b))
end
for _, data in ipairs{ "pdf: 0 0 m 1 1 l S", "PDF:direct:0 0 m", "pdf:" } do
  local a, b = special_flags(data)
  check("pdf special flagged: " .. data, a == 1 and b == 1, tostring(a) .. " " .. tostring(b))
end

-- Math conversion locations survive nested boxes and tag-0 live replay, without
-- changing the node list or attributing unrelated prose/invalid input locations.
local callbacks, attributes = {}, {}
luatexbase = {
  new_attribute = function(name) local id = #attributes + 1; attributes[id] = name; return id end,
  add_to_callback = function(name, fn) callbacks[name] = fn end,
}
node.traverse = function(head)
  local n
  return function() if n then n = n.next else n = head; head = nil end; return n end
end
node.set_attribute = function(n, id, value) n.attributes = n.attributes or {}; n.attributes[id] = value end
tex.get_synctex_tag = function() return 0 end
tex.inputlineno = 9
dl.enable_math_source_sync()
local nested = { id = 29 }
local first = { id = 29, next = { id = 0, head = { id = 1, head = nested } } }
local callback = callbacks.post_mlist_to_hlist_filter
check("math source callback preserves the node list", callback(first) == first)
check("math glyph source includes tag-0 replay and nested fractions",
  first.attributes[1] == 0 and first.attributes[2] == 9 and nested.attributes[1] == 0 and nested.attributes[2] == 9)
local prose = { id = 29 }
check("unconverted prose has no math source", prose.attributes == nil)
tex.inputlineno = 0
callback(prose)
check("invalid math source line is not captured", prose.attributes == nil)
dl.enable_math_source_sync()
check("math source callback installs once", #attributes == 3 and callbacks.post_mlist_to_hlist_filter == callback)

-- Explicit source rows are marked per cell, not per physical line or conversion order.
local ms = dofile("tex/rtex-math-source.lua")
local lines = ms.lines({
  "\\begin{align}",
  " a &= b \\\\ c &= d \\\\* [2pt]",
  " e &= \\frac{f}",
  " {g}",
  "\\end{align}",
}, 0, 2)
check("row markers enter every explicit cell", select(2, lines[2]:gsub("rtex_math_source.mark", "")) == 4)
check("continued source lines do not interrupt macro arguments", lines[4] == " {g}")
check("same-line row ranges meet at the separator", ms.rows[1].end_column == ms.rows[2].start_column and ms.rows[1].end_column == 10)
check("multi-line row range spans continuation and excludes closing environment", ms.rows[3].line == 3 and ms.rows[3].end_line == 6 and ms.rows[3].end_column == 0)
ms.next_id = 0
local unicode = ms.lines({ "\\begin{aligned}α&=β\\\\ z&=w\\end{aligned}" }, 0, 2)
check("source columns count UTF-16 rather than UTF-8 bytes", ms.rows[1].end_column == 21 and ms.rows[2].start_column == 21)
ms.next_id = 0
local nested_lines = ms.lines({ "\\begin{aligned}a&=b\\\\ &\\begin{aligned}c&=d\\\\ e&=f\\end{aligned}\\end{aligned}" }, 0, 2)
check("nested rows retain separate ids and ranges", #ms.rows == 4 and ms.rows[3].end_column == ms.rows[4].start_column and ms.rows[4].end_column < ms.rows[2].end_column)
local plain = "\\newcommand{\\demo}{\\begin{align}a&=b\\\\ c&=d\\end{align}}"
check("macro definitions are left untouched", ms.lines({ plain }, 0, 2)[1] == plain and #ms.rows == 0)
local verb = "\\verb|\\begin{align}a&=b|"
check("verbatim source is left untouched", ms.lines({ verb }, 0, 2)[1] == verb and #ms.rows == 0)
local fancy = { "\\begin{Verbatim}", "\\begin{align} a&=b \\\\ c&=d \\end{align}", "\\end{Verbatim}" }
local literal = ms.lines(fancy, 0, 2)
check("fancyvrb Verbatim leaves literal math source untouched", literal[1] == fancy[1] and literal[2] == fancy[2] and literal[3] == fancy[3] and #ms.rows == 0)

local saved_token = token
token = { get_macro = function(name) if name == "rows" then return "a=b\\\\ c=d" end end }
ms.next_id = 0
ms.lines({ "\\begin{align}\\rows\\end{align}" }, 0, 2)
check("macros generating rows have no precise source range", ms.rows[1].invalid)
token = saved_token

ms.next_id = 0
local counted = ms.lines({ "\\begin{alignat}{2}a&=b\\\\ c&=d\\end{alignat}" }, 0, 2)
check("alignat arguments stay ahead of source attributes", counted[1]:find("{2}\\directlua", 1, true) ~= nil)
ms.next_id = 0
local optional = ms.lines({ "\\begin{aligned}[t]a&=b\\\\", "[1ex] c&=d\\end{aligned}" }, 0, 2)
check("optional alignment and cross-line spacing arguments are not interrupted", optional[1]:find("[t]\\directlua", 1, true) ~= nil and optional[2]:find("[1ex] \\directlua", 1, true) ~= nil)
local last_id = ms.next_id
ms.lines({ "\\begin{align}x&=y\\end{align}" }, 0, 2)
check("replay source ids cannot collide with cached boxes", ms.next_id > last_id and ms.rows[last_id] == nil)

local conditional_token = token
token = { create = function(name) return { cmdname = (name == "iftrue" or name == "iffalse") and "if_test" or "call" } end }
ms.next_id = 0
local branches = ms.lines({ "\\begin{align}a&=b\\\\", "\\iftrue x&=x\\\\", "\\else y&=y\\\\", "\\fi z&=z\\end{align}" }, 0, 2)
check("structural conditionals suspend precise rows instead of attributing skipped branches", branches[2] == "\\iftrue x&=x\\\\" and branches[3] == "\\else y&=y\\\\" and ms.rows[2].invalid)
ms.next_id = 0
local iff = ms.lines({ "\\begin{align}a&\\iff b\\\\ c&=d\\end{align}" }, 0, 2)
check("the iff math symbol retains precise row sync", not ms.rows[1].invalid and ms.rows[2].end_line == 2 and iff[1]:find("\\iff", 1, true) ~= nil)
token = conditional_token

if failures > 0 then print(failures .. " failure(s)"); os.exit(1) else print("all Lua tests passed") end
