vim.opt.runtimepath:append(vim.fn.getcwd())
vim.o.columns, vim.o.lines = 120, 40
local source, previous = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_lines(source, 0, -1, false, { 'Unsent draft λ 世界' })
local tick = vim.api.nvim_buf_get_changedtick(source)
local directory = vim.fn.tempname()
vim.fn.mkdir(directory, 'p')
local url = 'https://login.example.test/auth?state=' .. string.rep('abc123', 100) .. '&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback'
vim.fn.writefile(vim.split([[
import base64, os, sys, tty
tty.setraw(0)
def link(identity, value):
    os.write(1, ('\x1b]8;id='+identity+';'+value+'\x1b\\'+value+'\x1b]8;;\x1b\\\r\n').encode())
link('harness-login', sys.argv[1])
link('another-program', 'https://wrong.example.test')
link('harness-login', 'javascript:wrong')
os.write(1, b'Enter a value.\r\n')
while True:
    value = os.read(0, 1)
    if value == b'\x03': sys.exit(130)
    if value == b's': sys.exit(0)
    if value == b'c':
        link('harness-code-' + base64.b64encode(b'TEST-CODE').decode(), sys.argv[1])
        os.write(1, b'Device code ready.\r\n')
    if value == b'f':
        os.write(1, b'Login failed in test.\r\n')
        sys.exit(2)
]], '\n', { plain = true }), directory .. '/terminal.py')
local copied, opened, calls, result, messages, copy_failed = nil, nil, 0, nil, {}, false
vim.g.clipboard = { name = 'test clipboard', copy = { ['+'] = function(lines) if not copy_failed then copied = table.concat(lines, '\n') end end, ['*'] = function() end },
  paste = { ['+'] = function() return { {}, 'v' } end, ['*'] = function() return { {}, 'v' } end } }
