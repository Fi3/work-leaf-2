local root = vim.fn.getcwd()
vim.opt.runtimepath:append(root)
vim.o.columns, vim.o.lines = 120, 40
local source = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(source, 0, -1, false, { 'unsaved source' })
vim.wo.wrap = false
local changed = vim.api.nvim_buf_get_changedtick(source)
local view = require('harness.view').new({ width = 50, prompt_height = 5 })
local snapshot = vim.json.decode(table.concat(vim.fn.readfile(root .. '/tests/fixtures/protocol.json'), '\n')).snapshot
view.open()
local function win(buffer) return assert(vim.fn.win_findbuf(buffer)[1]) end
local function text() return table.concat(vim.api.nvim_buf_get_lines(view.transcript, 0, -1, false), '\n') end
view.render('connected', snapshot, {}, {})
assert(vim.wo[win(view.prompt)].winbar:find('Ctrl%-S'), 'The send key must be visible beside the prompt')
assert(view.draft() == '', 'The input hint must not become submitted text')
assert(vim.wo[win(view.prompt)].wrap and vim.wo[win(view.transcript)].wrap, 'Conversation and input wrap long lines')
assert(not vim.wo[win(source)].wrap, 'Source window options remain unchanged')
assert(not text():find('Submission:', 1, true), 'The main view must not require protocol identifiers')
view.set_draft('Draft λ 世界\nSecond line')
local lines = {}
for index = 1, 100 do lines[index] = { entry_id = 'entry-' .. index, kind = 'user', text = 'Message ' .. index, truncated = false } end
snapshot.entries, snapshot.usage = lines, { models = { test = { usage = { totalTokens = 123 } } } }
view.render('connected', snapshot, {}, {})
assert(text():find('[user] You', 1, true), 'Messages identify who spoke')
assert(text():find('Tokens used: 123', 1, true) and not text():find('totalTokens', 1, true), 'Usage is readable text')
vim.api.nvim_win_set_cursor(win(view.transcript), { 7, 0 })
vim.api.nvim_set_current_win(win(source))
view.render('connected', snapshot, {}, {})
assert(vim.api.nvim_get_current_buf() == source, 'Streaming must not move keyboard focus')
assert(vim.api.nvim_win_get_cursor(win(view.transcript))[1] == 7, 'Reading position must survive streaming')
for _, size in ipairs({ { 80, 24 }, { 60, 20 }, { 120, 40 } }) do
  vim.o.columns, vim.o.lines = size[1], size[2]
  -- Apply the new screen size without an attached terminal UI.
  vim.cmd('wincmd =')
  view.resize()
  assert(view.draft() == 'Draft λ 世界\nSecond line', 'Resizing keeps the exact multiline draft')
  assert(vim.api.nvim_get_current_buf() == source, 'Resizing retains source focus')
  assert(vim.api.nvim_buf_get_changedtick(source) == changed, 'Resizing does not edit the source')
  local source_position = vim.api.nvim_win_get_position(win(source))
  local transcript_position = vim.api.nvim_win_get_position(win(view.transcript))
  if size[1] < 110 then
    assert(transcript_position[1] > source_position[1] and transcript_position[2] == 0, 'Narrow terminals put the conversation below the source')
    assert(vim.api.nvim_win_get_width(win(view.prompt)) == size[1], 'Narrow prompt uses the available terminal width')
  else
    assert(transcript_position[2] > source_position[2], 'Wide terminals put the conversation beside the source')
  end
  assert(vim.api.nvim_win_get_height(win(source)) >= 2, 'The source remains visible')
end
view.set_draft('')
snapshot.entries, snapshot.usage = {}, vim.NIL
view.render('connected', snapshot, {}, {})
assert(text():find('What would you like to work on?', 1, true), 'An empty conversation explains the next step')
assert(view.draft() == '', 'The empty conversation must not alter the prompt')
vim.api.nvim_set_current_win(win(source))
vim.cmd('split')
local original = vim.api.nvim_get_current_win()
vim.o.columns = 80
vim.cmd('wincmd =')
view.resize()
assert(vim.api.nvim_get_current_win() == original, 'Resizing preserves focus when two windows show the same source buffer')
print('Neovim view checks passed: visible controls, readable messages, responsive layout, retained drafts and focus.')
vim.cmd('noautocmd qa!')
