local M = {}

function M.new(options, actions)
  local self, chats, hosts = {}, {}, {}
  local changing = false
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
    vim.bo[buf].buftype, vim.bo[buf].bufhidden = 'nofile', 'hide'
    vim.bo[buf].swapfile, vim.bo[buf].modifiable = false, editable
    vim.bo[buf].filetype = 'harness'
    if editable then
      local function send() vim.cmd('stopinsert'); vim.cmd('Harness send') end
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
      vim.keymap.set('n', 'h', '<Cmd>Harness history<CR>', { buffer = buf, silent = true, desc = 'Load older messages' })
      vim.keymap.set('n', 'p', function() self.focus() end, { buffer = buf, silent = true, desc = 'Write a task' })
    end
    return buf
  end

  local function style(win, editable)
    vim.wo[win].wrap, vim.wo[win].linebreak = true, true
    vim.wo[win].number, vim.wo[win].relativenumber, vim.wo[win].signcolumn = false, false, 'no'
    vim.wo[win].winfixheight, vim.wo[win].winfixwidth = editable, false
    vim.wo[win].winbar = editable and '%#FloatTitle# Message%*  %#Comment#Enter send · Shift-Enter newline · \\ commands%*'
      or '%#Title# Conversation%*'
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

  function self.hide_prompt()
    local host = hosts[vim.api.nvim_get_current_tabpage()]
    if not host then return end
    if current_window(host.prompt) and #vim.api.nvim_tabpage_list_wins(0) > 1 then
      change_windows(function() vim.api.nvim_win_close(host.prompt, false) end)
    end
    host.prompt = nil
  end

  local function show_prompt(main)
    local tab, focused = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_win()
    local host = hosts[tab] or {}
    hosts[tab] = host
    if current_window(host.prompt) and host.main ~= main then self.hide_prompt() end
    host.main = main
    if not current_window(host.prompt) then
      vim.api.nvim_set_current_win(main)
      vim.cmd('belowright ' .. prompt_height() .. 'split')
      host.prompt = vim.api.nvim_get_current_win()
    end
    vim.api.nvim_win_set_buf(host.prompt, self.prompt)
    host.promptbuf = self.prompt
    style(main, false)
    style(host.prompt, true)
    vim.api.nvim_win_set_height(host.prompt, prompt_height())
    if current_window(focused) then vim.api.nvim_set_current_win(focused) end
  end

  function self.open(id, preferred)
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
      vim.api.nvim_set_current_win(main)
      if vim.api.nvim_win_get_buf(main) ~= self.transcript then vim.cmd('hide buffer ' .. self.transcript) end
      show_prompt(main)
      vim.api.nvim_set_current_win(hosts[vim.api.nvim_get_current_tabpage()].prompt)
    end)
  end

  vim.api.nvim_create_autocmd('BufEnter', { callback = function()
    if changing then return end
    local win, buf = vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()
    if vim.api.nvim_win_get_config(win).relative ~= '' then return end
    change_windows(function()
      local host = hosts[vim.api.nvim_get_current_tabpage()]
      -- Native buffer commands from the input still use the main editor area.
      if host and win == host.prompt and buf ~= host.promptbuf and current_window(host.main) then
        if vim.wo[win].winhighlight == 'Normal:NormalFloat' then vim.wo[win].winhighlight = vim.wo[host.main].winhighlight end
        vim.api.nvim_set_current_win(host.main)
        vim.cmd('hide buffer ' .. buf)
        vim.api.nvim_win_close(win, false)
        host.prompt = nil
        win = host.main
      end
      local id = self.session(buf)
      if actions.activate then actions.activate(id, buf, win) end
      if id then
        self.select(id)
        if buf == self.transcript then show_prompt(win) end
      elseif vim.bo[buf].buftype == '' then self.hide_prompt() end
    end)
  end })

  function self.focus()
    local win = window(self.prompt)
    if win then vim.api.nvim_set_current_win(win); vim.cmd('startinsert!') end
  end

  function self.resize()
    local prompt = window(self.prompt)
    if not prompt then return end
    vim.api.nvim_win_set_height(prompt, prompt_height())
    style(prompt, true)
  end

  vim.api.nvim_create_autocmd('VimResized', { callback = function()
    if vim.o.columns < 90 and window(self.prompt) then
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) == 'harness://agents' then
          vim.api.nvim_win_close(win, false)
        end
      end
    end
    self.resize()
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
    local lines, highlights = { 'Connection: ' .. connection }, {}
    local function text(value)
      vim.list_extend(lines, vim.split(value or '', '\n', { plain = true }))
    end
    local function entry(item)
      lines[#lines + 1] = ''
      local labels = { user = 'You', assistant = 'Agent', tool = 'Tool result', compaction = 'Earlier conversation summary', system = 'Notice' }
      lines[#lines + 1] = '[' .. item.kind .. '] ' .. (labels[item.kind] or item.kind)
      highlights[#highlights + 1] = { row = #lines, group = item.kind == 'user' and 'Title' or 'Special' }
      text(item.text)
      if item.truncated then lines[#lines + 1] = '[Text truncated. Use the command client to read the complete entry.]' end
    end
    if snapshot then
      lines[#lines + 1] = 'Session: ' .. (type(snapshot.session.name) == 'string' and snapshot.session.name or snapshot.session.session_id)
      lines[#lines + 1] = 'State: ' .. (connection == 'connected' and snapshot.state or 'unknown')
      if type(snapshot.session.provider) == 'string' and type(snapshot.session.model) == 'string' then
        lines[#lines + 1] = snapshot.session.provider == 'faux' and 'Local demo' or snapshot.session.provider .. ' / ' .. snapshot.session.model
      end
      if snapshot.error ~= vim.NIL then text(snapshot.error.message) end
      local seen = {}
      for _, item in ipairs(snapshot.entries) do seen[item.entry_id] = true end
      for _, item in ipairs(history or {}) do if not seen[item.entry_id] then entry(item) end end
      for _, item in ipairs(snapshot.entries) do entry(item) end
      if snapshot.state ~= 'idle' and snapshot.assistant.text ~= '' then
        lines[#lines + 1] = ''
        lines[#lines + 1] = '[assistant progress]'
        text(snapshot.assistant.text)
        if snapshot.assistant.truncated then lines[#lines + 1] = '[Text truncated.]' end
      end
      for _, tool in ipairs(snapshot.tools) do
        lines[#lines + 1] = '[' .. tool.name .. ': ' .. tool.status .. ']'
        text(tool.text)
        if tool.truncated then lines[#lines + 1] = '[Tool output truncated.]' end
      end
      if snapshot.activity ~= vim.NIL then
        lines[#lines + 1] = snapshot.activity.compaction and 'Summarizing earlier messages...' or 'Retrying the model request...'
      end
      if snapshot.usage ~= vim.NIL and snapshot.usage.models then
        local tokens = 0
        for _, model in pairs(snapshot.usage.models) do tokens = tokens + (model.usage and model.usage.totalTokens or 0) end
        if tokens > 0 then lines[#lines + 1] = 'Tokens used: ' .. tokens end
      end
      if snapshot.truncated or snapshot.history_cursor ~= vim.NIL then lines[#lines + 1] = '[Older text available: :Harness history]' end
    end
    if attachments and #attachments > 0 then
      lines[#lines + 1] = ''
      for _, item in ipairs(attachments) do
        local selection = item.kind == 'selection' and '; complete lines ' .. item.start_line .. '-' .. item.end_line or ''
        lines[#lines + 1] = 'Context snapshot: ' .. item.path .. ' (' .. item.kind .. selection .. ')'
      end
    end
    if notice and notice ~= '' then lines[#lines + 1] = ''; text(notice) end
    local positions, old_count = {}, vim.api.nvim_buf_line_count(self.transcript)
    for _, win in ipairs(vim.fn.win_findbuf(self.transcript)) do
      positions[win] = {
        at_end = vim.api.nvim_win_call(win, function() return vim.fn.line('w$') >= old_count end),
        view = vim.api.nvim_win_call(win, vim.fn.winsaveview),
      }
    end
    vim.bo[self.transcript].modifiable = true
    vim.api.nvim_buf_set_lines(self.transcript, 0, -1, false, lines)
    vim.bo[self.transcript].modifiable, vim.bo[self.transcript].modified = false, false
    vim.api.nvim_buf_clear_namespace(self.transcript, namespace, 0, -1)
    local groups = { connection == 'connected' and 'DiagnosticOk' or 'DiagnosticWarn', 'Title', 'Comment' }
    for row = 1, math.min(#lines, snapshot and 3 or 1) do
      vim.api.nvim_buf_set_extmark(self.transcript, namespace, row - 1, 0, { end_row = row, hl_group = groups[row], hl_eol = true })
    end
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
