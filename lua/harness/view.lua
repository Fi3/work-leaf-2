local M = {}

function M.new(options)
  local self = {}
  local namespace = vim.api.nvim_create_namespace('HarnessView')
  local hint_namespace = vim.api.nvim_create_namespace('HarnessPrompt')
  local narrow, resizing
  local function window(buf)
    return buf and vim.api.nvim_buf_is_valid(buf) and vim.fn.win_findbuf(buf)[1] or nil
  end
  local function width()
    local sidebar = vim.fn.win_findbuf(vim.fn.bufnr('harness://agents'))[1]
    if not sidebar then return options.width end
    return math.min(options.width, math.max(1, math.floor((vim.o.columns - vim.api.nvim_win_get_width(sidebar) - 2) / 2)))
  end
  local function buffer(kind, editable)
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, 'harness://' .. kind)
    vim.bo[buf].buftype, vim.bo[buf].bufhidden = 'nofile', 'hide'
    vim.bo[buf].swapfile, vim.bo[buf].modifiable = false, editable
    vim.bo[buf].filetype = 'harness'
    if editable then
      vim.keymap.set({ 'n', 'i' }, '<C-s>', function() vim.cmd('stopinsert'); vim.cmd('Harness send') end,
        { buffer = buf, silent = true, desc = 'Send agent prompt' })
      vim.keymap.set('n', '<CR>', '<Cmd>Harness send<CR>', { buffer = buf, silent = true, desc = 'Send agent prompt' })
      local function hint()
        vim.api.nvim_buf_clear_namespace(buf, hint_namespace, 0, -1)
        if table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '') == '' then
          vim.api.nvim_buf_set_extmark(buf, hint_namespace, 0, 0, {
            virt_text = { { 'Describe a task. Ctrl-S sends.', 'Comment' } }, virt_text_pos = 'overlay',
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

  function self.open()
    if not self.transcript or not vim.api.nvim_buf_is_valid(self.transcript) then
      self.transcript, self.prompt = buffer('transcript', false), buffer('prompt', true)
    end
    narrow = vim.o.columns < 110
    if not window(self.transcript) then
      local size = narrow and math.max(4, math.floor(vim.o.lines * 0.6)) or width()
      vim.cmd('botright ' .. size .. (narrow and 'split' or 'vsplit'))
      vim.api.nvim_win_set_buf(0, self.transcript)
      vim.wo.wrap, vim.wo.linebreak, vim.wo.winfixwidth = true, true, false
      vim.wo.number, vim.wo.relativenumber, vim.wo.signcolumn = false, false, 'no'
      vim.wo.winbar = '%#Title# Conversation%*  %#Comment#h: history  p: write%*'
    end
    if not window(self.prompt) then
      vim.api.nvim_set_current_win(window(self.transcript))
      local height = narrow and math.min(options.prompt_height, math.max(2, math.floor(vim.o.lines / 6))) or options.prompt_height
      vim.cmd('belowright ' .. height .. 'split')
      vim.api.nvim_win_set_buf(0, self.prompt)
      vim.wo.wrap, vim.wo.linebreak, vim.wo.winfixwidth = true, true, false
      vim.wo.number, vim.wo.relativenumber, vim.wo.signcolumn = false, false, 'no'
      vim.wo.winbar = '%#Title# Your task%*  %#Comment#Ctrl-S: send%*'
    end
    vim.api.nvim_set_current_win(window(self.prompt))
  end

  function self.focus()
    local win = window(self.prompt)
    if win then vim.api.nvim_set_current_win(win); vim.cmd('startinsert!') end
  end

  function self.resize()
    local win, prompt = window(self.transcript), window(self.prompt)
    if not win or resizing then return end
    if narrow == (vim.o.columns < 110) then
      if not narrow then vim.api.nvim_win_set_width(win, width()) end
      return
    end
    resizing = true
    local focused, original = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
    local position = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    local sidebar = window(vim.fn.bufnr('harness://agents'))
    if vim.o.columns < 110 and sidebar and #vim.api.nvim_list_wins() > 1 then
      vim.api.nvim_win_close(sidebar, false)
    end
    if prompt and #vim.api.nvim_list_wins() > 1 then vim.api.nvim_win_close(prompt, false) end
    if #vim.api.nvim_list_wins() > 1 then vim.api.nvim_win_close(win, false) end
    self.open()
    vim.api.nvim_win_call(window(self.transcript), function() vim.fn.winrestview(position) end)
    local previous = vim.api.nvim_win_is_valid(original) and original or window(focused)
    if previous then vim.api.nvim_set_current_win(previous) end
    resizing = false
  end

  vim.api.nvim_create_autocmd('VimResized', { callback = function() self.resize() end })

  function self.draft()
    if not self.prompt or not vim.api.nvim_buf_is_valid(self.prompt) then return '' end
    return table.concat(vim.api.nvim_buf_get_lines(self.prompt, 0, -1, false), '\n')
  end

  function self.set_draft(text)
    if self.prompt and vim.api.nvim_buf_is_valid(self.prompt) then
      vim.api.nvim_buf_set_lines(self.prompt, 0, -1, false, vim.split(text, '\n', { plain = true }))
      vim.bo[self.prompt].modified = false
      vim.api.nvim_exec_autocmds('TextChanged', { buffer = self.prompt })
    end
  end

  function self.render(connection, snapshot, history, attachments)
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
      lines[#lines + 1] = 'Session: ' .. snapshot.session.session_id
      lines[#lines + 1] = 'State: ' .. (connection == 'connected' and snapshot.state or 'unknown')
      lines[#lines + 1] = snapshot.session.provider == 'faux' and 'Local demo - fixed replies, no AI coding' or snapshot.session.provider .. ' / ' .. snapshot.session.model
      if snapshot.error ~= vim.NIL then text(snapshot.error.message) end
      if #snapshot.entries == 0 and #(history or {}) == 0 then
        text('\nWhat would you like to work on?\nType a task below, then press Ctrl-S.\nUse :Harness context buffer to attach this file.')
      end
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
