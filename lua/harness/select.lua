local M = {}
local active

function M.select(items, options, callback)
  if active then active() end
  if #items == 0 then callback(nil, nil); return end
  options = options or {}
  local previous, mouse = vim.api.nvim_get_current_win(), vim.o.mouse
  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, 'harness://select')
  vim.bo[buffer].bufhidden, vim.bo[buffer].buftype = 'wipe', 'nofile'
  vim.bo[buffer].swapfile, vim.bo[buffer].filetype = false, 'harness'
  local selected = items[options.selected] and options.selected or 1
  local lines, longest = {}, 40
  for index, item in ipairs(items) do
    local label = tostring(options.format_item and options.format_item(item) or item):gsub('[\r\n]', ' ')
    lines[index] = ' ' .. label .. (index == options.selected and ' [current]' or '')
    longest = math.max(longest, vim.fn.strdisplaywidth(lines[index]) + 1)
  end
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable = false
  local function bounds()
    local width = math.max(1, math.min(longest, 90, vim.o.columns - 4))
    local height = math.max(1, math.min(#items, 18, vim.o.lines - 6))
    return { relative = 'editor', width = width, height = height,
      row = math.max(0, math.floor((vim.o.lines - height - 2) / 2)),
      col = math.max(0, math.floor((vim.o.columns - width - 2) / 2)),
      border = 'rounded', style = 'minimal', title = options.prompt or 'Select an item', title_pos = 'left' }
  end
  vim.cmd('stopinsert')
  local window = vim.api.nvim_open_win(buffer, true, bounds())
  vim.wo[window].cursorline, vim.wo[window].wrap = true, false
  vim.wo[window].scrolloff, vim.wo[window].sidescrolloff = 1, 0
  vim.api.nvim_win_set_cursor(window, { selected, 0 })
  vim.o.mouse = 'a'
  local group = vim.api.nvim_create_augroup('HarnessSelect' .. buffer, { clear = true })
  local closed = false
  local function finish(index)
    if closed then return end
    closed, active = true, nil
    vim.api.nvim_del_augroup_by_id(group)
    local focused = vim.api.nvim_get_current_win() == window
    if vim.api.nvim_win_is_valid(window) then vim.api.nvim_win_close(window, true) end
    if vim.api.nvim_buf_is_valid(buffer) then vim.api.nvim_buf_delete(buffer, { force = true }) end
    if vim.o.mouse == 'a' then vim.o.mouse = mouse end
    if focused and vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
    callback(index and items[index] or nil, index)
  end
  active = function() finish(nil) end
  local function footer()
    if closed or not vim.api.nvim_win_is_valid(window) then return end
    local width = vim.api.nvim_win_get_width(window)
    local keys = width >= 55 and '  ↑↓ move  / search  Enter select  Esc cancel' or '  Enter select  Esc cancel'
    vim.api.nvim_win_set_config(window, { footer = ' ' .. vim.api.nvim_win_get_cursor(window)[1] .. '/' .. #items .. keys .. ' ', footer_pos = 'left' })
  end
  vim.keymap.set('n', '<CR>', function() finish(vim.api.nvim_win_get_cursor(window)[1]) end, { buffer = buffer, silent = true })
  for _, key in ipairs({ '<Esc>', 'q' }) do
    vim.keymap.set('n', key, function() finish(nil) end, { buffer = buffer, silent = true })
  end
  vim.keymap.set('n', '<2-LeftMouse>', function()
    local position = vim.fn.getmousepos()
    if position.winid == window and items[position.line] then finish(position.line) end
  end, { buffer = buffer, silent = true })
  vim.api.nvim_create_autocmd('CursorMoved', { group = group, buffer = buffer, callback = footer })
  vim.api.nvim_create_autocmd('VimResized', { group = group, callback = function()
    if vim.api.nvim_win_is_valid(window) then vim.api.nvim_win_set_config(window, bounds()); footer() end
  end })
  vim.api.nvim_create_autocmd({ 'WinLeave', 'BufLeave' }, { group = group, buffer = buffer, callback = function()
    vim.schedule(function() if not closed and vim.api.nvim_get_current_win() ~= window then finish(nil) end end)
  end })
  vim.api.nvim_create_autocmd('WinClosed', { group = group, pattern = tostring(window), callback = function()
    vim.schedule(function() finish(nil) end)
  end })
  footer()
end

return M
