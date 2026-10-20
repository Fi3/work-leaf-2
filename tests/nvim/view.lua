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
local function wait(predicate, message) assert(vim.wait(1000, predicate, 5), message) end
local function visible(buffer)
  for _, window in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(window) == buffer then return window end
  end
end
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
assert(vim.bo[chat].buftype == '' and vim.bo[chat].readonly and not vim.bo[chat].modifiable, 'File explorers see a normal buffer, protected from editing')
assert(vim.api.nvim_buf_get_name(chat) == 'harness://chat/work', 'Chat buffers have stable session names')
assert(view.session(chat) == 'work' and view.session(prompt) == 'work' and not view.session(source), 'Buffer identity distinguishes files from chats')
assert(vim.wo[win(prompt)].winbar:find('Enter send', 1, true), 'The send key must be visible beside the prompt')
assert(vim.wo[win(prompt)].winbar:find('Shift-Enter newline', 1, true), 'The preferred newline key must be visible')
local commands = {}
vim.api.nvim_create_user_command('Harness', function(command) commands[#commands + 1] = command.args end, { nargs = '*' })
view.set_draft('Keep this draft while choosing an action.')
for _, buffer in ipairs({ chat, prompt }) do
  local window = win(buffer)
  assert(vim.wo[window].winbar:find('F1 actions', 1, true), 'Each chat window shows the action key')
  vim.api.nvim_set_current_win(window)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<F1>', true, false, true), 'xt', false)
end
assert(vim.deep_equal(commands, { 'actions', 'actions' }) and view.draft() == 'Keep this draft while choosing an action.',
  'F1 opens actions from either chat window without replacing the draft')
vim.api.nvim_del_user_command('Harness')
view.set_draft('')
assert(vim.api.nvim_win_get_height(win(prompt)) == 3, 'New chat has a small three-line input')
assert(vim.wo[win(prompt)].winhighlight == 'Normal:NormalFloat', 'Input has a distinct native background')
assert(view.draft() == '', 'The input hint must not become submitted text')
assert(text(chat):find('New chat', 1, true), 'An unconfigured chat opens without a model')
assert(text(chat):find('\\model', 1, true) and text(chat):find('\\login', 1, true), 'An empty chat shows the next model and account actions')
assert(not text(chat):find('Type a task', 1, true), 'The conversation contains no opening instructions')
local failed = vim.deepcopy(snapshot)
local diagnostic = 'The provider rejected this model. Choose another model with \\model, then send the task again.'
failed.state, failed.error = 'idle', { kind = 'provider_error', message = diagnostic }
failed.entries = {
  { entry_id = 'request', kind = 'user', text = 'Answer this task.', truncated = false },
  { entry_id = 'empty', kind = 'assistant', text = '', truncated = false },
  { entry_id = 'spaces', kind = 'assistant', text = ' \n\t', truncated = false },
  { entry_id = 'failure', kind = 'error', text = diagnostic, truncated = false },
}
failed.usage = { models = { model = { usage = { totalTokens = 5 } } } }
view.set_draft('Draft written while the request was running')
view.render('connected', failed, {}, { { kind = 'buffer', path = 'source.txt' } }, 'Task has ended.')
assert(not text(chat):find('[assistant] Agent', 1, true), 'Empty failed attempts must not appear as assistant answers')
assert(text(chat):find('[error] Run failed', 1, true), 'The failed run must have an explicit error label')
local _, copies = text(chat):gsub(vim.pesc(diagnostic), '')
assert(copies == 1 and vim.api.nvim_buf_get_lines(chat, -2, -1, false)[1] == diagnostic,
  'The latest failure and remedy appear once at the end of the conversation')
local marked = false
for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(chat, vim.api.nvim_create_namespace('HarnessView'), 0, -1, { details = true })) do
  if mark[4].hl_group == 'DiagnosticError' then marked = true end
end
assert(marked, 'The failed run uses the native error highlight')
assert(view.draft() == 'Draft written while the request was running', 'Failure rendering keeps the later unsent draft')
table.insert(failed.entries, 1, { entry_id = 'earlier-failure', kind = 'error', text = diagnostic, truncated = false })
view.render('connected', failed, {}, {}, 'Task has ended.')
_, copies = text(chat):gsub(vim.pesc(diagnostic), '')
assert(copies == 2 and vim.api.nvim_buf_get_lines(chat, -2, -1, false)[1] == diagnostic,
  'An earlier identical failure remains in history while the latest failure stays last')
failed.entries = {
  { entry_id = 'partial', kind = 'assistant', text = 'Partial answer before the failure.', truncated = false },
  { entry_id = 'truncated', kind = 'assistant', text = '', truncated = true },
}
view.render('connected', failed, {}, {})
assert(text(chat):find('Partial answer before the failure.', 1, true)
  and text(chat):find('[Text truncated.', 1, true), 'Partial and truncated assistant entries remain visible')
assert(vim.api.nvim_buf_get_lines(chat, -2, -1, false)[1] == diagnostic, 'A snapshot error remains visible when it has no matching entry')
failed.error, failed.entries = vim.NIL, { { entry_id = 'answer', kind = 'assistant', text = 'The next task succeeded.', truncated = false } }
view.render('connected', failed, {}, {})
assert(text(chat):find('The next task succeeded.', 1, true) and not text(chat):find('[error]', 1, true),
  'A later successful snapshot removes the current failure without changing the draft')
failed.state, failed.error = 'blocked', { kind = 'not_ready', message = 'Restore the workspace before resuming the pending run.' }
view.render('connected', failed, {}, {})
assert(text(chat):find('State: blocked', 1, true) and text(chat):find('[error] Cannot run', 1, true),
  'Blocked recovery remains distinct from a terminal provider failure')
view.set_draft('')
view.render('connected', snapshot, {}, {})
assert(vim.wo[win(prompt)].wrap and vim.wo[main].wrap, 'Conversation and input wrap long lines')
assert(vim.bo[source].modified and vim.api.nvim_buf_is_loaded(source), 'An unsaved file remains loaded when replaced by chat')
assert(not text(chat):find('Submission:', 1, true), 'The main view must not require protocol identifiers')
local context_ok, context_error = pcall(require('harness.context').capture, chat, '/tmp')
assert(not context_ok and context_error:find('file buffer', 1, true), 'Chat history cannot be attached as source-file context')
local export = vim.fn.tempname()
local write_ok, write_error = pcall(vim.api.nvim_win_call, main, function() vim.cmd('keepalt write! ' .. vim.fn.fnameescape(export)) end)
assert(not write_ok and write_error:find('Chat history is stored by Harness', 1, true), 'A forced write cannot turn chat history into a file')
assert(not vim.uv.fs_stat(export) and not vim.bo[chat].modified, 'Rejected chat writes leave the transcript clean and create no file')
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
wait(function() return not visible(prompt) end, 'File selection hides input after the editor completes its buffer change')
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
wait(function() return visible(prompt) end, 'Chat selection restores input after the editor completes its buffer change')
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
wait(function() return visible(prompt) end, 'Switching between chats restores the selected input')
assert(view.transcript == chat and view.draft() == 'Draft λ 世界\nSecond line', 'Native chat selection restores the correct draft')
assert(activations[#activations].old == other_chat, 'Root activation runs before the active view handles change')
assert(view.draft('other') == 'Other chat draft', 'Inactive chat draft remains available')
view.set_draft('', 'other')
assert(view.draft('other') == '' and view.draft() == 'Draft λ 世界\nSecond line', 'A late receipt can clear only its hidden chat draft')
vim.api.nvim_set_current_win(win(prompt))
vim.cmd('buffer ' .. source)
wait(function() return not visible(prompt) and vim.api.nvim_get_current_win() == main end, 'Input buffer navigation moves the file into the content window')
assert(vim.api.nvim_get_current_win() == main and vim.api.nvim_get_current_buf() == source, 'Native buffer commands from input move the file into the main window')
assert(#vim.api.nvim_tabpage_list_wins(0) == 1, 'Input navigation does not leave a small file window')
vim.cmd('bnext')
wait(function() return visible(prompt) end, 'Native next-buffer navigation restores the chat input')
assert(vim.api.nvim_get_current_buf() == chat, 'Native next-buffer navigation includes chats')
assert(view.draft() == 'Draft λ 世界\nSecond line', 'Next-buffer navigation retains the chat draft')
vim.api.nvim_set_current_win(win(prompt))
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<C-^>', true, false, true), 'xt', false)
wait(function() return not visible(prompt) end, 'The alternate-file key hides the input')
assert(vim.api.nvim_get_current_buf() == source and vim.api.nvim_get_current_win() == main, 'Ctrl-^ from input restores the previous file in the main area')
vim.cmd('buffer #')
wait(function() return visible(prompt) end, 'The alternate chat restores its input')
vim.api.nvim_set_current_win(win(prompt))
vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.tempname()))
wait(function() return not visible(prompt) and vim.api.nvim_get_current_win() == main end, 'Opening a new file from input completes its move')
assert(vim.api.nvim_get_current_win() == main and vim.bo.buftype == '', 'Opening a new file from input uses the normal content area')
assert(vim.wo.winhighlight == '' and not vim.wo.winfixheight and vim.wo.winbar == '' and vim.wo.statusline == source_statusline, 'New files do not inherit input window decoration')
show(chat)
wait(function() return visible(prompt) end, 'Chat input is available before the FileType check')
local filetype = vim.api.nvim_create_autocmd('FileType', { pattern = 'harness-view-test', callback = function()
  vim.wo.number, vim.wo.wrap = true, false
  vim.wo.winhighlight, vim.wo.winbar, vim.wo.statusline = 'Normal:DiffAdd', 'File title', 'File status'
end })
local newfile = vim.api.nvim_create_autocmd('BufNewFile', { pattern = '*.harness-view-test', callback = function() vim.bo.filetype = 'harness-view-test' end })
vim.api.nvim_set_current_win(win(prompt))
vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.tempname() .. '.harness-view-test'))
wait(function() return not visible(prompt) and vim.api.nvim_get_current_win() == main end, 'FileType handling completes before input relocation')
assert(vim.api.nvim_get_current_win() == main and vim.wo.number and not vim.wo.wrap, 'Native input navigation preserves FileType number and wrap settings')
assert(vim.wo.winhighlight == 'Normal:DiffAdd' and vim.wo.winbar == 'File title' and vim.wo.statusline == 'File status', 'FileType decorations take precedence over input decoration')
vim.api.nvim_del_autocmd(filetype)
vim.api.nvim_del_autocmd(newfile)
show(chat)
wait(function() return visible(prompt) end, 'Chat input is restored before switching tabs')
local first_tab = vim.api.nvim_get_current_tabpage()
vim.cmd('tabnew')
local second_tab, second_source, second_main = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
view.open('third', second_main)
view.set_draft('Third chat draft')
assert(vim.api.nvim_get_current_tabpage() == second_tab and win(view.transcript) == second_main, 'Opening a chat uses the current tab content area')
assert(vim.api.nvim_buf_is_valid(source) and vim.bo[source].modified, 'Opening another tab retains the hidden modified source')
vim.api.nvim_set_current_tabpage(first_tab)
wait(function() return visible(prompt) end, 'Returning to a tab restores its chat input')
assert(view.transcript == chat and view.draft() == 'Draft λ 世界\nSecond line', 'Entering another tab restores its visible chat')
vim.api.nvim_set_current_tabpage(second_tab)
assert(view.draft() == 'Third chat draft', 'Each chat keeps its own input across tabs')
vim.api.nvim_set_current_win(second_main)
vim.cmd('buffer ' .. second_source)
wait(function() return not visible(view.prompt) end, 'The second tab file hides its input')

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
local lookup, calls, snapshots, selected, created = {}, {}, {}, nil, nil
local defer_list, pending_list
local requested_directory = directory
for _, item in ipairs(items) do lookup[item.session_id] = item end
local transport = { connected = true, connect = function(callback) callback(true) end }
function transport.request(method, params, callback)
  calls[#calls + 1] = { method = method, params = params }
  if method == 'session.list' then
    assert(params.workspace == requested_directory, 'Listing is restricted to the current workspace')
    if defer_list then pending_list = callback else callback({ items = items, next_cursor = vim.NIL }) end
  elseif method == 'session.get' then
    callback({ session = lookup[params.session_id], snapshot = snapshots[params.session_id]
      or { session = lookup[params.session_id], state = 'running', active_submission_id = 'run-' .. params.session_id } })
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
local function list_count()
  local count = 0
  for _, call in ipairs(calls) do if call.method == 'session.list' then count = count + 1 end end
  return count
end
sidebar.toggle(directory)
assert(list_count() == 1, 'Opening the tree requests the session list once')
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
row('Parent (root-B)')
local tree_window, before_refresh = win(sidebar.buffer), list_count()
local function selected_tree_line()
  local index = vim.api.nvim_win_get_cursor(tree_window)[1]
  return vim.api.nvim_buf_get_lines(sidebar.buffer, index - 1, index, false)[1]
end
vim.api.nvim_set_current_win(second_main)
local new_child = { session_id = 'new-child', name = 'A new child', parent_session_id = 'root-A', workspace = directory }
items[#items + 1], lookup[new_child.session_id] = new_child, new_child
snapshots['root-A'] = { session = lookup['root-A'], state = 'idle', active_submission_id = vim.NIL }
defer_list = true
sidebar.update(snapshots['root-A'])
assert(list_count() == before_refresh + 1 and text(sidebar.buffer):find('Loading', 1, true),
  'A visible task completion refreshes the child list without a manual key')
assert(selected_tree_line():find('Parent (root-B)', 1, true), 'The highlighted agent survives the temporary Loading row')
defer_list = false
pending_list({ items = items, next_cursor = vim.NIL })
assert(text(sidebar.buffer):find('A new child', 1, true) and selected_tree_line():find('Parent (root-B)', 1, true),
  'A new child appears without changing the highlighted agent')
assert(vim.api.nvim_get_current_win() == second_main, 'A background tree refresh does not take file focus')
sidebar.update(snapshots['root-A'])
snapshots['root-A'] = { session = lookup['root-A'], state = 'running', active_submission_id = 'next-run' }
sidebar.update(snapshots['root-A']); sidebar.update(snapshots['root-A'])
sidebar.update({ session = lookup.foreign, state = 'running', active_submission_id = 'foreign-run' })
sidebar.update({ session = lookup.foreign, state = 'idle', active_submission_id = vim.NIL })
assert(list_count() == before_refresh + 1, 'Repeated states, streamed progress and other workspaces do not reload the list')
local external = { session_id = 'external', name = 'External chat', workspace = directory }
items[#items + 1], lookup.external = external, external
vim.api.nvim_set_current_win(tree_window)
assert(list_count() == before_refresh + 2 and text(sidebar.buffer):find('External chat', 1, true),
  'Native entry into the tree discovers an agent made by another client')
assert(selected_tree_line():find('Parent (root-B)', 1, true), 'Entering the tree keeps the selected agent')
row('+ New chat'); sidebar.refresh()
assert(selected_tree_line() == '+ New chat', 'Refresh keeps the New action selected')
sidebar.hide()
before_refresh = list_count()
snapshots['root-A'] = { session = lookup['root-A'], state = 'idle', active_submission_id = vim.NIL }
sidebar.update(snapshots['root-A'])
assert(list_count() == before_refresh, 'A hidden tree does not request a list when a task finishes')
vim.api.nvim_set_current_tabpage(first_tab)
sidebar.toggle(directory)
assert(list_count() == before_refresh + 1, 'Reopening the tree requests one fresh list')
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

local function layout_case(name, run)
  vim.o.columns, vim.o.lines = 120, 40
  vim.cmd('tabnew')
  local file, main_window = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
  vim.api.nvim_buf_set_name(file, vim.fn.tempname())
  vim.api.nvim_buf_set_lines(file, 0, -1, false, { 'Unsaved file for ' .. name })
  vim.wo.wrap, vim.wo.number, vim.wo.winfixheight = false, true, false
  local id = 'layout-' .. name
  view.open(id, main_window)
  view.set_draft('Draft for ' .. name)
  run(main_window, file, view.transcript, view.prompt)
  assert(view.draft(id) == 'Draft for ' .. name, 'Layout changes preserve the draft: ' .. name)
  assert(vim.api.nvim_buf_get_lines(file, 0, -1, false)[1] == 'Unsaved file for ' .. name and vim.bo[file].modified,
    'Layout changes preserve unsaved source text: ' .. name)
  vim.cmd('stopinsert')
  vim.cmd('tabclose!')
end
local function beneath(chat_window, input)
  local input_window = visible(input)
  if not input_window then return false end
  local chat_position, input_position = vim.api.nvim_win_get_position(chat_window), vim.api.nvim_win_get_position(input_window)
  return input_position[1] > chat_position[1] and input_position[2] == chat_position[2]
    and vim.api.nvim_win_get_width(input_window) == vim.api.nvim_win_get_width(chat_window)
    and vim.api.nvim_win_get_height(input_window) == 3
end
layout_case('close-input', function(main_window, _, chat_buffer, input)
  assert(pcall(vim.cmd, 'q'), 'Closing input must not split a window during QuitPre/WinClosed')
  wait(function() return not visible(input) end, 'Explicitly closed input stays hidden')
  view.resize()
  assert(vim.api.nvim_win_get_buf(main_window) == chat_buffer and not visible(input), 'Resize does not reopen explicitly closed input')
  view.focus()
  wait(function() return beneath(main_window, input) end, 'The explicit focus action can reopen the input')
end)
layout_case('close-chat', function(main_window, file, _, input)
  vim.api.nvim_set_current_win(main_window)
  assert(pcall(vim.cmd, 'q'), 'Closing the chat must finish without a layout error')
  wait(function() return not visible(input) and vim.api.nvim_get_current_buf() == file end, 'Closing the last chat restores its unsaved file instead of an orphan input')
  assert(#vim.api.nvim_tabpage_list_wins(0) == 1, 'Chat closure leaves one normal file window')
  assert(not vim.wo.winfixheight and not vim.wo.wrap and vim.wo.number, 'The restored source keeps file options without the input height lock')
end)
layout_case('close-chat-with-float', function(main_window, file, _, input)
  local floating_buffer = vim.api.nvim_create_buf(false, true)
  local floating = vim.api.nvim_open_win(floating_buffer, false, { relative = 'editor', row = 1, col = 1, width = 10, height = 2 })
  vim.api.nvim_set_current_win(main_window)
  assert(pcall(vim.cmd, 'q'), 'An unrelated floating window must not prevent normal chat closure')
  wait(function() return not visible(input) and vim.api.nvim_get_current_buf() == file end, 'The last normal input becomes its source file even with a float present')
  assert(vim.api.nvim_win_is_valid(floating) and vim.api.nvim_win_get_buf(floating) == floating_buffer, 'Chat cleanup does not change unrelated floating windows')
  vim.api.nvim_win_close(floating, false)
end)
for _, command in ipairs({ 'new', 'vnew', 'split', 'vsplit' }) do
  layout_case(command .. '-from-input', function(main_window, _, chat_buffer, input)
    local path = vim.fn.tempname()
    vim.cmd(command .. ' ' .. vim.fn.fnameescape(path))
    local file_window = vim.api.nvim_get_current_win()
    wait(function() return not visible(input) end, 'A native split file does not keep chat input')
    assert(file_window ~= main_window and vim.api.nvim_win_get_buf(main_window) == chat_buffer, 'Native split commands use the main content area')
    assert(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(file_window)) == path
      and vim.api.nvim_win_get_height(file_window) > 3, 'A split file opens in an ordinary editor window')
    assert(pcall(vim.cmd, 'q'), 'Closing a file split must not reopen input inside the close event')
    wait(function() return beneath(main_window, input) end, 'Returning from a closed file split restores chat input')
  end)
end
layout_case('enew-from-input', function(main_window, _, _, input)
  vim.cmd('enew')
  wait(function() return not visible(input) and vim.api.nvim_get_current_win() == main_window end, 'A new unnamed file replaces chat in the normal content window')
  assert(vim.bo.buftype == '' and vim.api.nvim_win_get_height(main_window) > 3, 'An unnamed file is not left in the input rectangle')
end)
layout_case('same-chat-windows', function(main_window, _, chat_buffer, input)
  vim.cmd('vsplit')
  local copied_window = vim.api.nvim_get_current_win()
  wait(function() return beneath(copied_window, input) end, 'Splitting input creates a chat view with input under only that column')
  assert(vim.api.nvim_win_get_buf(copied_window) == chat_buffer and copied_window ~= main_window, 'Native splitting never copies the input as content')
  vim.api.nvim_set_current_win(main_window)
  wait(function() return beneath(main_window, input) end, 'Window navigation between copies moves input under the selected chat')
  assert(#vim.fn.win_findbuf(input) == 1, 'One tab has only one chat input window')
  vim.cmd('wincmd H')
  -- Headless Neovim does not emit WinResized; the attached UI suite covers it.
  view.resize()
  wait(function() return beneath(main_window, input) end, 'Moving the chat repairs input position and height')
end)
layout_case('file-window-navigation', function(main_window, _, _, input)
  vim.cmd('vnew ' .. vim.fn.fnameescape(vim.fn.tempname()))
  local file_window = vim.api.nvim_get_current_win()
  wait(function() return not visible(input) end, 'File focus hides input')
  vim.api.nvim_set_current_win(main_window)
  wait(function() return beneath(main_window, input) end, 'Chat focus restores its input')
  vim.api.nvim_set_current_win(file_window)
  wait(function() return not visible(input) end, 'Window or mouse navigation back to a file hides input again')
  view.resize()
  assert(vim.api.nvim_get_current_win() == file_window and not visible(input), 'A later layout update retains file focus and keeps input hidden')
end)
layout_case('plugin-buffer-change', function(main_window, file, _, input)
  vim.api.nvim_win_set_buf(main_window, file)
  wait(function() return not visible(input) and vim.api.nvim_get_current_win() == main_window end, 'A plugin can replace the main chat while input has focus')
  local latest = activations[#activations]
  assert(latest.buffer == file and latest.window == main_window and not latest.id, 'Input closure reports the new file window for source context')
  view.open('layout-plugin-buffer-change', main_window)
  local input_window = visible(input)
  view.select('layout-plugin-selected-chat')
  local next_chat, next_input = view.transcript, view.prompt
  view.select('layout-plugin-buffer-change')
  vim.api.nvim_win_set_buf(input_window, next_chat)
  wait(function() return vim.api.nvim_win_get_buf(main_window) == next_chat and beneath(main_window, next_input) end, 'A plugin-selected chat is moved out of input into the main area')
  assert(not visible(input), 'Selecting another chat removes the former input window')
end)
layout_case('tab-split-input', function(main_window, _, chat_buffer, input)
  local original_tab = vim.api.nvim_get_current_tabpage()
  vim.cmd('tab split')
  local new_main = vim.api.nvim_get_current_win()
  wait(function() return vim.api.nvim_win_get_buf(new_main) == chat_buffer and beneath(new_main, input) end, 'A copied input tab becomes a normal chat with small input')
  vim.cmd('tabclose!')
  assert(vim.api.nvim_get_current_tabpage() == original_tab and vim.api.nvim_win_is_valid(main_window), 'Closing the copied tab leaves the original chat window')
end)
layout_case('narrow-chat-tree', function(main_window, _, chat_buffer, input)
  vim.cmd('rightbelow vnew ' .. vim.fn.fnameescape(vim.fn.tempname()))
  local sibling, sibling_buffer = vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()
  wait(function() return not visible(input) end, 'The second file column hides chat input')
  local sibling_width = vim.api.nvim_win_get_width(sibling)
  vim.api.nvim_set_current_win(main_window)
  wait(function() return visible(input) end, 'Return to the chat column')
  sidebar.toggle(directory)
  view.resize()
  assert(not visible(sidebar.buffer), 'The agent tree closes if it would leave a chat narrower than forty columns')
  assert(vim.api.nvim_win_get_width(main_window) >= 40 and vim.api.nvim_win_get_buf(main_window) == chat_buffer, 'The chat remains readable in its own column')
  assert(vim.api.nvim_win_get_buf(sibling) == sibling_buffer and math.abs(vim.api.nvim_win_get_width(sibling) - sibling_width) <= 1,
    'Tree cleanup retains the other file column, with only native split rounding')
end)
layout_case('closed-explorer-width', function(main_window, _, chat_buffer, input)
  sidebar.toggle(directory)
  local tree = win(sidebar.buffer)
  vim.cmd('topleft 40vnew')
  local explorer = vim.api.nvim_get_current_win()
  vim.bo.buftype, vim.wo.winfixwidth = 'nofile', true
  vim.api.nvim_set_current_win(main_window)
  vim.cmd('leftabove vnew ' .. vim.fn.fnameescape(vim.fn.tempname()))
  local file_window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_close(explorer, false)
  wait(function() return not visible(input) and vim.api.nvim_win_get_width(tree) == 32 end,
    'Closing an adjacent explorer must not enlarge the fixed agent tree')
  assert(vim.api.nvim_get_current_win() == file_window and vim.api.nvim_win_get_buf(main_window) == chat_buffer,
    'Restoring tree width preserves the file focus and chat window')
  assert(math.abs(vim.api.nvim_win_get_width(file_window) - vim.api.nvim_win_get_width(main_window)) <= 1,
    'Native equalalways gives the remaining file and chat equal column widths')
  assert(vim.api.nvim_win_get_height(file_window) == vim.api.nvim_win_get_height(main_window),
    'Width restoration does not add a prompt below the focused file')
end)

print('Neovim view checks passed: native chat buffers, file switching, bottom input, tab isolation, drafts, resize, workspace filter and parent-child tree.')
vim.cmd('noautocmd qa!')
