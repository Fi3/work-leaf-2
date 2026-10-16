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
print('Neovim component checks passed: lazy startup, panels, Unicode framing, context, streams, stop, reconnect and duplicate retry.')
vim.cmd('noautocmd qa!')
