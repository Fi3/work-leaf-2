local root = vim.fn.getcwd()
local initial_mappings = vim.api.nvim_get_keymap('n')
vim.opt.runtimepath:append(root)
vim.cmd('runtime plugin/harness.lua')
local temp = vim.fn.tempname()
vim.fn.mkdir(temp, 'p')
vim.env.HARNESS_TEST_STATE = temp .. '/state.json'
local messages = {}
vim.notify = function(message) messages[#messages + 1] = message end
local function check(condition, message) assert(condition, message) end
local function wait(predicate, message) check(vim.wait(5000, predicate, 10), message) end
local function state()
  local file = io.open(vim.env.HARNESS_TEST_STATE)
  if not file then return nil end
  local text = file:read('*a'); file:close()
  return vim.json.decode(text)
end
local function calls(method)
  local found = {}
  for _, call in ipairs(state().calls) do if call.method == method then found[#found + 1] = call end end
  return found
end
local function save(value)
  vim.fn.writefile({ vim.json.encode(value) }, vim.env.HARNESS_TEST_STATE .. '.external')
  assert(vim.uv.fs_rename(vim.env.HARNESS_TEST_STATE .. '.external', vim.env.HARNESS_TEST_STATE))
end
local function named(name)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf) == 'harness://' .. name then return buf end
  end
end
local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end
local function has(value)
  local buf = named('transcript')
  return buf and text(buf):find(value, 1, true)
end

local fixture = vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/protocol.json'), '\n'))
check(fixture.notification.params.snapshot.assistant.text == 'Hello λ\n世界', 'Shared Unicode fixture')
require('harness').setup({ executable = root .. '/tests/nvim/fake.py', workspace = temp, width = 40, prompt_height = 4 })
check(not state(), 'Loading and setup must not start processes')
vim.fn.writefile({ 'disk text', 'second line' }, temp .. '/source.txt')
vim.cmd.edit(temp .. '/source.txt')
local source = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(source, 0, 1, false, { 'unsaved λ 世界' })
local tick = vim.api.nvim_buf_get_changedtick(source)
vim.cmd('Harness')
wait(function() return has('Session: ') end, 'Initial session and panels')
check(#vim.api.nvim_list_wins() == 3, 'Source, transcript and prompt windows')
check(not vim.bo[named('transcript')].modifiable and vim.bo[named('prompt')].modifiable, 'Panel edit flags')
check(#vim.api.nvim_buf_get_extmarks(named('transcript'), vim.api.nvim_get_namespaces().HarnessView, 0, -1, {}) == 3, 'Native status highlight groups')
check(state().starts == 1, 'Start on first invocation only')
vim.cmd('Harness context buffer')
vim.api.nvim_set_current_buf(source)
vim.cmd('2,2Harness context selection')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'First request' })
vim.cmd('Harness send')
wait(function() return #calls('input.submit') == 1 and has('tool progress') end, 'Streamed tool activity')
local envelope = calls('input.submit')[1].params
check(envelope.context[1].text == 'unsaved λ 世界\nsecond line\n', 'Explicit unsaved buffer snapshot')
check(envelope.context[1].modified and envelope.context[1].changedtick == tick, 'Context flags match source state')
check(envelope.context[2].kind == 'selection' and envelope.context[2].start_line == 2 and envelope.context[2].text == 'second line\n', 'Complete selected lines')
check(vim.bo[source].modified and vim.api.nvim_buf_get_changedtick(source) == tick, 'Source remains unchanged')
check(vim.fn.readfile(temp .. '/source.txt')[1] == 'disk text', 'No implicit save')
check(text(named('prompt')) == '', 'Confirmed admission clears the sent draft')
check(has('Streaming λ 世界') and has('bash: running'), 'Streamed text and tool name')
vim.cmd('Harness stop')
wait(function() return has('State: idle') end, 'Explicit stop reaches terminal state')

vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'drop' })
vim.cmd('Harness send')
wait(function() return has('Connection closed') end, 'Connection loss is visible')
check(text(named('prompt')) == 'drop', 'Uncertain draft retained')
local before = calls('input.submit')[2].params
vim.api.nvim_set_current_win(vim.fn.win_findbuf(source)[1])
vim.env.HARNESS_TEST_START_DELAY = '0.1'
vim.cmd('Harness context buffer')
vim.env.HARNESS_TEST_START_DELAY = nil
vim.fn.writefile({ 'alternate source' }, temp .. '/alternate.txt')
vim.cmd('hide edit ' .. vim.fn.fnameescape(temp .. '/alternate.txt'))
vim.cmd('Harness status')
wait(function() return has('Connection: connected') end, 'Reconnect')
wait(function() return has('Context snapshot: source.txt') end, 'Context uses the source selected before asynchronous reconnect')
vim.cmd('Harness')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'New unsent draft' })
vim.cmd('Harness send')
wait(function() return #calls('input.submit') == 3 end, 'Explicit duplicate retry')
local retry = calls('input.submit')[3].params
check(vim.deep_equal(before, retry), 'Retry retains the exact original request envelope')
check(text(named('prompt')) == 'New unsent draft', 'Retry must preserve a newer draft')
check(vim.tbl_count(state().receipts) == 2, 'Duplicate admission creates no replacement work')
vim.cmd('Harness stop')
wait(function() return has('State: idle') end, 'Stop before the next request')
check(has('Context snapshot: source.txt'), 'A new attachment survives a previous request receipt')

vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'not-ready-after-admission' })
vim.cmd('Harness send')
wait(function() return #calls('input.submit') == 4 and messages[#messages]:find('after admission', 1, true) end, 'Unavailable response after admission')
local uncertain = calls('input.submit')[4].params
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Replacement must not execute' })
vim.cmd('Harness send')
wait(function() return #calls('input.submit') == 5 end, 'Retry after worker unavailability')
check(vim.deep_equal(uncertain, calls('input.submit')[5].params), 'not_ready retains the original envelope')
check(vim.tbl_count(state().receipts) == 3, 'Unavailable retry creates no replacement work')
local current_state = state()
local id = uncertain.session_id
local displayed_target = current_state.sessions[id].active
current_state.sessions[id].active = 'newer-undisplayed-run'
save(current_state)
vim.cmd('Harness stop')
wait(function() return #calls('run.stop') == 3 end, 'Stop displayed target')
check(calls('run.stop')[3].params.submission_id == displayed_target, 'Stop must target the displayed submission')
check(state().sessions[id].active == 'newer-undisplayed-run', 'Stop must not replace the displayed target with newer work')

local history_state = state()
history_state.sessions[id].cursor = 'older-page'
history_state.sessions[id].entries = { { entry_id = 'long-entry', kind = 'user', text = string.rep('Line\n', 100), truncated = true } }
save(history_state)
vim.cmd('Harness')
wait(function() return has('Older text available') end, 'History availability and truncation')
vim.cmd('Harness history')
wait(function() return has('Older entry') end, 'Older transcript page')
local rolling = state()
table.insert(rolling.sessions[id].entries, { entry_id = 'rolling', kind = 'user', text = 'Retain rolling entry', truncated = false })
save(rolling)
vim.cmd('Harness')
wait(function() return has('Retain rolling entry') end, 'History follows advancing snapshots')
rolling = state()
rolling.sessions[id].entries = { { entry_id = 'newest', kind = 'user', text = 'Newest entry', truncated = false } }
rolling.sessions[id].cursor = 'gap-page'
rolling.history_pages = { ['gap-page'] = { items = {
  { entry_id = 'rolling', kind = 'user', text = 'Retain rolling entry', truncated = false },
  { entry_id = 'gap', kind = 'user', text = 'Stored gap entry', truncated = false },
}, next_cursor = vim.NIL } }
save(rolling)
vim.cmd('Harness')
wait(function() return has('Newest entry') end, 'Reconnect with a disjoint snapshot')
check(has('Older entry') and has('Retain rolling entry') and has('Line'), 'Loaded history retains entries omitted from new snapshots')
vim.cmd('Harness history')
wait(function() return has('Stored gap entry') end, 'An exhausted cursor can load a later gap')
local history_text = text(named('transcript'))
check(history_text:find('Older entry', 1, true) < history_text:find('Retain rolling entry', 1, true)
  and history_text:find('Retain rolling entry', 1, true) < history_text:find('Stored gap entry', 1, true)
  and history_text:find('Stored gap entry', 1, true) < history_text:find('Newest entry', 1, true), 'History remains in transcript order')
local _, repeated = history_text:gsub('Retain rolling entry', '')
check(repeated == 1, 'Overlapping history pages do not duplicate entries')
local transcript_window = vim.fn.win_findbuf(named('transcript'))[1]
vim.api.nvim_win_set_cursor(transcript_window, { 1, 0 })
vim.api.nvim_win_call(transcript_window, function() vim.cmd('normal! zt') end)
local saved_view = vim.api.nvim_win_call(transcript_window, vim.fn.winsaveview)
vim.cmd('Harness context buffer')
check(vim.api.nvim_win_call(transcript_window, vim.fn.winsaveview).topline == saved_view.topline, 'Preserve a scrolled transcript position')

vim.cmd('enew')
vim.cmd('Harness context buffer')
check(messages[#messages]:find('named file buffer', 1, true), 'Reject unnamed context')
vim.cmd('enew')
vim.bo.buftype = 'nofile'
vim.cmd('Harness context buffer')
check(messages[#messages]:find('file buffer', 1, true), 'Reject non-file context')

local outside = vim.fn.tempname()
vim.fn.writefile({ 'outside' }, outside)
vim.api.nvim_set_current_win(vim.fn.win_findbuf(source)[1])
vim.cmd('hide edit ' .. vim.fn.fnameescape(outside))
vim.cmd('Harness context buffer')
check(messages[#messages]:find('outside the session workspace', 1, true), 'Reject outside context')
vim.fn.delete(temp .. '/link')
vim.uv.fs_symlink(outside, temp .. '/link')
vim.cmd('hide edit ' .. vim.fn.fnameescape(temp .. '/link'))
vim.cmd('Harness context buffer')
check(messages[#messages]:find('outside the session workspace', 1, true), 'Reject symlink escape')
check(vim.deep_equal(vim.api.nvim_get_keymap('n'), initial_mappings), 'No global mappings')
local choice
local select = vim.ui.select
vim.ui.select = function(items, _, callback) choice = items; callback(nil) end
local list_state = state()
list_state.sessions.second = { metadata = vim.tbl_extend('force', list_state.sessions[id].metadata, { session_id = 'second' }) }
save(list_state)
vim.cmd('Harness sessions')
wait(function() return choice ~= nil end, 'Native session choice')
check(#choice == 2 and has('Session: ' .. id), 'Multiple sessions require an explicit choice')
vim.ui.select = select
for _, newer in ipairs({ false, true }) do
  vim.cmd('Harness attach ' .. id)
  wait(function() return has('Session: ' .. id) end, 'Original session before delayed receipt')
  local sent = #calls('input.submit')
  vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'deferred-receipt original' })
  vim.cmd('Harness send')
  wait(function() return #calls('input.submit') == sent + 1 end, 'Input admitted before receipt')
  if newer then vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'New saved draft' }) end
  vim.cmd('Harness attach second')
  wait(function() return has('Session: second') end, 'Switch before receipt')
  vim.cmd('Harness attach ' .. id)
  wait(function() return has('Session: ' .. id) end, 'Return after receipt')
  check(text(named('prompt')) == (newer and 'New saved draft' or ''), 'Receipt clears only its matching saved draft')
  if not newer then
    vim.cmd('Harness send')
    check(#calls('input.submit') == sent + 1 and messages[#messages]:find('prompt is empty', 1, true), 'Returning to a session cannot resend its admitted draft')
  end
end
local function key(value)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(value, true, false, true), 'xt', false)
end
local function tree_row(value)
  local buffer = named('agents')
  vim.api.nvim_set_current_win(vim.fn.win_findbuf(buffer)[1])
  for row, line in ipairs(vim.api.nvim_buf_get_lines(buffer, 0, -1, false)) do
    if line:find(value, 1, true) then vim.api.nvim_win_set_cursor(0, { row, 0 }); return end
  end
  error('Missing sidebar row: ' .. value)
end
vim.api.nvim_set_current_win(vim.fn.win_findbuf(source)[1])
vim.api.nvim_win_set_buf(0, source)
require('harness').enable_sidebar()
key(';')
wait(function() return named('agents') and text(named('agents')):find('second [', 1, true)
  and not text(named('agents')):find('Loading...', 1, true) end, 'Sidebar lists all sessions')
check(vim.fn.win_screenpos(vim.fn.win_findbuf(named('agents'))[1])[2] == 1, 'Sidebar is at the left edge')
check(not vim.bo[named('agents')].modifiable, 'Sidebar is read-only')
check(text(named('agents')):find('* ' .. id .. ' [', 1, true), 'Opening the sidebar marks the already attached session')
tree_row('- ')
key('<CR>')
check(not text(named('agents')):find('second [', 1, true), 'Workspace folds its sessions')
key('<CR>')
check(text(named('agents')):find('second [', 1, true), 'Workspace expands its sessions')
local stopping = state()
stopping.sessions.second.state, stopping.sessions.second.active = 'running', 'highlighted-run'
save(stopping)
key('r')
wait(function() return text(named('agents')):find('second [running]', 1, true) end, 'Sidebar refreshes session state')
local stops_before, active_before = #calls('run.stop'), state().sessions[id].active
tree_row('second [')
key('s')
wait(function() return #calls('run.stop') == stops_before + 1 end, 'Sidebar stops highlighted session')
local stopped = calls('run.stop')[stops_before + 1].params
check(stopped.session_id == 'second' and stopped.submission_id == 'highlighted-run', 'Sidebar stop targets the displayed row')
check(state().sessions[id].active == active_before, 'Sidebar stop leaves another selected session active')
tree_row('second [')
key('<CR>')
wait(function() return has('Session: second') end, 'Sidebar Enter attaches the chosen agent')
vim.cmd('Harness context buffer')
check(has('Context snapshot: source.txt'), 'Sidebar selection preserves the source buffer for context')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Hidden sidebar draft' })
tree_row('second [')
key('q')
check(#vim.fn.win_findbuf(named('agents')) == 0 and text(named('prompt')) == 'Hidden sidebar draft', 'Hiding the sidebar preserves the draft')
key(';')
wait(function() return #vim.fn.win_findbuf(named('agents')) == 1 end, 'Semicolon reopens the sidebar')
local input = vim.ui.input
vim.ui.input = function(_, callback) callback('named_agent') end
tree_row('- ')
key('n')
wait(function() return has('Session: named_agent') end, 'Sidebar creates a named session')
check(state().sessions.named_agent.metadata.workspace == temp, 'New agent uses the highlighted workspace')
vim.ui.input = input
print('Neovim component checks passed: lazy startup, panels, Unicode framing, context, streams, stop, reconnect and duplicate retry.')
vim.cmd('noautocmd qa!')
