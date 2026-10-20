local M = {}
local active

local function after_terminal(callback)
  vim.api.nvim_create_autocmd('TermLeave', { once = true, callback = function() vim.schedule(callback) end })
end

local function terminal_copy(value)
  if #vim.api.nvim_list_uis() == 0 then return false end
  return pcall(function() require('vim.ui.clipboard.osc52').copy('+')({ value }) end)
end

function M.click(index, _, button)
  local actions = active
  if actions and button == 'l' and vim.fn.getmousepos().winid == actions.window then
    vim.api.nvim_set_current_win(actions.window)
    actions[index]()
    if active == actions then actions.resume() end
  end
end

function M.new(transport, report)
  local self = {}
  local function enter()
    local window = self.window
    vim.schedule(function()
      if self.window == window and vim.api.nvim_get_current_win() == window then vim.cmd('startinsert') end
    end)
  end

  function self.open(provider, method, callback)
    if self.window and vim.api.nvim_win_is_valid(self.window) then
      vim.api.nvim_set_current_win(self.window)
      vim.api.nvim_win_set_buf(self.window, self.buffer)
      enter()
      return
    end
    local previous = vim.api.nvim_get_current_win()
    local buffer = vim.api.nvim_create_buf(false, true)
    self.buffer = buffer
    vim.bo[buffer].bufhidden = 'hide'
    local function bounds()
      local width, height = math.max(1, math.min(76, vim.o.columns - 4)), math.max(1, math.min(22, vim.o.lines - 4))
      return { relative = 'editor', width = width, height = height,
        row = math.max(0, math.floor((vim.o.lines - height - 2) / 2)), col = math.max(0, math.floor((vim.o.columns - width - 2) / 2)),
        border = 'single', title = ' ' .. provider.name .. ' · ' .. method.name .. ' ', style = 'minimal' }
    end
    local window = vim.api.nvim_open_win(buffer, true, bounds())
    self.window = window
    local group = vim.api.nvim_create_augroup('HarnessLogin' .. buffer, { clear = true })
    local job, link, code, link_buffer, ended, closed
    local actions = { window = window }
    actions.resume = function()
      if not ended and vim.api.nvim_win_get_buf(window) == buffer then enter() end
    end
    active = actions
    local function close(succeeded, focused)
      if closed then return end
      closed = true
      if focused == nil then focused = vim.api.nvim_get_current_win() == window end
      local delayed = focused and vim.api.nvim_get_current_win() == window
        and vim.api.nvim_get_current_buf() == buffer and vim.fn.mode() == 't'
      local function complete() if callback then callback(focused, succeeded) end end
      if delayed then after_terminal(complete) end
      vim.api.nvim_del_augroup_by_id(group)
      if active == actions then active = nil end
      self.window, self.buffer = nil, nil
      if vim.api.nvim_win_is_valid(window) then vim.api.nvim_win_close(window, true) end
      for _, buf in ipairs({ buffer, link_buffer }) do
        if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
      end
      if focused and vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
      if not delayed then complete() end
    end
    local function cancel()
      if ended then close(false)
      elseif job and job > 0 then vim.fn.chansend(job, '\003') end
    end
    local function toolbar()
      if closed or not vim.api.nvim_win_is_valid(window) then return end
      local width = vim.api.nvim_win_get_width(window)
      local labels = width >= 54 and { 'Copy Ctrl-X', 'Open Ctrl-O', 'Link Ctrl-L', 'Esc cancel' }
        or width >= 34 and { 'Copy ^X', 'Open ^O', 'Link ^L', 'Esc' } or { 'Copy', 'Open', 'Link', 'Esc' }
      if ended then labels = { 'Close' } elseif not link then labels = { 'Esc cancel' } end
      local parts = {}
      for index, label in ipairs(labels) do
        local action = ended and 1 or not link and 3 or ({ 1, 2, 4, 3 })[index]
        parts[#parts + 1] = '%' .. action .. "@v:lua.require'harness.setup'.click@ " .. label .. ' %T'
      end
      vim.wo[window].winbar = table.concat(parts)
      if link then vim.api.nvim_win_set_config(window, { footer = ' Ctrl-L: full link ', footer_pos = 'left' }) end
    end
    local function input()
      if closed then return end
      vim.api.nvim_win_set_buf(window, buffer)
      enter()
    end
    local function show_link(message, value)
      value = value or link
      if not value or closed then return end
      if vim.api.nvim_get_current_win() == window and vim.fn.mode() == 't' then
        after_terminal(function()
          if not closed and vim.api.nvim_get_current_win() == window then show_link(message, value) end
        end)
        vim.cmd('stopinsert')
        return
      end
      vim.fn.setreg('"', value, 'v')
      if not link_buffer or not vim.api.nvim_buf_is_valid(link_buffer) then
        link_buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_name(link_buffer, 'harness://login-link')
        vim.bo[link_buffer].bufhidden = 'hide'
        for _, key in ipairs({ '<CR>', 'i' }) do vim.keymap.set('n', key, input, { buffer = link_buffer, silent = true }) end
        for _, key in ipairs({ '<Esc>', '<C-c>' }) do vim.keymap.set({ 'n', 'v' }, key, cancel, { buffer = link_buffer, silent = true }) end
        vim.keymap.set({ 'n', 'v' }, '<C-x>', function() actions[1]() end, { buffer = link_buffer, silent = true })
        vim.keymap.set({ 'n', 'v' }, '<C-o>', function() actions[2]() end, { buffer = link_buffer, silent = true })
        vim.keymap.set({ 'n', 'v' }, '<C-l>', function() actions[4]() end, { buffer = link_buffer, silent = true })
        vim.keymap.set({ 'n', 'v' }, '<C-y>', function() actions[5]() end, { buffer = link_buffer, silent = true })
      end
      vim.bo[link_buffer].modifiable = true
      vim.api.nvim_buf_set_lines(link_buffer, 0, -1, false, { value, '', message,
        (value == link and 'Link' or 'Device code') .. ' copied to the Vim register.', 'yy: copy line · Enter/i: input · Esc: cancel' })
      vim.bo[link_buffer].modifiable = false
      vim.cmd('stopinsert')
      vim.api.nvim_win_set_buf(window, link_buffer)
      vim.wo[window].wrap = true
      vim.api.nvim_win_set_cursor(window, { 1, 0 })
    end
    local function copy(value)
      if not value then return end
      local ok = false
      if vim.fn.has('clipboard') == 1 then ok = pcall(vim.fn.setreg, '+', value, 'v')
      else ok = terminal_copy(value) end
      if ok then
        vim.api.nvim_win_set_config(window, { footer = ' Copy requested · Ctrl-L: link ', footer_pos = 'left' })
      else show_link('System clipboard unavailable.', value) end
    end
    local function open()
      if not link then return end
      local ok, process = pcall(vim.ui.open, link)
      if not ok or not process then show_link('Browser could not open. Copy this complete link.') end
    end
    actions[1], actions[2], actions[3], actions[4], actions[5] =
      function() copy(link) end, open, cancel, function() show_link('Complete login link.') end, function() copy(code) end
    for _, mode in ipairs({ 't', 'n', 'v' }) do
      for _, key in ipairs({ '<Esc>', '<C-c>' }) do vim.keymap.set(mode, key, cancel, { buffer = buffer, silent = true }) end
      vim.keymap.set(mode, '<C-x>', actions[1], { buffer = buffer, silent = true, desc = 'Copy login link' })
      vim.keymap.set(mode, '<C-o>', open, { buffer = buffer, silent = true, desc = 'Open login link' })
      vim.keymap.set(mode, '<C-l>', actions[4], { buffer = buffer, silent = true, desc = 'Select complete login link' })
      vim.keymap.set(mode, '<C-y>', actions[5], { buffer = buffer, silent = true, desc = 'Copy device code' })
    end
    for _, key in ipairs({ '<Esc>', '<C-c>', '<C-l>' }) do
      vim.keymap.set('t', key, '<C-\\><C-n>' .. key, { buffer = buffer, remap = true, silent = true })
    end
    vim.api.nvim_create_autocmd('TermRequest', { group = group, buffer = buffer, callback = function(event)
      local url = event.data.sequence:match('^\027%]8;id=harness%-login;(.*)$')
      if url and #url <= 8192 and url:match('^https?://%S+$') and not url:find('%c') then
        link, code = url, nil
        vim.schedule(toolbar)
      end
      local encoded, target = event.data.sequence:match('^\027%]8;id=harness%-code%-([A-Za-z0-9+/=]+);(.*)$')
      if encoded and #encoded <= 1368 and target == link then
        local ok, value = pcall(vim.base64.decode, encoded)
        if ok and #value > 0 and #value <= 1024 and not value:find('%c') and not value:find('\194[\128-\159]') then code = value end
      end
    end })
    vim.api.nvim_create_autocmd('VimResized', { group = group, callback = function()
      if not closed and vim.api.nvim_win_is_valid(window) then vim.api.nvim_win_set_config(window, bounds()); toolbar() end
    end })
    vim.api.nvim_create_autocmd('WinClosed', { group = group, pattern = tostring(window), callback = function()
      local focused = vim.api.nvim_get_current_win() == window
      vim.schedule(function() close(false, focused and vim.api.nvim_get_current_win() == previous) end)
    end })
    vim.api.nvim_create_autocmd('BufWipeout', { group = group, buffer = buffer, callback = function()
      local focused = vim.api.nvim_get_current_win() == window
      vim.schedule(function() close(false, focused and vim.api.nvim_get_current_win() == window) end)
    end })
    local arguments = transport.arguments('auth')
    vim.list_extend(arguments, { '--provider', provider.id, '--method', method.id })
    job = vim.fn.jobstart(arguments, { term = true, on_exit = function(_, code)
      vim.schedule(function()
        if closed or not vim.api.nvim_win_is_valid(window) or not vim.api.nvim_buf_is_valid(buffer) then return end
        ended = true
        if code == 0 then
          transport.connect(function(_, err)
            if err then report(err) end
            close(not err)
          end)
        elseif code == 130 then close(false)
        else
          if vim.api.nvim_get_current_win() == window then vim.cmd('stopinsert') end
          vim.api.nvim_win_set_buf(window, buffer)
          actions[1] = cancel
          toolbar()
          for _, key in ipairs({ '<CR>', 'q' }) do vim.keymap.set('n', key, cancel, { buffer = buffer, silent = true }) end
          report('Login did not finish. See the terminal error.')
        end
      end)
    end })
    if job <= 0 then close(false); report('Cannot start login. Check the Harness executable path.'); return end
    vim.api.nvim_buf_set_name(buffer, 'harness://setup')
    toolbar()
    enter()
  end

  return self
end

return M
