local root = vim.fn.getcwd()
vim.opt.runtimepath:append(root)
vim.o.columns, vim.o.lines = 120, 40
local source = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(source, 0, -1, false, { 'unsaved source' })
vim.wo.wrap = false
local changed = vim.api.nvim_buf_get_changedtick(source)
local view = require('harness.view').new({ prompt_height = 3 })
local snapshot = vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/protocol.json'), '\n')).snapshot
local function win(buffer)
  for _, window in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(window) == buffer then return window end
  end
  error('Buffer is not visible in the current tab')
end
local function text(buffer) return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n') end
view.open()
snapshot.session.provider, snapshot.session.model, snapshot.session.name = vim.NIL, vim.NIL, 'New chat'
snapshot.entries, snapshot.tools, snapshot.assistant = {}, {}, { text = '', truncated = false }
view.render('connected', snapshot, {}, {})
assert(vim.wo[win(view.prompt)].winbar:find('Enter send', 1, true), 'The send key must be visible beside the prompt')
assert(vim.wo[win(view.prompt)].winbar:find('Shift-Enter newline', 1, true), 'The preferred newline key must be visible')
assert(vim.api.nvim_win_get_height(win(view.prompt)) == 3, 'New chat has a small three-line input')
assert(vim.wo[win(view.prompt)].winhighlight == 'Normal:NormalFloat', 'Input has a distinct native background')
assert(view.draft() == '', 'The input hint must not become submitted text')
assert(text(view.transcript):find('New chat', 1, true), 'An unconfigured chat opens without a model')
assert(not text(view.transcript):find('Type a task', 1, true), 'The conversation contains no opening instructions')
assert(vim.wo[win(view.prompt)].wrap and vim.wo[win(view.transcript)].wrap, 'Conversation and input wrap long lines')
assert(not vim.wo[win(source)].wrap, 'Source window options remain unchanged')
assert(not text(view.transcript):find('Submission:', 1, true), 'The main view must not require protocol identifiers')
view.set_draft('Draft λ 世界\nSecond line')
local lines = {}
for index = 1, 100 do lines[index] = { entry_id = 'entry-' .. index, kind = 'user', text = 'Message ' .. index, truncated = false } end
snapshot.entries, snapshot.usage = lines, { models = { test = { usage = { totalTokens = 123 } } } }
view.render('connected', snapshot, {}, {}, 'Model selection cancelled. Draft kept.')
assert(text(view.transcript):find('[user] You', 1, true), 'Messages identify who spoke')
assert(text(view.transcript):find('Tokens used: 123', 1, true) and not text(view.transcript):find('totalTokens', 1, true), 'Usage is readable text')
assert(text(view.transcript):find('Model selection cancelled. Draft kept.', 1, true), 'Command results remain visible in chat')
vim.api.nvim_win_set_cursor(win(view.transcript), { 7, 0 })
vim.api.nvim_set_current_win(win(source))
view.render('connected', snapshot, {}, {})
assert(vim.api.nvim_get_current_buf() == source, 'Streaming must not move keyboard focus')
assert(vim.api.nvim_win_get_cursor(win(view.transcript))[1] == 7, 'Reading position must survive streaming')
for _, size in ipairs({ { 80, 24 }, { 60, 20 }, { 120, 40 } }) do
  vim.o.columns, vim.o.lines = size[1], size[2]
  -- Apply new screen dimensions without an attached UI; equalize must include
  -- the normally fixed-height prompt. resize() restores its fixed height.
  vim.wo[win(view.prompt)].winfixheight = false
  vim.cmd('wincmd =')
  view.resize()
  assert(view.draft() == 'Draft λ 世界\nSecond line', 'Resizing keeps the exact multiline draft')
  assert(vim.api.nvim_get_current_buf() == source, 'Resizing retains source focus')
  assert(vim.api.nvim_buf_get_changedtick(source) == changed, 'Resizing does not edit the source')
  local source_position = vim.api.nvim_win_get_position(win(source))
  local transcript_position = vim.api.nvim_win_get_position(win(view.transcript))
  local prompt_position = vim.api.nvim_win_get_position(win(view.prompt))
  assert(source_position[1] < transcript_position[1] and transcript_position[1] < prompt_position[1], 'Chat and input stay below the source at every width')
  assert(vim.api.nvim_win_get_width(win(view.prompt)) == size[1]
    and vim.api.nvim_win_get_width(win(view.transcript)) == size[1], 'Chat and prompt use the full tab width')
  assert(vim.api.nvim_win_get_height(win(view.prompt)) == 3, 'Input stays small after resize')
  assert(vim.api.nvim_win_get_height(win(source)) >= 2, 'The source remains visible')
