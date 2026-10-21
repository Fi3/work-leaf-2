local M = {}

local function terminal_copy(value)
  if #vim.api.nvim_list_uis() == 0 then return false end
  return pcall(function() require('vim.ui.clipboard.osc52').copy('+')({ value }) end)
end

function M.new(window, callbacks)
  local self = {}
  local link, code, link_buffer
  local ssh = (vim.env.SSH_CONNECTION or '') ~= '' or (vim.env.SSH_TTY or '') ~= ''
  local browser_attempt, link_sequence = 0, 0

  local function running() return callbacks.state() == 'running' end

  local function toolbar()
    local state = callbacks.state()
    if state == 'closed' then return end
    local ended = state == 'ended'
    local width = vim.api.nvim_win_get_width(window)
    local labels = width >= 54 and { '[ Open browser ]', 'Copy link', 'Full link', 'Cancel' }
      or width >= 30 and { '[Open]', 'Copy', 'Link', 'Cancel' }
      or width >= 26 and { 'Open', 'Copy', 'Link', 'Cancel' } or { 'Open', 'Copy', 'Link', '^C' }
    if ssh then
      labels = width >= 40 and { '[ Copy link ]', 'Full link', 'Cancel' } or { 'Copy', 'Link', 'Cancel' }
    end
    if ended then labels = { 'Close' } elseif not link then labels = { 'Cancel' } end
    local parts = {}
    for index, label in ipairs(labels) do
      local action = ended and 1 or not link and 3 or (ssh and { 1, 4, 3 } or { 2, 1, 4, 3 })[index]
      parts[#parts + 1] = '%' .. action .. '@' .. callbacks.click_handler .. '@ ' .. label .. ' %T'
    end
    vim.wo[window].winbar = table.concat(parts)
    if link then
      local hint = width >= 54 and 'Finish sign-in in browser. Keep this window open.'
        or width >= 34 and 'Finish in browser. Keep open.' or 'Keep login open.'
      if ssh then hint = width >= 40 and 'SSH: copy link to local browser.' or 'SSH: copy link locally.' end
      vim.api.nvim_win_set_config(window, { footer = ' ' .. hint .. ' ', footer_pos = 'left' })
    end
  end

  local function click_link()
    local mouse = vim.fn.getmousepos()
    if link and running() and mouse.winid == window and mouse.winrow > 2 and mouse.line > 0 then
      local line = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(window), mouse.line - 1, mouse.line, false)[1]
      if (line == '[ Open browser ]' or line == '[ Copy link ]' or line == link) and mouse.column >= 1 and mouse.column <= #line then
        local revision = link_sequence
        vim.schedule(function()
          if running() and link_sequence == revision and vim.api.nvim_get_current_win() == window then
            self.open_link()
            if running() then callbacks.resume() end
          end
        end)
      end
    end
    return '<LeftRelease>'
  end
  local function show_link(message, value)
    value = value or link
    if not value or callbacks.state() == 'closed' then return end
    if vim.api.nvim_get_current_win() == window and vim.fn.mode() == 't' then
      local revision = link_sequence
      callbacks.after_terminal(function()
        if callbacks.state() ~= 'closed' and link_sequence == revision and vim.api.nvim_get_current_win() == window then show_link(message, value) end
      end)
      vim.cmd('stopinsert')
      return
    end
    vim.fn.setreg('"', value, 'v')
    if not link_buffer or not vim.api.nvim_buf_is_valid(link_buffer) then
      link_buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(link_buffer, 'harness://login-link')
      vim.bo[link_buffer].bufhidden = 'hide'
      for _, key in ipairs({ '<CR>', 'i' }) do vim.keymap.set('n', key, callbacks.input, { buffer = link_buffer, silent = true }) end
      vim.keymap.set('n', '<Esc>', callbacks.input, { buffer = link_buffer, silent = true })
      vim.keymap.set({ 'n', 'v' }, '<C-c>', callbacks.cancel, { buffer = link_buffer, silent = true })
      vim.keymap.set({ 'n', 'v' }, '<C-x>', function() self.click(1) end, { buffer = link_buffer, silent = true })
      vim.keymap.set({ 'n', 'v' }, '<C-o>', function() self.open_link() end, { buffer = link_buffer, silent = true })
      vim.keymap.set({ 'n', 'v' }, '<C-l>', function() self.click(4) end, { buffer = link_buffer, silent = true })
      vim.keymap.set({ 'n', 'v' }, '<C-y>', function() self.click(5) end, { buffer = link_buffer, silent = true })
      vim.keymap.set('n', '<LeftRelease>', click_link, { buffer = link_buffer, expr = true })
    end
    vim.bo[link_buffer].modifiable = true
    vim.api.nvim_buf_set_lines(link_buffer, 0, -1, false, { value, '', message,
      (value == link and 'Link' or 'Device code') .. ' copied to the Vim register.', 'yy: copy line · Enter/Esc: input · Ctrl-C: cancel' })
    vim.bo[link_buffer].modifiable = false
    vim.cmd('stopinsert')
    vim.api.nvim_win_set_buf(window, link_buffer)
    toolbar()
    vim.wo[window].wrap = true
    vim.api.nvim_win_set_cursor(window, { 1, 0 })
  end
  local function copy(value)
    if not value or callbacks.state() == 'closed' then return end
    local ok = false
    if ssh or vim.fn.has('clipboard') ~= 1 then ok = terminal_copy(value)
    else ok = pcall(vim.fn.setreg, '+', value, 'v') end
    if ok then
      vim.api.nvim_win_set_config(window, { footer = ssh and vim.api.nvim_win_get_width(window) >= 54
        and ' Copy requested · Paste in your local browser ' or ' Copy requested · Ctrl-L: link ', footer_pos = 'left' })
    else show_link('System clipboard unavailable.', value) end
  end
  local function open()
    if not link or not running() then return end
    if ssh then copy(link); return end
    browser_attempt = browser_attempt + 1
    local attempt, url, revision = browser_attempt, link, link_sequence
    toolbar()
    local function failed()
      if not running() or link_sequence ~= revision or attempt ~= browser_attempt then return end
      vim.api.nvim_win_set_config(window, { footer = ' Browser failed. Use Copy. ', footer_pos = 'left' })
      callbacks.report('Browser did not open. Use Open browser to retry, or Copy link.')
    end
    local ok = pcall(vim.system, { 'xdg-open', url }, { detach = true, stdout = false, stderr = false },
      vim.schedule_wrap(function(result) if result.code ~= 0 or result.signal ~= 0 then failed() end end))
    if not ok then failed() end
  end

  function self.copy_link() copy(link) end
  function self.open_link() open() end
  function self.show_link()
    show_link(ssh and 'SSH: paste this link in your local browser.' or 'Complete login link.')
  end
  function self.copy_code() copy(code) end

  local actions = { self.copy_link, self.open_link, callbacks.cancel, self.show_link, self.copy_code }
  function self.click(index)
    local state = callbacks.state()
    if state == 'closed' then return end
    if state == 'ended' and index == 1 then callbacks.cancel() else actions[index]() end
  end

  function self.bind(buffer)
    for _, mode in ipairs({ 't', 'n', 'v' }) do
      vim.keymap.set(mode, '<C-c>', callbacks.cancel, { buffer = buffer, silent = true })
      vim.keymap.set(mode, '<C-x>', self.copy_link, { buffer = buffer, silent = true, desc = 'Copy login link' })
      vim.keymap.set(mode, '<C-o>', open, { buffer = buffer, silent = true, desc = ssh and 'Copy login link' or 'Open login link' })
      vim.keymap.set(mode, '<C-l>', self.show_link, { buffer = buffer, silent = true, desc = 'Select complete login link' })
      vim.keymap.set(mode, '<C-y>', self.copy_code, { buffer = buffer, silent = true, desc = 'Copy device code' })
    end
    vim.keymap.set('n', '<LeftRelease>', click_link, { buffer = buffer, expr = true })
    vim.keymap.set('t', '<Esc>', '<C-\\><C-n>', { buffer = buffer, silent = true })
    for _, key in ipairs({ '<C-c>', '<C-l>' }) do
      vim.keymap.set('t', key, '<C-\\><C-n>' .. key, { buffer = buffer, remap = true, silent = true })
    end
  end

  function self.receive(sequence)
    if not running() then return end
    local url = sequence:match('^\027%]8;id=harness%-login;(.*)$')
    if url and #url <= 8192 and url:match('^https?://%S+$') and not url:find('%c') then
      local changed = link ~= url
      link, code = url, nil
      if changed then link_sequence = link_sequence + 1 end
      local revision = link_sequence
      vim.schedule(function()
        toolbar()
        if changed and running() and not ssh and link_sequence == revision then open() end
      end)
    end
    local encoded, target = sequence:match('^\027%]8;id=harness%-code%-([A-Za-z0-9+/=]+);(.*)$')
    if encoded and #encoded <= 1368 and target == link then
      local ok, value = pcall(vim.base64.decode, encoded)
      if ok and #value > 0 and #value <= 1024 and not value:find('%c') and not value:find('\194[\128-\159]') then code = value end
    end
  end

  function self.close()
    if link_buffer and vim.api.nvim_buf_is_valid(link_buffer) then vim.api.nvim_buf_delete(link_buffer, { force = true }) end
  end
  self.refresh = toolbar
  return self
end

return M
