local M = {}

function M.new(options, actions)
  local self, chats, hosts, files = {}, {}, {}, {}
  local changing, scheduled = false, false
  actions = actions or {}
  local namespace = vim.api.nvim_create_namespace('HarnessView')
  local hint_namespace = vim.api.nvim_create_namespace('HarnessPrompt')
  local function change_windows(callback)
    local previous = changing
    changing = true
    local ok, err = pcall(callback)
    changing = previous
    if not ok then error(err) end
  end
  local function window(buf)
    if not buf or not vim.api.nvim_buf_is_valid(buf) then return nil end
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if vim.api.nvim_win_get_buf(win) == buf then return win end
    end
  end
  local function prompt_height()
    return math.min(options.prompt_height or 3, math.max(1, math.floor(vim.o.lines / 6)))
  end
  local function buffer(kind, id, editable)
    local buf = vim.api.nvim_create_buf(not editable, true)
    vim.api.nvim_buf_set_name(buf, 'harness://' .. kind .. '/' .. id)
    vim.b[buf].harness_session_id = id
    vim.bo[buf].buftype, vim.bo[buf].bufhidden = editable and 'nofile' or '', 'hide'
    vim.bo[buf].swapfile, vim.bo[buf].modifiable = false, editable
    vim.bo[buf].filetype = 'harness'
    vim.keymap.set(editable and { 'n', 'i' } or 'n', '<F1>', '<Cmd>Harness actions<CR>',
      { buffer = buf, silent = true, desc = 'Chat actions' })
    if editable then
      local function send() vim.cmd('Harness send') end
      local function keys(value) vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(value, true, false, true), 'n', false) end
      vim.keymap.set({ 'n', 'i' }, '<C-s>', send, { buffer = buf, silent = true, desc = 'Send message' })
      vim.keymap.set({ 'n', 'i' }, '<CR>', function()
        if vim.fn.pumvisible() == 1 then keys('<C-y>') else send() end
      end, { buffer = buf, silent = true, desc = 'Send message' })
      vim.keymap.set({ 'n', 'i' }, '<C-^>', function()
        local host = hosts[vim.api.nvim_get_current_tabpage()]
        if host and vim.api.nvim_win_is_valid(host.main) then
          vim.cmd('stopinsert')
          vim.api.nvim_set_current_win(host.main)
          vim.cmd('buffer #')
        end
      end, { buffer = buf, silent = true, desc = 'Switch to the previous file or chat' })
      vim.keymap.set('i', '<C-j>', '<CR>', { buffer = buf, silent = true, desc = 'Insert a new line' })
      vim.keymap.set('i', '<S-CR>', '<CR>', { buffer = buf, silent = true, desc = 'Insert a new line' })
      vim.keymap.set('i', '<Tab>', function()
        if vim.fn.pumvisible() == 1 then keys('<C-n>')
        elseif not require('harness.commands').complete() then keys('<Tab>') end
      end, { buffer = buf, silent = true, desc = 'Complete a chat command' })
      local function hint()
        vim.api.nvim_buf_clear_namespace(buf, hint_namespace, 0, -1)
        if table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '') == '' then
          vim.api.nvim_buf_set_extmark(buf, hint_namespace, 0, 0, {
            virt_text = { { 'Message or \\command', 'Comment' } }, virt_text_pos = 'overlay',
          })
        end
      end
      vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, { buffer = buf, callback = hint })
      hint()
    else
      vim.bo[buf].readonly = true
      vim.api.nvim_create_autocmd({ 'BufWriteCmd', 'FileWriteCmd', 'FileAppendCmd' }, { buffer = buf, callback = function()
        error('Chat history is stored by Harness. Use :q to close this window.')
      end })
      vim.keymap.set('n', 'h', '<Cmd>Harness history<CR>', { buffer = buf, silent = true, desc = 'Load older messages' })
      vim.keymap.set('n', 'p', function() self.focus() end, { buffer = buf, silent = true, desc = 'Write a task' })
    end
    return buf
  end

  local function style(win, editable)
    vim.wo[win].wrap, vim.wo[win].linebreak = true, true
    vim.wo[win].number, vim.wo[win].relativenumber, vim.wo[win].signcolumn = false, false, 'no'
    vim.wo[win].winfixheight, vim.wo[win].winfixwidth = editable, false
    vim.wo[win].winbar = editable and '%#FloatTitle# Message%*  %#Comment#F1 actions · Enter send · Shift-Enter newline · \\ commands%*'
      or '%#Title# Conversation%*  %#Comment#F1 actions%*'
    if editable then
      vim.wo[win].winhighlight = 'Normal:NormalFloat'
      vim.wo[win].statusline = '%#FloatBorder#' .. string.rep('─', vim.api.nvim_win_get_width(win))
    end
  end

  function self.session(buf)
    if buf and vim.api.nvim_buf_is_valid(buf) then return vim.b[buf].harness_session_id end
  end

  function self.select(id)
    if not id then self.transcript, self.prompt = nil, nil; return end
    local chat = chats[id] or {}
    chats[id] = chat
    if not chat.transcript or not vim.api.nvim_buf_is_valid(chat.transcript) then chat.transcript = buffer('chat', id, false) end
    if not chat.prompt or not vim.api.nvim_buf_is_valid(chat.prompt) then chat.prompt = buffer('prompt', id, true) end
    self.transcript, self.prompt = chat.transcript, chat.prompt
  end

  local function current_window(win)
    return win and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
  end

  local function activate(win)
    local buf = vim.api.nvim_win_get_buf(win)
    local id = self.session(buf)
    if actions.activate then actions.activate(id, buf, win) end
    if id then self.select(id) end
  end

  local function close_prompt(host)
    local prompt = host.prompt
    host.prompt = nil
    if not current_window(prompt) or vim.api.nvim_win_get_buf(prompt) ~= host.promptbuf then return end
    if vim.fn.winlayout()[1] ~= 'leaf' then
      local focused = vim.api.nvim_get_current_win() == prompt
      vim.api.nvim_win_close(prompt, false)
      if focused then activate(vim.api.nvim_get_current_win()) end
    else
      local file = host.previous
      if not file or not vim.api.nvim_buf_is_valid(file) then file = vim.api.nvim_create_buf(true, false) end
      vim.wo[prompt].winfixheight = false
      vim.api.nvim_win_call(prompt, function() vim.cmd('hide buffer ' .. file) end)
      host.main, host.chat = prompt, nil
      activate(prompt)
    end
  end

  local function paired(layout, main, prompt)
    if layout[1] == 'leaf' then return false end
    for index, child in ipairs(layout[2]) do
      local next_child = layout[2][index + 1]
      if layout[1] == 'col' and child[1] == 'leaf' and child[2] == main
        and next_child and next_child[1] == 'leaf' and next_child[2] == prompt then return true end
      if paired(child, main, prompt) then return true end
    end
    return false
  end

  local function show_prompt(main)
    local tab, chat = vim.api.nvim_get_current_tabpage(), vim.api.nvim_win_get_buf(main)
    local pair = chats[self.session(chat)]
    if not pair or chat ~= pair.transcript then return end
    if vim.api.nvim_win_get_width(main) < 40 then
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) == 'harness://agents' then vim.api.nvim_win_close(win, false) end
      end
    end
    local host = hosts[tab] or {}
    hosts[tab] = host
    if host.main ~= main or host.chat ~= chat then host.closed = false end
    host.main, host.chat = main, chat
    host.previous = files[main] or host.previous
    if host.closed then return end
    if not current_window(host.prompt) then
      host.prompt = vim.api.nvim_open_win(pair.prompt, false, { split = 'below', win = main, height = prompt_height() })
    else
      if not paired(vim.fn.winlayout(), main, host.prompt) then
        vim.api.nvim_win_set_config(host.prompt, { split = 'below', win = main })
      end
      vim.api.nvim_win_set_buf(host.prompt, pair.prompt)
    end
    host.promptbuf = pair.prompt
    style(main, false)
    style(host.prompt, true)
    vim.api.nvim_win_set_height(host.prompt, prompt_height())
  end

  local function reconcile()
    if changing then return end
    change_windows(function()
      local host = hosts[vim.api.nvim_get_current_tabpage()]
      local focused = vim.api.nvim_get_current_win()
      if host and current_window(host.prompt) then
        local buf = vim.api.nvim_win_get_buf(host.prompt)
        if buf ~= host.promptbuf then
          local prompt = host.prompt
          host.prompt = nil
          if current_window(host.main) then
            if vim.wo[prompt].winhighlight == 'Normal:NormalFloat' then vim.wo[prompt].winhighlight = vim.wo[host.main].winhighlight end
            vim.api.nvim_win_call(host.main, function() vim.cmd('hide buffer ' .. buf) end)
            if focused == prompt then vim.api.nvim_set_current_win(host.main) end
            vim.api.nvim_win_close(prompt, false)
            activate(host.main)
          end
        elseif not current_window(host.main) or vim.api.nvim_win_get_buf(host.main) ~= host.chat then
          close_prompt(host)
        end
      end
      local win = vim.api.nvim_get_current_win()
      local buf = vim.api.nvim_win_get_buf(win)
      local id = self.session(buf)
      local pair = id and chats[id]
      if pair and buf == pair.prompt and (not host or win ~= host.prompt) then
        -- A tab or an external plugin can copy the input buffer into a normal window.
        vim.cmd('hide buffer ' .. pair.transcript)
        activate(win)
        buf = pair.transcript
      end
      if pair and buf == pair.transcript then show_prompt(win)
      elseif pair and host and win == host.prompt then show_prompt(host.main)
      elseif vim.bo[buf].buftype == '' and host then close_prompt(host)
      elseif host and current_window(host.main) and vim.api.nvim_win_get_buf(host.main) == host.chat then show_prompt(host.main) end
    end)
  end

  local function schedule()
    if changing or scheduled then return end
    scheduled = true
    vim.schedule(function() scheduled = false; reconcile() end)
  end

  function self.open(id, preferred)
    reconcile()
    self.select(id or self.session(self.transcript))
    if not self.transcript then return end
    change_windows(function()
      local host = hosts[vim.api.nvim_get_current_tabpage()]
      local main = window(self.transcript)
      if not main and current_window(preferred) and (not host or preferred ~= host.prompt) then main = preferred end
      if not main and host and current_window(host.main) then main = host.main end
      if not main then
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
          if vim.api.nvim_win_get_config(win).relative == '' and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == '' then main = win; break end
        end
      end
      main = main or vim.api.nvim_get_current_win()
      local buf = vim.api.nvim_win_get_buf(main)
      if vim.bo[buf].buftype == '' and not self.session(buf) then files[main] = buf end
      vim.api.nvim_set_current_win(main)
      if buf ~= self.transcript then vim.cmd('hide buffer ' .. self.transcript) end
      if host then host.closed = false end
      show_prompt(main)
      host = hosts[vim.api.nvim_get_current_tabpage()]
      host.last = self.transcript
      vim.api.nvim_set_current_win(host.prompt)
    end)
  end

  vim.api.nvim_create_autocmd({ 'BufEnter', 'WinEnter' }, { callback = function()
    if changing then return end
    local win, buf = vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()
    if vim.api.nvim_win_get_config(win).relative ~= '' then return end
    local host = hosts[vim.api.nvim_get_current_tabpage()]
    if not host or win ~= host.prompt or buf == host.promptbuf then
      activate(win)
      local id = self.session(buf)
      local content = id and chats[id].transcript or buf
      if host then
        if host.last ~= content then host.closed = false end
        host.last = content
      end
    end
    schedule()
  end })
  vim.api.nvim_create_autocmd('BufLeave', { callback = function()
    if changing then return end
    local win, buf = vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()
    if vim.bo[buf].buftype == '' and not self.session(buf) then files[win] = buf end
  end })
  vim.api.nvim_create_autocmd('WinNewPre', { callback = function()
    if changing then return end
    local host = hosts[vim.api.nvim_get_current_tabpage()]
    if host and vim.api.nvim_get_current_win() == host.prompt and current_window(host.main)
      and vim.api.nvim_win_get_buf(host.main) == host.chat then vim.api.nvim_set_current_win(host.main) end
  end })
  vim.api.nvim_create_autocmd('WinClosed', { callback = function(event)
    if changing then return end
    local win = tonumber(event.match)
    for _, host in pairs(hosts) do
      if host.prompt == win then host.prompt, host.closed = nil, true end
      if host.main == win then host.previous = files[win] or host.previous end
    end
    files[win] = nil
    schedule()
  end })
  vim.api.nvim_create_autocmd({ 'BufWinEnter', 'TabEnter', 'WinResized' }, { callback = schedule })

  function self.focus()
    reconcile()
    local host = hosts[vim.api.nvim_get_current_tabpage()]
    if host and current_window(host.main) and vim.api.nvim_win_get_buf(host.main) == self.transcript
      and vim.api.nvim_get_current_buf() == self.transcript then
      change_windows(function() host.closed = false; show_prompt(host.main) end)
    end
    local win = window(self.prompt)
    if win then vim.api.nvim_set_current_win(win); vim.cmd('startinsert!') end
  end

  function self.resize()
    reconcile()
  end

  vim.api.nvim_create_autocmd('VimResized', { callback = function()
    if vim.o.columns < 90 and window(self.prompt) then
      change_windows(function()
        for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
          if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) == 'harness://agents' then vim.api.nvim_win_close(win, false) end
        end
      end)
    end
    schedule()
  end })

  function self.draft(id)
    local prompt = id and chats[id] and chats[id].prompt or not id and self.prompt
    if not prompt or not vim.api.nvim_buf_is_valid(prompt) then return '' end
    return table.concat(vim.api.nvim_buf_get_lines(prompt, 0, -1, false), '\n')
  end

  function self.set_draft(text, id)
    local prompt = id and chats[id] and chats[id].prompt or not id and self.prompt
    if prompt and vim.api.nvim_buf_is_valid(prompt) then
      vim.api.nvim_buf_set_lines(prompt, 0, -1, false, vim.split(text, '\n', { plain = true }))
      vim.bo[prompt].modified = false
      vim.api.nvim_exec_autocmds('TextChanged', { buffer = prompt })
    end
  end

  function self.render(connection, snapshot, history, attachments, notice)
    if not self.transcript or not vim.api.nvim_buf_is_valid(self.transcript) then return end
    local lines, highlights = require('harness.transcript').format(connection, snapshot, history, attachments, notice)
    local positions, old_count = {}, vim.api.nvim_buf_line_count(self.transcript)
    for _, win in ipairs(vim.fn.win_findbuf(self.transcript)) do
      positions[win] = {
        at_end = vim.api.nvim_win_call(win, function() return vim.fn.line('w$') >= old_count end),
        view = vim.api.nvim_win_call(win, vim.fn.winsaveview),
      }
    end
    vim.bo[self.transcript].readonly, vim.bo[self.transcript].modifiable = false, true
    vim.api.nvim_buf_set_lines(self.transcript, 0, -1, false, lines)
    vim.bo[self.transcript].modifiable, vim.bo[self.transcript].modified = false, false
    vim.bo[self.transcript].readonly = true
    vim.api.nvim_buf_clear_namespace(self.transcript, namespace, 0, -1)
    for _, mark in ipairs(highlights) do
      vim.api.nvim_buf_set_extmark(self.transcript, namespace, mark.row - 1, 0, { end_row = mark.row, hl_group = mark.group, hl_eol = true })
    end
    for win, position in pairs(positions) do
      if position.at_end then
        vim.api.nvim_win_set_cursor(win, { #lines, 0 })
      else
        vim.api.nvim_win_call(win, function() vim.fn.winrestview(position.view) end)
      end
    end
  end

  return self
end

return M
