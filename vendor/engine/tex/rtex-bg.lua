-- rtex-bg.lua: standby background pass. The driver has loaded the document's preamble; block
-- here until the host writes "GO" on stdin (the body snapshot is complete), then return so
-- \input{main.tex} typesets the body. Anything else (EOF, "QUIT") ends the process quietly.
-- Tell the host the preamble reached this point before it sends GO. An earlier TeX error
-- prompt could otherwise consume GO as recovery input.
local ready = os.getenv("RTEX_BG_READY")
if ready then
  local f = assert(io.open(ready, "w"))
  f:write("READY\n")
  f:close()
end
local line = io.read("l")
if line ~= "GO" then os.exit(0) end