end
vim.api.nvim_set_current_win(win(source))
vim.cmd('split')
local original = vim.api.nvim_get_current_win()
view.resize()
assert(vim.api.nvim_get_current_win() == original, 'Resizing preserves the exact source window')
local first_tab = vim.api.nvim_get_current_tabpage()
vim.cmd('tabnew')
local second_tab, second_source = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_buf()
view.open()
assert(vim.api.nvim_get_current_tabpage() == second_tab, 'Opening chat must not switch to another tab')
assert(win(view.prompt) and win(view.transcript) and win(second_source), 'Current tab gets its own visible chat windows')
assert(view.draft() == 'Draft λ 世界\nSecond line', 'Showing the chat in another tab preserves its draft')

local directory = assert(vim.uv.fs_realpath(root))
local items = {
  { session_id = 'root-A', name = 'Parent', workspace = directory },
  { session_id = 'root-B', name = 'Parent', workspace = directory },
  { session_id = 'alpha_same-tail', name = 'Same suffix', workspace = directory },
  { session_id = 'beta_same-tail', name = 'Same suffix', workspace = directory },
  { session_id = 'child', name = 'Child', parent_session_id = 'root-A', workspace = directory },
  { session_id = 'leaf', name = 'Leaf', parent_session_id = 'child', workspace = directory },
  { session_id = 'foreign', name = 'Other project', workspace = '/elsewhere' },
  { session_id = 'legacy', name = 'Legacy', parent_session_id = vim.NIL, workspace = directory },
  { session_id = 'cycle-a', name = 'Cycle A', parent_session_id = 'cycle-b', workspace = directory },
  { session_id = 'cycle-b', name = 'Cycle B', parent_session_id = 'cycle-a', workspace = directory },
}
local lookup, calls, selected, created = {}, {}, nil, nil
local requested_directory = directory
for _, item in ipairs(items) do lookup[item.session_id] = item end
local transport = { connected = true, connect = function(callback) callback(true) end }
function transport.request(method, params, callback)
  calls[#calls + 1] = { method = method, params = params }
  if method == 'session.list' then
    assert(params.workspace == requested_directory, 'Listing is restricted to the current workspace')
    callback({ items = items, next_cursor = vim.NIL })
  elseif method == 'session.get' then
    callback({ session = lookup[params.session_id], snapshot = { session = lookup[params.session_id], state = 'running', active_submission_id = 'run-' .. params.session_id } })
  elseif method == 'run.stop' then callback({})
  else error('Unexpected sidebar operation: ' .. method) end
end
local sidebar = require('harness.sidebar').new(transport, {
  create = function(path) created = path end,
  select = function(id) selected = id end,
  report = function(message) error(message) end,
})
local function key(value) vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(value, true, false, true), 'xt', false) end
local function row(value)
  vim.api.nvim_set_current_win(win(sidebar.buffer))
  for index, line in ipairs(vim.api.nvim_buf_get_lines(sidebar.buffer, 0, -1, false)) do
    if line:find(value, 1, true) then vim.api.nvim_win_set_cursor(0, { index, 0 }); return index, line end
  end
  error('Missing row: ' .. value)
end
sidebar.toggle(directory)
assert(text(sidebar.buffer):find('+ New chat', 1, true), 'The list has a direct New action')
assert(not text(sidebar.buffer):find('Other project', 1, true), 'Other workspace agents are absent')
assert(not text(sidebar.buffer):find('Press', 1, true) and not text(sidebar.buffer):find('setup', 1, true), 'The list contains no opening or setup instructions')
assert(text(sidebar.buffer):find('Parent (root-A)', 1, true) and text(sidebar.buffer):find('Parent (root-B)', 1, true), 'Duplicate names have concise identifiers')
assert(text(sidebar.buffer):find('Same suffix (alpha_same-tail)', 1, true)
  and text(sidebar.buffer):find('Same suffix (beta_same-tail)', 1, true), 'Duplicate names remain distinct when short identifier suffixes collide')
