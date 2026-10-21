local M = {}
local labels = { user = 'You', assistant = 'Agent', tool = 'Tool result', compaction = 'Earlier conversation summary', system = 'Notice', error = 'Run failed' }

local function content(connection, snapshot)
  local self = { lines = { 'Connection: ' .. connection }, highlights = {} }
  function self.text(value)
    vim.list_extend(self.lines, vim.split(value or '', '\n', { plain = true }))
  end
  function self.line(value) self.lines[#self.lines + 1] = value end
  function self.entry(item, label)
    if item.kind == 'assistant' and not item.truncated and not item.text:find('%S') then return end
    if item.kind == 'error' and snapshot and snapshot.error ~= vim.NIL
      and item == snapshot.entries[#snapshot.entries] and item.text == snapshot.error.message then return end
    self.line('')
    self.line('[' .. item.kind .. '] ' .. (label or labels[item.kind] or item.kind))
    self.highlights[#self.highlights + 1] = {
      row = #self.lines, group = item.kind == 'error' and 'DiagnosticError' or item.kind == 'user' and 'Title' or 'Special',
    }
    self.text(item.text)
    if item.truncated then self.line('[Text truncated. Use the command client to read the complete entry.]') end
  end
  return self
end

local function header(out, connection, snapshot)
  out.line('Session: ' .. (type(snapshot.session.name) == 'string' and snapshot.session.name or snapshot.session.session_id))
  out.line('State: ' .. (connection == 'connected' and snapshot.state or 'unknown'))
  if type(snapshot.session.provider) == 'string' and type(snapshot.session.model) == 'string' then
    out.line(snapshot.session.provider == 'faux' and 'Local demo' or snapshot.session.provider .. ' / ' .. snapshot.session.model)
  elseif #snapshot.entries == 0 then
    out.line('Choose a model: \\model · Connect an account: \\login')
  end
end

local function entries(out, snapshot, history)
  if history and history.limited then
    out.line('[Loaded history limited to 200 entries and 1 MiB. Reopen this chat for recent pages.]')
  end
  local seen = {}
  for _, item in ipairs(snapshot.entries) do seen[item.entry_id] = true end
  for _, item in ipairs(history or {}) do if not seen[item.entry_id] then out.entry(item) end end
  for _, item in ipairs(snapshot.entries) do out.entry(item) end
end

local function progress(out, snapshot)
  if snapshot.state ~= 'idle' and snapshot.assistant.text ~= '' then
    out.line('')
    out.line('[assistant progress]')
    out.text(snapshot.assistant.text)
    if snapshot.assistant.truncated then out.line('[Text truncated.]') end
  end
  for _, tool in ipairs(snapshot.tools) do
    out.line('[' .. tool.name .. ': ' .. tool.status .. ']')
    out.text(tool.text)
    if tool.truncated then out.line('[Tool output truncated.]') end
  end
  if snapshot.activity ~= vim.NIL then
    out.line(snapshot.activity.compaction and 'Summarizing earlier messages...' or 'Retrying the model request...')
  end
end

local function usage(out, snapshot)
  if snapshot.usage ~= vim.NIL and snapshot.usage.models then
    local tokens = 0
    for _, model in pairs(snapshot.usage.models) do tokens = tokens + (model.usage and model.usage.totalTokens or 0) end
    if tokens > 0 then out.line('Tokens used: ' .. tokens) end
  end
  if snapshot.truncated or snapshot.history_cursor ~= vim.NIL then out.line('[Older text available: :Harness history]') end
end

local function context(out, attachments)
  if not attachments or #attachments == 0 then return end
  out.line('')
  for _, item in ipairs(attachments) do
    local selection = item.kind == 'selection' and '; complete lines ' .. item.start_line .. '-' .. item.end_line or ''
    out.line('Context snapshot: ' .. item.path .. ' (' .. item.kind .. selection .. ')')
  end
end

function M.format(connection, snapshot, history, attachments, notice)
  local out = content(connection, snapshot)
  if snapshot then
    header(out, connection, snapshot)
    entries(out, snapshot, history)
    progress(out, snapshot)
    usage(out, snapshot)
  end
  context(out, attachments)
  if notice and notice ~= '' then out.line(''); out.text(notice) end
  if snapshot and snapshot.error ~= vim.NIL then
    out.entry({ kind = 'error', text = snapshot.error.message },
      snapshot.error.kind == 'provider_error' and 'Run failed' or 'Cannot run')
  end
  local highlights = {}
  local groups = { connection == 'connected' and 'DiagnosticOk' or 'DiagnosticWarn', 'Title', 'Comment' }
  for row = 1, math.min(#out.lines, snapshot and 3 or 1) do highlights[#highlights + 1] = { row = row, group = groups[row] } end
  vim.list_extend(highlights, out.highlights)
  return out.lines, highlights
end

return M
