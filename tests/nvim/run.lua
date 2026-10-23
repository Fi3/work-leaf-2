local key = dofile(vim.fn.getcwd() .. '/tests/nvim/helpers.lua').keys
local root = vim.fn.getcwd()
vim.o.columns = 120
local initial_mappings = vim.api.nvim_get_keymap('n')
vim.opt.runtimepath:append(root)
vim.cmd('runtime plugin/harness.lua')
local temp = vim.fn.tempname()
vim.fn.mkdir(temp, 'p')
vim.env.HARNESS_TEST_STATE = temp .. '/state.json'
local messages = {}
vim.notify = function(message) messages[#messages + 1] = message end
local function check(condition, message) assert(condition, message) end
local function wait(predicate, message) check(vim.wait(5000, predicate, 10), message .. ': ' .. vim.inspect(messages)) end
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
local active_id
local function named(name)
  if name == 'transcript' or name == 'prompt' then
    local current = vim.api.nvim_buf_get_name(0):match('^harness://[^/]+/(.+)$')
    if current then active_id = current else
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        local id = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)):match('^harness://[^/]+/(.+)$')
        if id then active_id = id; break end
      end
    end
    if not active_id then return nil end
    name = (name == 'transcript' and 'chat/' or 'prompt/') .. active_id
  end
  local buf = vim.fn.bufnr('harness://' .. name)
  return buf ~= -1 and buf or nil
end
local function show_file(buf)
  local chat = named('transcript')
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == chat then vim.api.nvim_set_current_win(win); break end
  end
  vim.cmd('hide buffer ' .. buf)
end
local function text(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') end
local function has(value)
  local buf = named('transcript')
  return buf and text(buf):find(value, 1, true)
end
local function chat(value)
  vim.cmd('stopinsert')
  if #vim.fn.win_findbuf(named('prompt')) == 0 then vim.cmd('Harness') end
  vim.api.nvim_set_current_win(vim.fn.win_findbuf(named('prompt'))[1])
  vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, vim.split(value, '\n', { plain = true }))
  vim.cmd('Harness send')
end

local fixture = vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/protocol.json'), '\n'))
check(fixture.notification.params.snapshot.assistant.text == 'Hello \206\187\n\228\184\150\231\149\140', 'Shared Unicode fixture')
require('harness').setup({ executable = root .. '/tests/nvim/fake.py', width = 40, prompt_height = 4 })
check(not state(), 'Loading and setup must not start processes')
vim.cmd('cd ' .. vim.fn.fnameescape(temp))
save({ sessions = vim.empty_dict(), calls = {}, receipts = vim.empty_dict(), configuration = { provider = vim.NIL, model = vim.NIL } })
local input, input_count = vim.ui.input, 0
vim.ui.input = function(_, callback) input_count = input_count + 1; callback(nil) end
vim.fn.writefile({ 'disk text', 'second line' }, temp .. '/source.txt')
vim.cmd.edit(temp .. '/source.txt')
local source = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(source, 0, 1, false, { 'unsaved \206\187 \228\184\150\231\149\140' })
local tick = vim.api.nvim_buf_get_changedtick(source)
vim.cmd('Harness login')
wait(function() return named('select') end, 'Login before creating a chat lists the account providers')
check(vim.json.encode(calls('configuration.get')[1].params) == '{}', 'A request without a session sends an empty JSON object')
check(vim.tbl_isempty(state().sessions) and not named('prompt') and not state().auth_calls,
  'The first login menu does not create a chat or start authentication')
key('<Esc>')
check(vim.api.nvim_get_current_buf() == source and vim.api.nvim_buf_get_changedtick(source) == tick,
  'Cancelling the first login menu returns to the unchanged file')
