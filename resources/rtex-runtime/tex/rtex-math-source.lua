-- Mark explicit alignment cells before amsmath collects/replays their tokens. Attribute
-- assignments create no nodes; uncertain syntax keeps the ordinary block anchors.
local M = { rows = {}, states = {}, next_id = 0 }
local supported = {}
for name in ("align align* alignat alignat* flalign flalign* gather gather* multline multline* aligned alignedat gathered split eqnarray eqnarray*"):gmatch("%S+") do supported[name] = true end
local opaque = { Verbatim = true, verbatim = true, ["verbatim*"] = true, lstlisting = true, minted = true }
local function generates_rows(name, seen, depth)
  if name == "label" then return false end
  if not token or not token.get_macro then return false end
  if name == "csname" or name == "cr" or name == "crcr" then return true end
  if seen[name] then return false end
  seen[name] = true
  local body = token.get_macro(name)
  if not body then return false end
  if depth == 0 or #body > 16384 then return true end
  if body:find("\\\\", 1, true) or body:find("\\begin%s*{") then return true end
  for child in body:gmatch("\\([%a@]+)") do
    if generates_rows(child, seen, depth - 1) then return true end
  end
  return false
end
local function column(s, p)
  local n = 0
  for _, c in utf8.codes(s:sub(1, p - 1)) do n = n + (c > 0xffff and 2 or 1) end
  return n
end
local function finish(row, line, col)
  if row then row.end_line, row.end_column = line, col end
end
local function new_row(st, line, col)
  local row = { tag = st.tag, line = line, start_column = col }
  M.next_id = M.next_id + 1
  row.id = M.next_id
  M.rows[row.id] = row
  return row
end
function M.new_state(tag, active)
  return { tag = tag, active = active, depth = 0, stack = {} }
end
function M.buffer(st, s, line)
  -- shortcut: multi-line optional arguments keep block sync for this input; add a
  -- token-aware argument reader if precise rows are needed for that syntax.
  if st.suspended then return s end
  if not utf8.len(s) then
    for _, env in ipairs(st.stack) do if env.row then env.row.invalid = true end end
    return s
  end
  local out, last, p = {}, 1, 1
  local function insert(at, row)
    out[#out + 1] = s:sub(last, at - 1)
    out[#out + 1] = "\\directlua{rtex_math_source.mark(" .. row.id .. ")}"
    last = at
  end
  while p <= #s do
    local top = st.stack[#st.stack]
    local c = s:sub(p, p)
    if st.skip then
      local _, q = s:find("\\end%s*{" .. st.skip:gsub("([^%w])", "%%%1") .. "}", p)
      if not q then break end
      st.skip, p = nil, q + 1
    elseif c == "%" then break
    elseif c:match("%s") then p = p + 1
    else
      local command, q
      if c == "\\" then
        command, q = s:match("^\\([%a@]+)()", p)
        if not command then command, q = s:sub(p + 1, p + 1), p + 2 end
      end
      local env, env_end
      if command == "begin" or command == "end" then
        env, env_end = s:match("^\\[%a]+%s*{([%w*@]+)}()", p)
      end
      if top and top.row and (top.option or top.count or top.break_star or top.break_option) then
        if top.option then
          top.option = nil
          if c == "[" then
            local stop = s:match("^%b[]()", p)
            if not stop then st.suspended = true; top.row.invalid = true; break end
            p = stop; top.row.start_column = column(s, p); top.row.line = line
            goto continue
          end
        end
        if top.count then
          top.count = nil
          local stop = c == "{" and s:match("^%b{}()", p)
          if not stop then st.suspended = true; top.row.invalid = true; break end
          p = stop; top.row.start_column = column(s, p); top.row.line = line
          goto continue
        end
        if top.break_star then
          top.break_star = nil
          if c == "*" then p = p + 1; goto continue end
        end
        if top.break_option then
          top.break_option = nil
          if c == "[" then
            local stop = s:match("^%b[]()", p)
            if not stop then st.suspended = true; top.row.invalid = true; break end
            p = stop; top.row.start_column = column(s, p); top.row.line = line
            goto continue
          end
        end
      end
      local cs = command and token and token.create and token.create(command)
      local meaning = cs and cs.cmdname
      if command == "catcode" or (st.active and (meaning == "if_test" or meaning == "fi_or_else")) then
        for _, env in ipairs(st.stack) do if env.row then env.row.invalid = true end end
        st.suspended = true
        break
      end
      if command == "begin" and env == "document" then st.active = true end
      if command == "begin" and opaque[env] then
        st.skip, p = env, env_end
      elseif command == "verb" then
        local v = q
        if s:sub(v, v) == "*" then v = v + 1 end
        local close = s:find(s:sub(v, v), v + 1, true)
        p = close and close + 1 or #s + 1
      elseif command == "end" and top and env == top.name then
        finish(top.row, line, column(s, p))
        table.remove(st.stack)
        p = env_end
      elseif command == "begin" and supported[env] and st.active and st.depth == (top and top.depth or 0) then
        if top and top.row and top.pending then insert(p, top.row); top.pending = false end
        local row = new_row(st, line, column(s, env_end))
        st.stack[#st.stack + 1] = { name = env, depth = st.depth, row = row, pending = true,
          option = env == "aligned" or env == "alignedat" or env == "gathered",
          count = env == "alignedat" or env == "alignat" or env == "alignat*" }
        p = env_end
      elseif top and top.row and st.depth == top.depth and command == "\\" then
        local stop = q
        if s:sub(stop, stop) == "*" then stop = stop + 1 end
        local spaces, opt = s:match("^(%s*)(%b[])()", stop)
        if opt then stop = stop + #spaces + #opt end
        finish(top.row, line, column(s, stop))
        top.row, top.pending = new_row(st, line, column(s, stop)), true
        top.break_star, top.break_option = true, true
        p = stop
      elseif top and top.row and st.depth == top.depth and c == "&" then
        top.pending = true
        p = p + 1
      else
        if top and top.row and top.pending then insert(p, top.row); top.pending = false end
        if c == "{" then st.depth = st.depth + 1 elseif c == "}" then st.depth = math.max(0, st.depth - 1) end
        -- An opaque nested environment can contain its own &, \\ and braces.
        if top and top.row and command and
          (command == "intertext" or command == "shortintertext" or generates_rows(command, {}, 8)) then top.row.invalid = true end
        if command == "begin" and env then
          st.stack[#st.stack + 1] = { name = env, depth = st.depth, row = nil }
        end
        p = env_end or q or p + 1
      end
    end
    ::continue::
  end
  out[#out + 1] = s:sub(last)
  return table.concat(out)
end
function M.input(s, tag, line)
  local st = M.states[tag]
  if not st or line <= (st.last_line or 0) then st = M.new_state(tag, M.active); M.states[tag] = st end
  st.last_line = line
  return M.buffer(st, s, line)
end
function M.lines(lines, tag, first)
  M.rows = {}
  local st, result = M.new_state(tag, true), {}
  for i, line in ipairs(lines) do result[i] = M.buffer(st, line, first + i - 1) end
  return result
end
return M