assert(not text(sidebar.buffer):find('Child (child)', 1, true), 'Unique names need no identifier')
local parent_row, parent_line = row('Parent (root-A)')
local child_row, child_line = row('Child [')
local leaf_row, leaf_line = row('Leaf [')
assert(parent_row < child_row and child_row < leaf_row, 'Parents precede their actual descendants')
assert(parent_line:find('%S') < child_line:find('%S') and child_line:find('%S') < leaf_line:find('%S'), 'Indentation follows stored ancestry')
row('Parent (root-A)'); key('h')
assert(not text(sidebar.buffer):find('Child [', 1, true) and not text(sidebar.buffer):find('Leaf [', 1, true), 'Folding hides the whole branch')
key('l'); row('Child ['); key('<CR>')
assert(selected == 'child', 'Enter opens the selected child')
key('s')
local stopped
for _, call in ipairs(calls) do if call.method == 'run.stop' then stopped = call.params end end
assert(stopped.session_id == 'child' and stopped.submission_id == 'run-child', 'Stop retains the displayed row target')
row('+ New chat'); key('<CR>')
assert(created == directory, 'New opens directly in the current directory')
created = nil; key('n'); assert(created == directory, 'n has the same direct action')
assert(text(sidebar.buffer):find('Cycle A', 1, true) and text(sidebar.buffer):find('Cycle B', 1, true), 'Malformed legacy cycles remain visible without recursion failure')
sidebar.hide()
vim.api.nvim_set_current_tabpage(first_tab)
sidebar.toggle(directory)
local first_sidebar = win(sidebar.buffer)
vim.api.nvim_set_current_tabpage(second_tab)
sidebar.toggle(directory)
assert(vim.api.nvim_get_current_tabpage() == second_tab and win(sidebar.buffer) ~= first_sidebar, 'Opening a sidebar does not switch tabs')
requested_directory = '/elsewhere'
sidebar.refresh(requested_directory)
assert(text(sidebar.buffer):find('Other project', 1, true) and not text(sidebar.buffer):find('Parent', 1, true), 'Changing tabs can refresh the list for another current directory')
assert(vim.wo[win(sidebar.buffer)].winbar:find('elsewhere', 1, true), 'The directory label follows the current workspace')
vim.api.nvim_set_current_win(win(second_source))
vim.o.columns = 60
vim.api.nvim_exec_autocmds('VimResized', {})
assert(vim.api.nvim_get_current_buf() == second_source, 'A narrow resize preserves source focus')
for _, window in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  assert(vim.api.nvim_win_get_buf(window) ~= sidebar.buffer, 'A narrow resize hides only the current sidebar')
end
assert(vim.api.nvim_win_is_valid(first_sidebar), 'A narrow resize leaves other tab windows unchanged')
sidebar.toggle(requested_directory)
assert(win(sidebar.buffer), 'The sidebar can be opened on a narrow screen after resizing')
sidebar.hide()
assert(vim.api.nvim_win_is_valid(first_sidebar), 'Hiding the current sidebar does not close another tab window')
assert(view.draft() == 'Draft λ 世界\nSecond line', 'Sidebar operations preserve the chat draft')
local connecting = {}
transport.connect = function(callback) connecting[#connecting + 1] = callback end
sidebar.refresh(directory)
sidebar.refresh('/elsewhere')
connecting[1](nil, 'Previous workspace connection failed')
assert(#connecting == 2, 'A failed old refresh must continue the queued current-directory refresh')
connecting[2](true)
assert(text(sidebar.buffer):find('Other project', 1, true) and not text(sidebar.buffer):find('failed', 1, true), 'A stale directory error cannot replace the current agents list')
print('Neovim view checks passed: direct chat, bottom input, tab isolation, drafts, resize, workspace filter and parent-child tree.')
vim.cmd('noautocmd qa!')
