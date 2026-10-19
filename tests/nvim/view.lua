local root = vim.fn.getcwd()
vim.opt.runtimepath:append(root)
vim.o.columns, vim.o.lines, vim.o.hidden = 120, 40, false
local source, main = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_name(source, '/tmp/harness-view-source')
vim.api.nvim_buf_set_lines(source, 0, -1, false, { 'unsaved source' })
vim.wo.wrap, vim.wo.number = false, true
local changed = vim.api.nvim_buf_get_changedtick(source)
local source_statusline = vim.wo.statusline
local activations = {}
local view
view = require('harness.view').new({ prompt_height = 3 }, { activate = function(id, buf, win)
  activations[#activations + 1] = { id = id, buffer = buf, window = win, old = view.transcript }
  if id then view.select(id) end
end })
local snapshot = vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/protocol.json'), '\n')).snapshot
local function win(buffer)
  for _, window in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(window) == buffer then return window end
  end
  error('Buffer is not visible in the current tab')
end
local function text(buffer) return table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), '\n') end
local function show(buffer)
  vim.api.nvim_set_current_win(main)
  vim.cmd('hide buffer ' .. buffer)
end
view.open('work', main)
local chat, prompt = view.transcript, view.prompt
snapshot.session.provider, snapshot.session.model, snapshot.session.name = vim.NIL, vim.NIL, 'New chat'
snapshot.entries, snapshot.tools, snapshot.assistant = {}, {}, { text = '', truncated = false }
view.render('connected', snapshot, {}, {})
assert(win(chat) == main, 'Conversation uses the normal file window')
assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'Only the small input adds a window')
assert(vim.bo[chat].buflisted and not vim.bo[prompt].buflisted, 'Native buffer lists contain chats, not inputs')
assert(vim.api.nvim_buf_get_name(chat) == 'harness://chat/work', 'Chat buffers have stable session names')
assert(view.session(chat) == 'work' and view.session(prompt) == 'work' and not view.session(source), 'Buffer identity distinguishes files from chats')
assert(vim.wo[win(prompt)].winbar:find('Enter send', 1, true), 'The send key must be visible beside the prompt')
assert(vim.wo[win(prompt)].winbar:find('Shift-Enter newline', 1, true), 'The preferred newline key must be visible')
assert(vim.api.nvim_win_get_height(win(prompt)) == 3, 'New chat has a small three-line input')
assert(vim.wo[win(prompt)].winhighlight == 'Normal:NormalFloat', 'Input has a distinct native background')
assert(view.draft() == '', 'The input hint must not become submitted text')
assert(text(chat):find('New chat', 1, true), 'An unconfigured chat opens without a model')
assert(not text(chat):find('Type a task', 1, true), 'The conversation contains no opening instructions')
assert(vim.wo[win(prompt)].wrap and vim.wo[main].wrap, 'Conversation and input wrap long lines')
assert(vim.bo[source].modified and vim.api.nvim_buf_is_loaded(source), 'An unsaved file remains loaded when replaced by chat')
assert(not text(chat):find('Submission:', 1, true), 'The main view must not require protocol identifiers')
view.set_draft('Draft λ 世界\nSecond line')
local lines = {}
for index = 1, 100 do lines[index] = { entry_id = 'entry-' .. index, kind = 'user', text = 'Message ' .. index, truncated = false } end
snapshot.entries, snapshot.usage = lines, { models = { test = { usage = { totalTokens = 123 } } } }
view.render('connected', snapshot, {}, {}, 'Model selection cancelled. Draft kept.')
assert(text(chat):find('[user] You', 1, true), 'Messages identify who spoke')
assert(text(chat):find('Tokens used: 123', 1, true) and not text(chat):find('totalTokens', 1, true), 'Usage is readable text')
assert(text(chat):find('Model selection cancelled. Draft kept.', 1, true), 'Command results remain visible in chat')
vim.api.nvim_set_current_win(main)
vim.api.nvim_win_set_cursor(main, { 7, 0 })
view.render('connected', snapshot, {}, {})
assert(vim.api.nvim_win_get_cursor(main)[1] == 7, 'Reading position must survive streaming')
vim.cmd('buffer #')
assert(vim.api.nvim_get_current_buf() == source and vim.api.nvim_get_current_win() == main, 'Native alternate buffer returns to the original file window')
assert(#vim.api.nvim_tabpage_list_wins(0) == 1, 'File editing hides the input window')
assert(not vim.wo.wrap and vim.wo.number, 'Native buffer switching restores source window options')
view.render('connected', snapshot, {}, {})
assert(vim.api.nvim_get_current_buf() == source and #vim.api.nvim_tabpage_list_wins(0) == 1, 'Streaming does not reopen chat or take file focus')
local switched, failure = pcall(vim.cmd, 'buffer #')
assert(not switched and failure:find('E37', 1, true) and vim.api.nvim_get_current_buf() == source, 'Native navigation preserves the nohidden modified-file check')
assert(not vim.o.hidden and vim.bo[source].modified, 'Harness does not change hidden or clear modified file state')
vim.o.hidden = true
vim.cmd('buffer #')
assert(vim.api.nvim_get_current_buf() == chat and view.prompt == prompt, 'Native alternate buffer restores the chat and its input')
assert(vim.api.nvim_get_current_win() == main, 'Restoring a chat leaves keyboard focus in its history')
assert(view.draft() == 'Draft λ 世界\nSecond line', 'Native switching preserves multiline input')
for _, size in ipairs({ { 80, 24 }, { 60, 20 }, { 120, 40 } }) do
  vim.o.columns, vim.o.lines = size[1], size[2]
  vim.wo[win(prompt)].winfixheight = false
  vim.cmd('wincmd =')
  view.resize()
  assert(view.draft() == 'Draft λ 世界\nSecond line', 'Resizing keeps the exact multiline draft')
  assert(vim.api.nvim_get_current_win() == main, 'Resizing retains the current content window')
  assert(vim.api.nvim_buf_get_changedtick(source) == changed, 'Resizing does not edit the source')
  assert(vim.api.nvim_win_get_position(main)[1] < vim.api.nvim_win_get_position(win(prompt))[1], 'Input remains below the normal content area')
  assert(vim.api.nvim_win_get_width(win(prompt)) == size[1] and vim.api.nvim_win_get_width(main) == size[1], 'Conversation and input use the available column')
  assert(vim.api.nvim_win_get_height(win(prompt)) == 3, 'Input stays small after resize')
  assert(vim.api.nvim_win_get_height(main) > 10, 'Conversation uses the main editor area')
end
view.open('other', main)
local other_chat = view.transcript
view.set_draft('Other chat draft')
show(chat)
assert(view.transcript == chat and view.draft() == 'Draft λ 世界\nSecond line', 'Native chat selection restores the correct draft')
assert(activations[#activations].old == other_chat, 'Root activation runs before the active view handles change')
assert(view.draft('other') == 'Other chat draft', 'Inactive chat draft remains available')
view.set_draft('', 'other')
assert(view.draft('other') == '' and view.draft() == 'Draft λ 世界\nSecond line', 'A late receipt can clear only its hidden chat draft')
vim.api.nvim_set_current_win(win(prompt))
vim.cmd('buffer ' .. source)
assert(vim.api.nvim_get_current_win() == main and vim.api.nvim_get_current_buf() == source, 'Native buffer commands from input move the file into the main window')
assert(#vim.api.nvim_tabpage_list_wins(0) == 1, 'Input navigation does not leave a small file window')
vim.cmd('bnext')
assert(vim.api.nvim_get_current_buf() == chat, 'Native next-buffer navigation includes chats')
assert(view.draft() == 'Draft λ 世界\nSecond line', 'Next-buffer navigation retains the chat draft')
vim.api.nvim_set_current_win(win(prompt))
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<C-^>', true, false, true), 'xt', false)
assert(vim.api.nvim_get_current_buf() == source and vim.api.nvim_get_current_win() == main, 'Ctrl-^ from input restores the previous file in the main area')
vim.cmd('buffer #')
vim.api.nvim_set_current_win(win(prompt))
vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.tempname()))
assert(vim.api.nvim_get_current_win() == main and vim.bo.buftype == '', 'Opening a new file from input uses the normal content area')
assert(vim.wo.winhighlight == '' and not vim.wo.winfixheight and vim.wo.winbar == '' and vim.wo.statusline == source_statusline, 'New files do not inherit input window decoration')
show(chat)
local filetype = vim.api.nvim_create_autocmd('FileType', { pattern = 'harness-view-test', callback = function()
  vim.wo.number, vim.wo.wrap = true, false
  vim.wo.winhighlight, vim.wo.winbar, vim.wo.statusline = 'Normal:DiffAdd', 'File title', 'File status'
end })
local newfile = vim.api.nvim_create_autocmd('BufNewFile', { pattern = '*.harness-view-test', callback = function() vim.bo.filetype = 'harness-view-test' end })
vim.api.nvim_set_current_win(win(prompt))
vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.tempname() .. '.harness-view-test'))
assert(vim.api.nvim_get_current_win() == main and vim.wo.number and not vim.wo.wrap, 'Native input navigation preserves FileType number and wrap settings')
assert(vim.wo.winhighlight == 'Normal:DiffAdd' and vim.wo.winbar == 'File title' and vim.wo.statusline == 'File status', 'FileType decorations take precedence over input decoration')
vim.api.nvim_del_autocmd(filetype)
vim.api.nvim_del_autocmd(newfile)
show(chat)
local first_tab = vim.api.nvim_get_current_tabpage()
vim.cmd('tabnew')
local second_tab, second_source, second_main = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
view.open('third', second_main)
view.set_draft('Third chat draft')
assert(vim.api.nvim_get_current_tabpage() == second_tab and win(view.transcript) == second_main, 'Opening a chat uses the current tab content area')
assert(vim.api.nvim_buf_is_valid(source) and vim.bo[source].modified, 'Opening another tab retains the hidden modified source')
vim.api.nvim_set_current_tabpage(first_tab)
assert(view.transcript == chat and view.draft() == 'Draft λ 世界\nSecond line', 'Entering another tab restores its visible chat')
vim.api.nvim_set_current_tabpage(second_tab)
assert(view.draft() == 'Third chat draft', 'Each chat keeps its own input across tabs')
vim.api.nvim_set_current_win(second_main)
vim.cmd('buffer ' .. second_source)

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
view.open('third', second_main)
vim.api.nvim_set_current_win(second_main)
vim.o.columns = 60
vim.api.nvim_exec_autocmds('VimResized', {})
assert(vim.api.nvim_get_current_win() == second_main and vim.api.nvim_get_current_buf() == view.transcript, 'A narrow resize preserves the content window focus')
for _, window in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  assert(vim.api.nvim_win_get_buf(window) ~= sidebar.buffer, 'A narrow resize hides only the current sidebar')
end
assert(vim.api.nvim_win_is_valid(first_sidebar), 'A narrow resize leaves other tab windows unchanged')
sidebar.toggle(requested_directory)
assert(win(sidebar.buffer), 'The sidebar can be opened on a narrow screen after resizing')
sidebar.hide()
assert(vim.api.nvim_win_is_valid(first_sidebar), 'Hiding the current sidebar does not close another tab window')
assert(view.draft('work') == 'Draft λ 世界\nSecond line', 'Sidebar operations preserve the chat draft')
local connecting = {}
transport.connect = function(callback) connecting[#connecting + 1] = callback end
sidebar.refresh(directory)
sidebar.refresh('/elsewhere')
connecting[1](nil, 'Previous workspace connection failed')
assert(#connecting == 2, 'A failed old refresh must continue the queued current-directory refresh')
connecting[2](true)
assert(text(sidebar.buffer):find('Other project', 1, true) and not text(sidebar.buffer):find('failed', 1, true), 'A stale directory error cannot replace the current agents list')
print('Neovim view checks passed: native chat buffers, file switching, bottom input, tab isolation, drafts, resize, workspace filter and parent-child tree.')
vim.cmd('noautocmd qa!')