vim.cmd('Harness new')
check(named('prompt') and vim.api.nvim_get_current_buf() == named('prompt'), 'New chat opens its input before session creation completes')
wait(function() return has('Session: ') end, 'Initial session and panels')
check(input_count == 0 and not named('setup') and not state().auth_calls, 'An unset model does not ask for a name or open credential setup')
local initial_id = calls('session.create')[1].params.session_id
check(state().sessions[initial_id].metadata.provider == vim.NIL, 'A real unconfigured chat is stored')
chat('Retain this until a model is selected')
wait(function() return has('Choose a model') end, 'Missing model is explained inside the chat')
check(#calls('input.submit') == 0 and text(named('prompt')) == 'Retain this until a model is selected', 'Missing model prevents admission and preserves the draft')
chat('\\unknown-command')
wait(function() return has('Unknown command') end, 'Unknown chat command is explained')
check(#calls('input.submit') == 0, 'Unknown commands never reach the model')
chat('\\model demo')
wait(function() return state().sessions[initial_id].metadata.provider == 'faux' and has('Settings saved.') end, 'A chat command selects the demo without a setup wizard')
chat('\\name ' .. initial_id)
wait(function() return has('Session: ' .. initial_id) end, 'A chat command names the stored session')
chat('\\instructions Keep my unsaved changes')
wait(function() return state().sessions[initial_id].metadata.instructions == 'Keep my unsaved changes' end, 'A chat command saves instructions')
chat('\\model faux/missing')
wait(function() return has('Choose a model from the available catalog') end, 'Invalid models fail visibly')
check(state().sessions[initial_id].metadata.model == 'test' and #calls('input.submit') == 0, 'Invalid settings preserve the current model and do not submit input')
wait(function() return text(named('transcript')):match('^Connection: connected\n') end, 'Settings retain the live chat watch')
vim.ui.input = input
check(#vim.api.nvim_list_wins() == 2, 'Chat uses the file window with one input split')
check(vim.bo[named('transcript')].buflisted and not vim.bo[named('prompt')].buflisted, 'Only chat history belongs to the native buffer list')
check(not vim.bo[named('transcript')].modifiable and vim.bo[named('prompt')].modifiable, 'Panel edit flags')
local highlights = vim.api.nvim_buf_get_extmarks(named('transcript'), vim.api.nvim_get_namespaces().HarnessView, 0, -1, { details = true })
for row, group in ipairs({ 'DiagnosticOk', 'Title', 'Comment' }) do
  local found = false
  for _, mark in ipairs(highlights) do if mark[2] == row - 1 and mark[4].hl_group == group then found = true end end
  check(found, 'Native status highlight for ' .. group)
end
check(state().starts == 1, 'Start on first invocation only')
vim.cmd('Harness context buffer')
show_file(source)
vim.cmd('2,2Harness context selection')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'First request' })
vim.cmd('Harness send')
wait(function() return #calls('input.submit') == 1 and text(named('transcript')) == '' end, 'A hidden chat can submit work without rendering its transcript')
check(vim.api.nvim_get_current_buf() == source, 'Hidden work leaves source focus unchanged')
vim.cmd('Harness')
wait(function() return has('tool progress') end, 'Reopening a chat restores streamed tool activity')
local envelope = calls('input.submit')[1].params
check(envelope.context[1].text == 'unsaved \206\187 \228\184\150\231\149\140\nsecond line\n', 'Explicit unsaved buffer snapshot')
check(envelope.context[1].modified and envelope.context[1].changedtick == tick, 'Context flags match source state')
check(envelope.context[2].kind == 'selection' and envelope.context[2].start_line == 2 and envelope.context[2].text == 'second line\n', 'Complete selected lines')
check(vim.bo[source].modified and vim.api.nvim_buf_get_changedtick(source) == tick, 'Source remains unchanged')
check(vim.fn.readfile(temp .. '/source.txt')[1] == 'disk text', 'No implicit save')
check(text(named('prompt')) == '', 'Confirmed admission clears the sent draft')
check(has('Streaming \206\187 \228\184\150\231\149\140') and has('bash: running'), 'Streamed text and tool name')
vim.cmd('Harness stop')
wait(function() return has('State: idle') end, 'Explicit stop reaches terminal state')

vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'drop' })
vim.cmd('Harness send')
wait(function() return has('Connection closed') end, 'Connection loss is visible')
check(text(named('prompt')) == 'drop', 'Uncertain draft retained')
local before = calls('input.submit')[2].params
show_file(source)
local reconnect_watches = #calls('session.watch')
vim.env.HARNESS_TEST_START_DELAY = '0.1'
vim.cmd('Harness context buffer')
vim.env.HARNESS_TEST_START_DELAY = nil
vim.fn.writefile({ 'alternate source' }, temp .. '/alternate.txt')
vim.cmd('hide edit ' .. vim.fn.fnameescape(temp .. '/alternate.txt'))
vim.cmd('Harness status')
wait(function() return #calls('session.watch') > reconnect_watches end, 'A hidden command can reconnect without rendering')
check(vim.api.nvim_buf_get_name(0) == temp .. '/alternate.txt', 'Reconnect preserves the later selected source file')
vim.cmd('Harness')
wait(function() return has('Connection: connected') end, 'Reconnect')
wait(function() return has('Context snapshot: source.txt') end, 'Context uses the source selected before asynchronous reconnect')
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
local id = uncertain.session_id
for index, command in ipairs({ 'Harness stop', '/stop' }) do
  vim.cmd('Harness')
  wait(function() return text(named('transcript')):match('^Connection: connected\n') end, 'Refresh the displayed run before stopping it')
  local current_state = state()
  local displayed_target, newer_target = current_state.sessions[id].active, 'newer-undisplayed-run-' .. index
  current_state.sessions[id].active = newer_target
  save(current_state)
  local stop_count = #calls('run.stop')
  if command == '/stop' then chat(command) else vim.cmd(command) end
  wait(function() return #calls('run.stop') == stop_count + 1 end, 'Stop displayed target')
  local stopped = calls('run.stop')[stop_count + 1].params
  check(stopped.session_id == id and stopped.submission_id == displayed_target, 'Stop must target the displayed submission')
  check(state().sessions[id].active == newer_target, 'Stop must not replace the displayed target with newer work')
end

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
for _, size in ipairs({ 128, 8192 }) do
  local bounded = state()
  bounded.sessions[id].entries = { { entry_id = 'recent', kind = 'user', text = 'Current recent entry', truncated = false } }
  bounded.sessions[id].cursor = 'bounded-1'
  bounded.history_pages = {}
  for page = 1, 6 do
    local items = {}
    for index = (6 - page) * 50 + 1, (7 - page) * 50 do
      local label = 'History item ' .. index .. ':'
      items[#items + 1] = { entry_id = 'bounded-' .. index, kind = 'user', text = label .. string.rep('x', size - #label), truncated = false }
    end
    bounded.history_pages['bounded-' .. page] = { items = items, next_cursor = page < 6 and 'bounded-' .. (page + 1) or vim.NIL }
  end
  save(bounded)
  show_file(source)
  wait(function() return text(named('transcript')) == '' end, 'Hidden history releases its displayed text')
  vim.cmd('Harness')
  wait(function() return has('Current recent entry') end, 'Reopening starts from the current snapshot')
  check(not has('Loaded history limited'), 'Reopening releases the previous history window')
  for page = 1, 6 do
    vim.cmd('Harness history')
    wait(function() return has('History item ' .. ((6 - page) * 50 + 1) .. ':') end, 'Older pages remain reachable after cache eviction')
    local loaded = text(named('transcript'))
    local _, count = loaded:gsub('%[user%] You', '')
    check(count <= 201, 'At most 200 cached history entries appear beside the current snapshot')
    check(#loaded <= 1024 * 1024 + 16384, 'Cached history text stays within 1 MiB plus display labels and the current snapshot')
  end
  check(has('Loaded history limited') and has('Current recent entry'), 'A bounded older window explains its limit and retains the current snapshot')
  show_file(source)
  wait(function() return text(named('transcript')) == '' end, 'Closing the history window releases the page cache')
  vim.cmd('Harness')
  wait(function() return has('Current recent entry') end, 'Reopening restores recent state after reaching the oldest page')
  check(not has('History item '), 'Old pages do not remain in the new display')
  vim.cmd('Harness history')
  wait(function() return has('History item 251:') end, 'An evicted newer history page can be loaded again')
  bounded = state()
  bounded.history_pages = nil
  bounded.sessions[id].cursor = vim.NIL
  save(bounded)
end
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
show_file(source)
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
list_state.sessions.second = { metadata = vim.tbl_extend('force', list_state.sessions[id].metadata, { session_id = 'second', name = 'second' }) }
save(list_state)
vim.cmd('Harness sessions')
wait(function() return choice ~= nil end, 'Native session choice')
check(#choice == 2 and vim.api.nvim_buf_get_name(named('transcript')) == 'harness://chat/' .. id,
  'Multiple sessions require an explicit choice and cancellation keeps the selected chat')
vim.ui.select = select
vim.cmd('Harness attach second')
wait(function() return has('Session: second') end, 'Prepare another chat before delayed receipts')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'deferred-receipt original' })
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
  wait(function() return text(named('prompt')) == (newer and 'New saved draft' or '') end, 'Receipt clears only its matching saved draft')
  check(text(vim.fn.bufnr('harness://prompt/second')) == 'deferred-receipt original', 'A receipt preserves identical draft text in another chat')
  if not newer then
    vim.cmd('Harness send')
    check(#calls('input.submit') == sent + 1 and text(named('prompt')) == '', 'Returning to a session cannot resend its admitted draft')
  end
end
local function tree_row(value)
  local buffer = named('agents')
  vim.api.nvim_set_current_win(vim.fn.win_findbuf(buffer)[1])
  for row, line in ipairs(vim.api.nvim_buf_get_lines(buffer, 0, -1, false)) do
    if line:find(value, 1, true) then vim.api.nvim_win_set_cursor(0, { row, 0 }); return end
  end
  error('Missing sidebar row: ' .. value)
end
show_file(source)
vim.api.nvim_win_set_buf(0, source)
require('harness').enable_sidebar()
key(';')
wait(function() return named('agents') and text(named('agents')):find('second [', 1, true)
  and not text(named('agents')):find('Loading...', 1, true) end, 'Sidebar lists current workspace sessions')
check(vim.fn.win_screenpos(vim.fn.win_findbuf(named('agents'))[1])[2] == 1, 'Sidebar is at the left edge')
check(not vim.bo[named('agents')].modifiable, 'Sidebar is read-only')
check(text(named('agents')):match('%*[^\n]*' .. id), 'Opening the sidebar marks the attached session')
check(vim.api.nvim_buf_get_lines(named('agents'), 0, 1, false)[1] == '+ New chat', 'New chat is the first tree action')
local stopping = state()
stopping.sessions.second.state, stopping.sessions.second.active = 'running', 'highlighted-run'
stopping.sessions.nested = { metadata = vim.tbl_extend('force', stopping.sessions.second.metadata, { session_id = 'nested', name = 'Nested child', parent_session_id = 'second' }) }
vim.fn.mkdir(temp .. '/other', 'p')
stopping.sessions.foreign = { metadata = vim.tbl_extend('force', stopping.sessions.second.metadata, { session_id = 'foreign', name = 'Foreign chat', workspace = temp .. '/other' }) }
save(stopping)
key('r')
wait(function() return text(named('agents')):find('second [running]', 1, true) and text(named('agents')):find('Nested child', 1, true) end, 'Sidebar refreshes state and child hierarchy')
check(not text(named('agents')):find('Foreign chat', 1, true), 'Other workspaces are not shown')
check(calls('session.list')[#calls('session.list')].params.workspace == temp, 'Session list requests select the exact current directory')
tree_row('second [')
local parent_row = vim.api.nvim_win_get_cursor(0)[1]
tree_row('Nested child')
check(vim.api.nvim_win_get_cursor(0)[1] == parent_row + 1 and vim.api.nvim_get_current_line():match('^%s%s%s'), 'A stored child is indented directly below its parent')
tree_row('second [')
key('h')
check(not text(named('agents')):find('Nested child', 1, true), 'A parent folds its stored children')
key('l')
check(text(named('agents')):find('Nested child', 1, true), 'A parent expands its stored children')
local stops_before, active_before = #calls('run.stop'), state().sessions[id].active
tree_row('second [')
key('s')
wait(function() return #calls('run.stop') == stops_before + 1 end, 'Sidebar stops the highlighted session')
local stopped = calls('run.stop')[stops_before + 1].params
check(stopped.session_id == 'second' and stopped.submission_id == 'highlighted-run', 'Sidebar stop targets the displayed row')
check(state().sessions[id].active == active_before, 'Sidebar stop leaves another selected session active')
tree_row('second [')
key('<CR>')
wait(function() return has('Session: second') end, 'Sidebar Enter attaches the chosen chat')
vim.cmd('Harness context buffer')
wait(function() return has('Context snapshot: source.txt') end, 'Sidebar selection preserves the source buffer for context')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Hidden sidebar draft' })
tree_row('second [')
key('q')
check(#vim.fn.win_findbuf(named('agents')) == 0 and text(named('prompt')) == 'Hidden sidebar draft', 'Hiding the sidebar preserves the draft')
show_file(source)
key(';')
wait(function() return #vim.fn.win_findbuf(named('agents')) == 1 end, 'Semicolon reopens the sidebar')
local creates, names = #calls('session.create'), 0
vim.ui.input = function(_, callback) names = names + 1; callback(nil) end
tree_row('+ New chat')
key('<CR>')
check(vim.api.nvim_get_current_buf() == named('prompt'), 'New chat focuses input immediately')
wait(function() return #calls('session.create') == creates + 1 and has('Session: New chat') end, 'New chat row creates a stored chat')
local new_id = calls('session.create')[creates + 1].params.session_id
check(state().sessions[new_id].metadata.workspace == temp and names == 0 and not state().auth_calls, 'New chat uses this directory without setup or naming prompts')
vim.ui.input = input
chat('/name Named agent')
wait(function() return has('Session: Named agent') end, 'Slash command alias names the chat')
chat('\\child Child from chat')
wait(function() return #calls('session.create') == creates + 2 and has('Session: Child from chat') end, 'Child command opens an independent chat')
local child_id = calls('session.create')[creates + 2].params.session_id
check(state().sessions[child_id].metadata.parent_session_id == new_id, 'Child creation sends a durable parent identifier')
chat('\\model demo')
wait(function() return state().sessions[child_id].metadata.model == 'test' end, 'Child settings can be selected')
chat('\\context buffer')
wait(function() return has('Context snapshot: source.txt') end, 'Chat context command uses the source file')
chat('\\instructions Keep \206\187')
wait(function() return state().sessions[child_id].metadata.instructions == 'Keep \206\187' end, 'Instructions are saved by the chat command')
chat('\\instructions')
wait(function() return state().sessions[child_id].metadata.instructions == '' end, 'An empty instructions command clears instructions')
local admitted = #calls('input.submit')
chat('\\provider absent')
wait(function() return has('Choose a provider with \\provider.') end, 'Unknown provider is explained locally')
chat('\\login must-not-be-an-argument')
wait(function() return has('Do not put a key') end, 'Keys must not be supplied as chat-command arguments')
check(#calls('input.submit') == admitted and not state().auth_calls, 'Settings errors and credential arguments do not reach the model or terminal')
chat('\\model anthropic/hosted')
wait(function() return state().sessions[child_id].metadata.provider == 'anthropic' end, 'Model selection does not require credential entry')
local function model_window()
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local config = vim.api.nvim_win_get_config(win)
    if config.relative ~= '' and vim.inspect(config.title):find('Model for this chat', 1, true) then return win end
  end
end
local action_draft = 'Keep the complete task while changing settings\nAnd this second line.'
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, vim.split(action_draft, '\n', { plain = true }))
local actions_configured, actions_submitted = #calls('session.configure'), #calls('input.submit')
vim.cmd('Harness actions')
wait(function() return named('select') and text(named('select')):find('Connect an account', 1, true) end, 'Chat actions are available without entering a command in the draft')
check(text(named('select')):find('Attach selected lines', 1, true), 'Chat actions expose explicit source attachment')
key('j<CR>')
wait(function() return named('select') and text(named('select')):find('Hosted model', 1, true) end, 'Choose a model opens the existing model selector')
key('<Esc>')
check(text(named('prompt')) == action_draft and vim.api.nvim_get_current_buf() == named('prompt'), 'Cancelling the model action returns to the exact draft')
vim.cmd('Harness actions')
wait(function() return named('select') end, 'Actions can be reopened')
key('<CR>')
wait(function() return named('select') and text(named('select')):find('ChatGPT account', 1, true) end, 'Connect an account opens the provider menu')
key('<Esc>')
check(text(named('prompt')) == action_draft and vim.api.nvim_get_current_buf() == named('prompt'), 'Cancelling the account action keeps the draft')
vim.cmd('Harness actions')
wait(function() return named('select') end, 'Actions can attach source text')
key('jj<CR>')
wait(function() return has('Source context attached.') end, 'Source attachment is available without editing the draft')
check(text(named('prompt')) == action_draft and has('Context snapshot: source.txt'), 'The action attaches the captured source buffer and keeps the draft')
check(#calls('session.configure') == actions_configured and #calls('input.submit') == actions_submitted, 'Cancelled choices and source attachment do not change settings or submit work')
vim.cmd('Harness actions')
wait(function() return named('select') end, 'An action menu can be left for a source file')
show_file(source)
wait(function() return not named('select') end, 'Leaving chat actions closes the menu')
check(vim.api.nvim_get_current_buf() == source and #vim.fn.win_findbuf(named('prompt')) == 0, 'Cancelling by file navigation leaves the file active')
vim.cmd('Harness')
wait(function() return #vim.fn.win_findbuf(named('prompt')) > 0 end, 'The draft remains available after file navigation')
local configured_before_picker = #calls('session.configure')
chat('\\model')
wait(function() return model_window() ~= nil end, 'Model choice opens in a scrollable native window')
check(vim.api.nvim_get_current_line():find('Hosted model', 1, true), 'Model choice starts on the stored model')
check(text(named('select')):find('OpenAI Codex / GPT-5.4', 1, true)
  and text(named('select')):find('[login needed]', 1, true), 'The model list identifies other providers and missing login')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Keep this newer draft', 'Second line' })
key('<Esc>')
wait(function() return not model_window() end, 'Escape closes the model list')
check(#calls('session.configure') == configured_before_picker and text(named('prompt')) == 'Keep this newer draft\nSecond line', 'Cancelling model selection preserves settings and later draft text')
local configurations_before_picker = #calls('configuration.get')
local catalog_state = state()
local catalog_completed = catalog_state.configuration_completed
catalog_state.configuration_delay = 0.15
save(catalog_state)
chat('\\model')
wait(function() return #calls('configuration.get') > configurations_before_picker end, 'The model catalog request starts before file navigation')
show_file(source)
wait(function() return state().configuration_completed > catalog_completed end, 'The model catalog response arrives after file navigation')
vim.wait(50, function() return false end)
check(not model_window() and vim.api.nvim_get_current_buf() == source, 'A late model list cannot take focus from a file')
catalog_state = state(); catalog_state.configuration_delay = nil; save(catalog_state)
vim.cmd('Harness')
wait(function() return #vim.fn.win_findbuf(named('prompt')) > 0 end, 'The chat can be reopened after cancelling the late model list')
local delayed_settings = state()
delayed_settings.configure_delay = 0.15
save(delayed_settings)
local configured_before_navigation = #calls('session.configure')
chat('\\name Settings while reading a file')
wait(function() return #calls('session.configure') > configured_before_navigation end, 'The settings request starts before file navigation')
show_file(source)
wait(function() return state().sessions[child_id].metadata.name == 'Settings while reading a file' end, 'The settings response completes after file navigation')
vim.wait(100, function() return false end)
check(vim.api.nvim_get_current_buf() == source and #vim.fn.win_findbuf(named('prompt')) == 0, 'A delayed settings response cannot reopen the prompt or take file focus')
delayed_settings = state(); delayed_settings.configure_delay = nil; save(delayed_settings)
vim.cmd('Harness')
wait(function() return #vim.fn.win_findbuf(named('prompt')) > 0 end, 'The configured chat can be reopened')
chat('Keep draft during key entry')
wait(function() return has('Use \\login') end, 'Missing credentials remain an inline chat error')
check(text(named('prompt')) == 'Keep draft during key entry' and #calls('input.submit') == admitted, 'Missing credentials retain the unsent task')
local creates_before_auth = #calls('session.create')
local function login()
  vim.cmd('Harness login')
  wait(function() return named('select') end, 'Login lists the available account providers')
  check(text(named('select')):find('ChatGPT account', 1, true), 'Subscription login is visible beside the provider')
  key('<CR>')
  wait(function() return named('select') and text(named('select')):find('Claude account', 1, true) end, 'Provider methods include API key and account login')
  key('<CR>')
end
login()
wait(function() return named('setup') and vim.bo[named('setup')].channel > 0 end, 'Explicit login opens a native terminal')
vim.fn.chansend(vim.bo[named('setup')].channel, 'q\n')
wait(function() return not named('setup') end, 'Cancelled key entry closes its terminal')
check(text(named('prompt')) == 'Keep draft during key entry', 'Cancelled key entry preserves the chat draft')
login()
wait(function() return named('setup') and vim.bo[named('setup')].channel > 0 end, 'Key entry can be retried')
vim.fn.chansend(vim.bo[named('setup')].channel, 'failure\n')
wait(function() return text(named('setup')):find('Cannot update server credentials.', 1, true) end, 'Failed key entry retains its error output')
wait(function() return vim.wo.winbar:find('Close', 1, true) end, 'Failed key entry has a close control')
key('q')
check(text(named('prompt')) == 'Keep draft during key entry' and vim.api.nvim_get_current_buf() == named('prompt'),
  'Closing failed login returns to the unchanged draft')
login()
wait(function() return named('setup') and vim.bo[named('setup')].channel > 0 end, 'A fresh key entry can succeed')
vim.fn.chansend(vim.bo[named('setup')].channel, 'success\n')
wait(function() return not named('setup') and has('Ready.') end, 'Successful login refreshes the current chat status')
check(vim.deep_equal(state().auth_arguments[1], { 'auth', '--provider', 'anthropic', '--method', 'api_key' }), 'The credential process receives only the selected provider and method')
check(text(named('prompt')) == 'Keep draft during key entry' and #calls('session.create') == creates_before_auth, 'Key entry neither sends a task nor creates a replacement chat')
vim.cmd('Harness login')
wait(function() return named('select') end, 'Login can show the credential method now in use')
check(text(named('select')):find('Anthropic · Anthropic API key / Claude account [API key]', 1, true),
  'An available API key is identified separately from an account login')
key('<Esc>')
local configured_auth = #calls('session.configure')
vim.cmd('Harness login openai-codex')
wait(function() return named('setup') and vim.bo[named('setup')].channel > 0 end, 'A provider with one account method opens its terminal directly')
local background_login = vim.bo[named('setup')].channel
show_file(source)
wait(function() return #vim.fn.win_findbuf(named('prompt')) == 0 end, 'The source file can be edited while login is open')
vim.fn.chansend(background_login, 'success\n')
wait(function() return not named('setup') and state().authenticated['openai-codex'] end, 'A subscription account can finish independently of the current chat model')
check(vim.api.nvim_get_current_buf() == source and not named('select') and #vim.fn.win_findbuf(named('prompt')) == 0,
  'Login completion does not take focus from the source file or reopen its hidden chat')
check(#calls('session.configure') == configured_auth and state().sessions[child_id].metadata.provider == 'anthropic', 'Logging in does not replace an existing model')
local auth_arguments = state().auth_arguments
check(vim.deep_equal(auth_arguments[#auth_arguments], { 'auth', '--provider', 'openai-codex', '--method', 'oauth' }), 'Account login passes the catalog provider and OAuth method')
vim.cmd('Harness attach ' .. child_id)
wait(function() return text(named('prompt')) == 'Keep draft during key entry' and not has('loading session') end, 'The original chat draft can be reopened after background login')
vim.cmd('Harness login')
wait(function() return named('select') end, 'Login can show both saved credential methods')
check(text(named('select')):find('OpenAI Codex · ChatGPT account [account login]', 1, true)
  and text(named('select')):find('Anthropic · Anthropic API key / Claude account [API key]', 1, true),
  'The provider menu distinguishes a saved account from an API key without changing either')
key('<Esc>')
vim.cmd('Harness new')
wait(function() return has('Session: New chat') and not has('loading session') end, 'An unconfigured chat can connect an existing account')
local unconfigured_id = calls('session.create')[#calls('session.create')].params.session_id
vim.cmd('Harness login openai-codex')
wait(function() return named('setup') and vim.bo[named('setup')].channel > 0 end, 'Login is available before choosing a model')
vim.fn.chansend(vim.bo[named('setup')].channel, 'success\n')
wait(function() return model_window() ~= nil end, 'Successful login offers that provider models for an unconfigured chat')
check(text(named('select')):find('GPT-5.4', 1, true) and not text(named('select')):find('Hosted model', 1, true), 'The next model choice belongs to the account just connected')
key('<CR>')
wait(function() return state().sessions[unconfigured_id].metadata.provider == 'openai-codex' end, 'Choosing the account model configures the exact provider')
check(#calls('input.submit') == admitted, 'Connecting and choosing models never sends a paid task')
vim.cmd('Harness attach second')
wait(function() return has('Session: second') end, 'Return to a prior chat after authentication')
check(text(named('prompt')) == 'Hidden sidebar draft', 'Other chat drafts survive settings and authentication')

-- A first message entered while a new chat starts must wait for durable creation.
chat('drop')
wait(function() return has('Connection closed') end, 'Disconnect before startup-send check')
local defaults = state()
defaults.configuration = { provider = 'faux', model = 'test' }
save(defaults)
local sent_before, created_before = #calls('input.submit'), #calls('session.create')
vim.env.HARNESS_TEST_START_DELAY = '0.2'
vim.cmd('Harness new')
check(named('prompt') and vim.api.nvim_get_current_buf() == named('prompt'), 'New chat opens its input before startup completes')
chat('First message while starting')
vim.env.HARNESS_TEST_START_DELAY = nil
wait(function() return #calls('input.submit') == sent_before + 1 and text(named('prompt')) == '' end, 'First send waits for startup and creation')
check(#calls('session.create') == created_before + 1, 'Deferred send creates only one chat')
local first_send = calls('input.submit')[sent_before + 1].params
check(first_send.text == 'First message while starting' and first_send.session_id == calls('session.create')[created_before + 1].params.session_id, 'Deferred send reaches its intended stored chat')

local delayed = state()
delayed.create_delay = 0.2
save(delayed)
sent_before, created_before = #calls('input.submit'), #calls('session.create')
vim.cmd('Harness new')
chat('Original task at first Enter')
chat('Second Enter must not replace the first task')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Newer unsent draft' })
wait(function() return #calls('input.submit') >= sent_before + 1 end, 'First queued send runs after delayed creation')
vim.wait(100, function() return false end)
check(#calls('input.submit') == sent_before + 1 and calls('input.submit')[sent_before + 1].params.text == 'Original task at first Enter', 'Repeated Enter preserves the first queued task and admits it once')
check(text(named('prompt')) == 'Newer unsent draft', 'A queued receipt preserves newer unsent text')
sent_before = #calls('input.submit')
local configured_queued = #calls('session.configure')
vim.cmd('Harness new')
chat('')
chat('\\model anthropic/hosted')
chat('Keep this task after the model command')
wait(function() return #calls('session.configure') == configured_queued + 1 end, 'The first queued settings command runs after creation')
vim.wait(100, function() return false end)
check(#calls('input.submit') == sent_before, 'A later task cannot run before the queued model change')
check(calls('session.configure')[configured_queued + 1].params.model == 'hosted', 'The queued model choice reaches the stored chat')
check(text(named('prompt')) == 'Keep this task after the model command', 'The later task remains a draft after a queued command')
chat('\\model demo')
wait(function() return #calls('session.configure') == configured_queued + 2 end, 'Restore the local model before the disconnect check')
for _, capture in ipairs({
  { kind = 'buffer', text = 'unsaved \206\187 \228\184\150\231\149\140\nsecond line\n' },
  { kind = 'selection', text = 'second line\n', start_line = 2, end_line = 2 },
}) do
  show_file(source)
  if capture.kind == 'selection' then
    vim.api.nvim_buf_set_mark(source, '<', 2, 0, {})
    vim.api.nvim_buf_set_mark(source, '>', 2, 0, {})
  end
  vim.cmd('Harness new')
  chat('\\context ' .. capture.kind)
  if capture.kind == 'selection' then
    vim.api.nvim_buf_set_mark(source, '<', 1, 0, {})
    vim.api.nvim_buf_set_mark(source, '>', 1, 0, {})
  end
  show_file(vim.fn.bufnr(temp .. '/alternate.txt'))
  wait(function() return text(named('prompt')) == '' end, 'The queued context command completes after source navigation')
  sent_before = #calls('input.submit')
  chat('Submit the captured source')
  wait(function() return #calls('input.submit') == sent_before + 1 and text(named('prompt')) == '' end, 'Submit the attachment from the queued context command')
  local queued_context = calls('input.submit')[sent_before + 1].params.context
  check(#queued_context == 1 and queued_context[1].path == 'source.txt' and queued_context[1].kind == capture.kind
    and queued_context[1].text == capture.text and queued_context[1].start_line == capture.start_line
    and queued_context[1].end_line == capture.end_line, 'A queued chat context command keeps its original source and selected lines')
end
delayed = state(); delayed.create_delay = nil; save(delayed)

local failed_chat_id = calls('input.submit')[sent_before + 1].params.session_id
local configure_before_failure = #calls('session.configure')
delayed = state(); delayed.configure_delay = 0.15; save(delayed)
chat('\\name Reject while busy')
wait(function() return #calls('session.configure') == configure_before_failure + 1 end, 'A settings request starts in the busy chat')
vim.cmd('Harness attach second')
wait(function() return has('Session: second') and text(named('transcript')):match('^Connection: connected\n') end, 'Another chat opens after the delayed settings failure')
check(not has('Session has active work'), 'A settings failure does not appear in another chat')
delayed = state(); delayed.configure_delay = nil; save(delayed)
vim.cmd('Harness attach ' .. failed_chat_id)
wait(function() return has('Session has active work') end, 'The settings failure remains in the chat that sent the request')

chat('drop')
wait(function() return has('Connection closed') end, 'Disconnect before cross-chat startup check')
sent_before, created_before = #calls('input.submit'), #calls('session.create')
vim.env.HARNESS_TEST_START_DELAY = '0.2'
vim.cmd('Harness new')
chat('Task belongs to A')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Newer draft in A' })
vim.cmd('Harness new')
vim.env.HARNESS_TEST_START_DELAY = nil
wait(function() return #calls('session.create') == created_before + 2 and #calls('input.submit') >= sent_before + 1 end, 'Both chats start and the captured first task runs')
local chat_a, chat_b = calls('session.create')[created_before + 1].params.session_id, calls('session.create')[created_before + 2].params.session_id
local captured_send = calls('input.submit')[sent_before + 1].params
check(captured_send.session_id == chat_a and captured_send.text == 'Task belongs to A', 'A task entered in A is never sent to B after startup')
check(text(named('prompt')) == '', 'Background admission does not replace B input')
vim.cmd('Harness attach ' .. chat_a)
wait(function() return text(named('prompt')) == 'Newer draft in A' end, 'Background admission preserves the newer A draft')

local picker, configured_before = nil, #calls('session.configure')
local native_select = require('harness.select').select
require('harness.select').select = function(items, _, callback) picker = { items = items, callback = callback } end
chat('\\provider')
wait(function() return picker ~= nil end, 'Provider choice opens for A')
vim.cmd('Harness attach ' .. chat_b)
wait(function() return text(named('prompt')) == '' end, 'Switch to B while the provider choice is pending')
local old_picker = picker
picker = nil
old_picker.callback(old_picker.items[2], 2)
if picker then picker.callback(picker.items[1], 1) end
vim.wait(100, function() return false end)
for index = configured_before + 1, #calls('session.configure') do
  check(calls('session.configure')[index].params.session_id ~= chat_b, 'A provider choice for A cannot configure B')
end
require('harness.select').select = native_select

vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Tab one draft' })
local first_tab = vim.api.nvim_get_current_tabpage()
vim.cmd('tabnew ' .. vim.fn.fnameescape(temp .. '/alternate.txt'))
vim.cmd('Harness new')
wait(function() return #calls('session.create') == created_before + 3 and has('Session: New chat') end, 'Another tab opens its own chat')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Tab two draft' })
local second_tab = vim.api.nvim_get_current_tabpage()
vim.api.nvim_set_current_tabpage(first_tab)
wait(function() return text(named('prompt')) == 'Tab one draft' end, 'Returning to the first tab restores its chat draft')
vim.api.nvim_set_current_tabpage(second_tab)
wait(function() return text(named('prompt')) == 'Tab two draft' end, 'Returning to the second tab restores its chat draft')
vim.api.nvim_set_current_tabpage(first_tab)

if #vim.fn.win_findbuf(named('agents')) > 0 then tree_row('+ New chat'); key('q') end
show_file(source)
vim.cmd('lcd ' .. vim.fn.fnameescape(temp .. '/other'))
key(';')
wait(function() return text(named('agents')):find('Foreign chat', 1, true) and not text(named('agents')):find('Loading...', 1, true) end, 'Tree follows the current source-window directory')
check(not text(named('agents')):find('Named agent', 1, true) and not text(named('agents')):find('second [', 1, true), 'Previous workspace chats stay hidden after changing directory')
local create_other = #calls('session.create')
tree_row('+ New chat')
key('n')
wait(function() return #calls('session.create') == create_other + 1 end, 'New chat is available in another directory')
check(calls('session.create')[create_other + 1].params.workspace == temp .. '/other', 'New chat uses the current directory')
local old_server = state()
old_server.api_revision = 1
save(old_server)
chat('drop')
wait(function() return has('Connection closed') end, 'Disconnect before old-server handshake')
local old_calls = #calls('input.submit')
vim.cmd('Harness')
wait(function() return has('different chat interface') end, 'A stale server fails during the handshake')
chat('Retain input until server upgrade')
vim.wait(100, function() return false end)
check(#calls('input.submit') == old_calls, 'Incompatible infrastructure cannot receive a new task')
check(text(named('prompt')) == 'Retain input until server upgrade', 'Compatibility failure preserves the draft')
vim.cmd('Harness upgrade')
wait(function() return state().api_revision == 4 and has('Connection: connected') end, 'Explicit upgrade reconnects to the current contract')
check(text(named('prompt')) == 'Retain input until server upgrade', 'Upgrade preserves unsent input')

-- A local command queued during creation still belongs to that chat after a switch.
local delayed_command = state()
delayed_command.create_delay = 0.2
save(delayed_command)
local create_count, configure_count = #calls('session.create'), #calls('session.configure')
vim.cmd('Harness new')
local queued_id = vim.api.nvim_buf_get_name(named('transcript')):match('^harness://chat/(.+)$')
chat('\\name Rename while creating')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Later draft in the first chat' })
vim.cmd('Harness new')
local other_id = vim.api.nvim_buf_get_name(named('transcript')):match('^harness://chat/(.+)$')
vim.api.nvim_buf_set_lines(named('prompt'), 0, -1, false, { 'Keep the second chat draft' })
wait(function()
  local current = state()
  return #calls('session.create') == create_count + 2 and current.sessions[queued_id] and current.sessions[other_id]
    and text(named('transcript')):match('^Connection: connected\n')
end, 'Both chats are stored before returning to the queued command')
check(#calls('session.configure') == configure_count and state().sessions[other_id].metadata.name == 'New chat', 'A queued command cannot change the selected second chat')
delayed_command = state(); delayed_command.create_delay = nil; save(delayed_command)
vim.cmd('tabnew')
vim.cmd('Harness attach ' .. queued_id)
wait(function()
  return state().sessions[queued_id].metadata.name == 'Rename while creating'
    and text(named('transcript')):match('^Connection: connected\n') and has('Session: Rename while creating')
end, 'Opening the first chat in another tab completes its queued command')
local configured = calls('session.configure')
check(#configured == configure_count + 1 and configured[#configured].params.session_id == queued_id
  and configured[#configured].params.name == 'Rename while creating', 'The queued command configures its exact chat once')
check(text(named('prompt')) == 'Later draft in the first chat', 'A queued command preserves later input in its chat')
check(text(vim.fn.bufnr('harness://prompt/' .. other_id)) == 'Keep the second chat draft'
  and state().sessions[other_id].metadata.name == 'New chat', 'The other chat keeps its draft and settings')
vim.cmd('tabclose')
vim.cmd('Harness attach ' .. other_id)
wait(function() return text(named('transcript')):match('^Connection: connected\n') end, 'The second chat can be reopened after the command')
vim.cmd('Harness attach ' .. queued_id)
wait(function() return text(named('transcript')):match('^Connection: connected\n') end, 'The first chat can be reopened again')
check(#calls('session.configure') == configure_count + 1, 'Reopening does not repeat a completed queued command')

-- A real Rust proxy can reject an old server before it returns a Lua handshake.
local proxy_path = temp .. '/reject-old-proxy'
vim.fn.writefile({
  '#!/usr/bin/env python3',
  'import os, sys',
  'assert sys.argv[1:] == ["rpc"]',
  'sys.stdin.readline()',
  'os.write(2, b"Discard this old diagnostic prefix\\n" + b"x" * 16384)',
  'os.write(2, b"\\nharness: Server uses an older chat interface. Run harness upgrade with the same configuration.\\n")',
  'sys.exit(3)',
}, proxy_path)
assert(vim.uv.fs_chmod(proxy_path, 448))
local failures, connection_errors = {}, {}
local proxy = require('harness.transport').new({ executable = proxy_path, autostart = false }, function(err)
  if err then connection_errors[#connection_errors + 1] = err end
end, function() error('The rejected proxy must not publish a session update') end)
for _ = 1, 2 do
  proxy.connect(function(value, err)
    check(not value and type(err) == 'string', 'A proxy rejection completes every waiting connection with an error')
    failures[#failures + 1] = err
  end)
end
wait(function() return #failures == 2 end, 'Proxy stderr reaches all waiting connections')
for _, failure in ipairs(failures) do
  check(failure:find('Run :Harness upgrade with the same configuration.', 1, true), 'Proxy rejection gives an editor command to repair the server')
  check(#failure <= 9 * 1024 and not failure:find('Discard this old diagnostic prefix', 1, true), 'Proxy diagnostics retain a bounded tail')
end
check(#connection_errors > 0 and connection_errors[#connection_errors] == failures[1], 'The connection view receives the same actionable failure')
vim.fn.writefile({
  '#!/usr/bin/env python3',
  'import json, sys',
  'assert sys.argv[1:] == ["rpc"]',
  'for line in sys.stdin:',
  '    request = json.loads(line)',
  '    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"api_version": 1, "api_revision": 4}}), flush=True)',
}, proxy_path)
local reconnected = false
proxy.connect(function(value, err)
  check(value and not err, 'A repaired proxy can complete a fresh handshake')
  reconnected = true
end)
wait(function() return reconnected end, 'Proxy rejection leaves connection startup available for retry')
check(#failures == 2, 'Each failed connection callback completes once')
proxy.disconnect()

print('Neovim component checks passed: chat commands, stored children, directory filter, lazy startup, context, streams, stop, reconnect and duplicate retry.')
vim.cmd('noautocmd qa!')