local ui_open = vim.ui.open
vim.ui.open = function(value) opened = value; return {} end
local setup = require('harness.setup').new({
  arguments = function() return { 'python3', '-u', directory .. '/terminal.py', url } end,
  connect = function(callback) callback(true) end,
}, function(message) messages[#messages + 1] = message end)
local function wait(predicate, message) assert(vim.wait(3000, predicate, 5), message) end
local function keys(value)
  vim.cmd('stopinsert')
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(value, true, false, true), 'xt', false)
  vim.wait(10)
end
local window, buffer, channel
local function open()
  calls, result = 0, nil
  setup.open({ id = 'test', name = 'Test provider' }, { id = 'oauth', name = 'Test account' }, function(focused, succeeded)
    calls = calls + 1
    result = { focused = focused, succeeded = succeeded }
  end)
  window, buffer = setup.window, setup.buffer
  channel = vim.bo[buffer].channel
  wait(function() return vim.wo[window].winbar:find('Copy', 1, true) end, 'A real terminal OSC8 link enables the visible controls')
end
local function closed()
  wait(function() return calls == 1 end, 'Login completion callback')
  assert(not vim.api.nvim_win_is_valid(window) and not vim.api.nvim_buf_is_valid(buffer), 'Login owns no window or terminal after closing')
  assert(vim.api.nvim_buf_get_changedtick(source) == tick, 'Login does not change the caller draft')
  vim.wait(20)
  assert(calls == 1, 'Closing and child exit cannot call completion twice')
end
open()
local controls = vim.api.nvim_eval_statusline(vim.wo[window].winbar, { winid = window, use_winbar = true }).str
assert(controls:find('Open browser', 1, true) < controls:find('Copy link', 1, true)
  and controls:find('Full link', 1, true) and controls:find('Cancel', 1, true),
  'The first visible action opens the browser; copying is optional')
assert(vim.inspect(vim.api.nvim_win_get_config(window).footer):find('Keep this window open', 1, true),
  'Browser login tells the user to keep the callback window open')
keys('<C-x>')
assert(copied == url and vim.api.nvim_get_current_buf() == buffer, 'Copy uses the complete fixed-id URL through the native clipboard')
keys('<C-o>')
assert(opened == url, 'Open passes the complete URL to the client browser handler')
assert(calls == 0 and vim.fn.jobwait({ channel }, 0)[1] == -1, 'Opening the browser keeps the same login process active')
local getmousepos = vim.fn.getmousepos
local function click(row, column)
  opened = nil
  vim.fn.getmousepos = function() return { winid = window, winrow = row + 2, line = row, column = column } end
  keys('<LeftRelease>')
  vim.fn.getmousepos = getmousepos
end
vim.api.nvim_exec_autocmds('TermRequest', { buffer = buffer,
  data = { sequence = '\027]8;id=harness-login;' .. url:sub(1, 100) .. 'changed' .. url:sub(108) } })
click(1, 2)
assert(opened == nil, 'An earlier URL with a matching first row but a different later state cannot open the new login')
vim.api.nvim_exec_autocmds('TermRequest', { buffer = buffer, data = { sequence = '\027]8;id=harness-login;' .. url } })
for _, width in ipairs({ 76, 38 }) do
  vim.api.nvim_win_set_width(window, width)
  wait(function()
    return #vim.api.nvim_buf_get_lines(buffer, 0, 1, false)[1] <= width
  end, 'The actual terminal completes its width change')
  local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
  local last
  for row, line in ipairs(lines) do if line == 'https://wrong.example.test' then last = row - 1; break end end
  assert(last and (width == 76 and last > 2 or width == 38 and last == 1),
    'The child prints a wrapped URL; narrowing this terminal discards its continuation rows')
  for row = 1, last do
    click(row, math.min(2, #lines[row]))
    assert(opened == url, 'Every wrapped part opens the exact retained login URL')
  end
  click(last + 1, 2)
  assert(opened == nil, 'A different printed URL cannot open the retained login link')
  click(last, #lines[last] + 1)
  assert(opened == nil, 'Clicking after the URL text does not open it')
end
vim.api.nvim_win_set_width(window, 76)
copy_failed, copied = true, nil
keys('<C-x>')
assert(copied == nil and vim.inspect(vim.api.nvim_win_get_config(window).footer):find('Copy requested', 1, true),
  'An asynchronous clipboard failure must not be reported as a confirmed copy')
keys('<C-l>')
assert(vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] == url and vim.fn.getreg() == url,
  'The complete selectable link stays available when a configured clipboard does not deliver')
assert(vim.wo[window].winbar:find('Open browser', 1, true) and vim.wo[window].winbar:find('Cancel', 1, true),
  'The selectable link retains the visible browser and cancellation controls')
keys('<CR>')
assert(vim.wo[window].winbar:find('Open browser', 1, true), 'Returning to terminal input retains the browser control')
keys('<C-l>')
vim.o.columns, vim.o.lines = 50, 16
vim.api.nvim_exec_autocmds('VimResized', {})
setup.open({ id = 'test', name = 'Test provider' }, { id = 'oauth', name = 'Test account' }, function() error('Login was replaced') end)
local reopened = vim.api.nvim_eval_statusline(vim.wo[window].winbar, { winid = window, use_winbar = true, maxwidth = 1000 }).str
assert(setup.window == window and vim.api.nvim_get_current_buf() == buffer and vim.bo[buffer].channel == channel,
  'Opening login again returns to the same private input, window and process')
assert(reopened:find('Open', 1, true) and reopened:find('Cancel', 1, true)
  and vim.fn.strdisplaywidth(reopened) <= vim.api.nvim_win_get_width(window),
  'Returning from a resized Full link view retains visible controls that fit')
copy_failed = false
for _, size in ipairs({ { 50, 16 }, { 30, 12 }, { 120, 40 } }) do
  vim.o.columns, vim.o.lines = size[1], size[2]
  vim.api.nvim_exec_autocmds('VimResized', {})
  local config = vim.api.nvim_win_get_config(window)
  assert(config.col + config.width + 2 <= size[1] and config.row + config.height + 2 <= size[2], 'Login fits the resized terminal')
  local bar = vim.api.nvim_eval_statusline(vim.wo[window].winbar, { winid = window, use_winbar = true, maxwidth = 1000 }).str
  assert(vim.fn.strdisplaywidth(bar) <= config.width and bar:find('Copy') and bar:find('Open')
    and (bar:find('Cancel') or bar:find('^C', 1, true)),
    'Copy, browser and cancellation controls remain visible on a narrow screen')
  assert(vim.inspect(config.footer):find('Keep', 1, true), 'The waiting instruction remains visible after resizing')
end
keys('v<Esc>')
assert(calls == 0 and vim.fn.jobwait({ channel }, 0)[1] == -1, 'Visual Escape keeps the login process active')
keys('<Esc>')
assert(calls == 0 and vim.fn.jobwait({ channel }, 0)[1] == -1, 'Normal Escape keeps the login process active')
keys('v<C-c>')
closed()
assert(result.focused and not result.succeeded and vim.api.nvim_get_current_win() == previous, 'Visual-mode Ctrl-C cancels back to the caller')
open()
vim.g.loaded_clipboard_provider = 0
local list_uis, ui_send, clipboard_request = vim.api.nvim_list_uis, vim.api.nvim_ui_send
vim.api.nvim_list_uis = function() return { {} } end
vim.api.nvim_ui_send = function(value) clipboard_request = value end
keys('<C-x>')
local encoded = assert(clipboard_request:match('^\027%]52;c;(.+)\027\\$'), 'A terminal UI receives a native clipboard request')
assert(vim.base64.decode(encoded) == url and vim.api.nvim_get_current_buf() == buffer,
  'The bundled clipboard provider sends the complete login link without user configuration')
clipboard_request = nil
vim.fn.chansend(channel, 'c')
wait(function()
  return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n'):find('Device code ready.', 1, true)
end, 'The actual private terminal shows a device code')
assert(clipboard_request == nil, 'Showing a device code does not change the clipboard')
keys('<C-y>')
assert(vim.base64.decode(assert(clipboard_request:match('^\027%]52;c;(.+)\027\\$'))) == 'TEST-CODE',
  'A device code uses the bundled clipboard writer when no provider is configured')
for _, payload in ipairs({ 'not base64', 'A', string.rep('A', 1372), vim.base64.encode('control\ncode'), vim.base64.encode('\194\128') }) do
  vim.api.nvim_exec_autocmds('TermRequest', { buffer = buffer, data = { sequence = '\027]8;id=harness-code-' .. payload .. ';' .. url } })
end
vim.api.nvim_exec_autocmds('TermRequest', { buffer = buffer,
  data = { sequence = '\027]8;id=harness-code-' .. vim.base64.encode('WRONG-CODE') .. ';https://wrong.example.test' } })
keys('<C-y>')
assert(vim.base64.decode(assert(clipboard_request:match('^\027%]52;c;(.+)\027\\$'))) == 'TEST-CODE',
  'Invalid, oversized, control-bearing or unrelated code metadata cannot replace the displayed code')
vim.api.nvim_ui_send = function() error('Terminal UI unavailable') end
keys('<C-y>')
assert(vim.fn.getreg() == 'TEST-CODE' and vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] == 'TEST-CODE',
  'A failed code copy leaves the complete device code available for native selection')
keys('<CR>')
vim.api.nvim_ui_send = function(value) clipboard_request = value end
clipboard_request = nil
vim.api.nvim_exec_autocmds('TermRequest', { buffer = buffer, data = { sequence = '\027]8;id=harness-login;' .. url } })
keys('<C-y>')
assert(clipboard_request == nil, 'A new login link clears the previous device code')
keys('<C-l>')
assert(vim.fn.getreg() == url and vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] == url,
  'A terminal that denies clipboard access still has the complete selectable link')
keys('<CR>')
vim.api.nvim_ui_send = function() error('Terminal UI unavailable') end
keys('<C-x>')
assert(vim.api.nvim_buf_get_name(0) == 'harness://login-link', 'A native clipboard request failure opens the selectable link')
keys('<CR>')
vim.api.nvim_list_uis, vim.api.nvim_ui_send = list_uis, ui_send
keys('<C-x>')
local fallback = vim.api.nvim_get_current_buf()
assert(vim.api.nvim_buf_get_name(fallback) == 'harness://login-link', 'No clipboard opens the selectable link')
assert(vim.api.nvim_buf_get_lines(fallback, 0, 1, false)[1] == url and vim.fn.getreg() == url,
  'Fallback keeps one complete logical URL line and copies it to the Vim register')
assert(not vim.bo[fallback].modifiable and vim.bo[fallback].buftype == 'nofile', 'The link view cannot modify files')
keys('ggy$')
assert(vim.fn.getreg() == url, 'Native Vim yank copies the full link without hard wraps')
keys('<C-o>')
assert(opened == url, 'The fallback keeps the same browser action')
keys('<CR>')
assert(vim.api.nvim_get_current_buf() == buffer and vim.fn.jobwait({ channel }, 0)[1] == -1, 'Enter returns to the same live private terminal')
keys('<C-x><Esc>')
assert(vim.api.nvim_get_current_buf() == buffer and calls == 0 and vim.fn.jobwait({ channel }, 0)[1] == -1,
  'Escape from the full link returns to private input without cancelling login')
keys('<C-x><C-c>')
closed()
assert(not vim.api.nvim_buf_is_valid(fallback) and not result.succeeded, 'Cancelling the link view also removes its terminal')
open()
vim.ui.open = function() return nil, 'No browser handler' end
keys('<C-o>')
assert(vim.api.nvim_buf_get_name(0) == 'harness://login-link' and vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] == url,
  'An unavailable browser leaves a complete selectable link')
keys('<C-c>')
closed()
open()
keys('<C-l>')
vim.fn.chansend(channel, 'f')
wait(function() return vim.wo[window].winbar:find('Close', 1, true) end, 'Failed login remains visible for acknowledgment')
assert(vim.api.nvim_get_current_buf() == buffer, 'A failure in the full-link view shows the terminal error before acknowledgment')
assert(calls == 0, 'A failed login is not silently dismissed')
vim.ui.open = function(value) opened = value; return {} end
opened = nil
keys('<C-o>')
assert(opened == nil, 'A failed login cannot reopen its expired browser link')
click(1, 2)
assert(opened == nil and calls == 0, 'Clicking an expired link keeps the failure visible for acknowledgment')
keys('<CR>')
closed()
assert(result.focused and not result.succeeded and #messages == 1, 'Acknowledging failure reports unsuccessful completion once')
open()
vim.api.nvim_set_current_win(previous)
vim.fn.chansend(channel, 's')
closed()
assert(result.succeeded and not result.focused and vim.api.nvim_get_current_win() == previous, 'Success after outside navigation keeps file focus')
open()
vim.v.errmsg = ''
vim.api.nvim_exec_autocmds('TermRequest', { buffer = buffer, data = { sequence = '\027]8;id=harness-login;' .. url } })
vim.api.nvim_win_close(window, true)
closed()
assert(not result.succeeded, 'Native window closure cancels without leaking a terminal')
assert(vim.v.errmsg == '', 'Closing during a terminal link update does not access an invalid window')
vim.ui.open = ui_open
vim.fn.delete(directory, 'rf')
print('Neovim login checks passed: exact links, clipboard fallback, native selection, resize, cancellation, failures and focus.')
vim.cmd('noautocmd qa!')
