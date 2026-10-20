local M = {}
local commands = {
  { 'actions', 'Open chat actions without changing the draft (F1)' },
  { 'upgrade', 'Upgrade an idle server and keep its stored chats' },
  { 'help', 'Show chat commands' },
  { 'model', 'Choose a model, or use provider/model' },
  { 'provider', 'Choose a provider' },
  { 'login', 'Connect an account or enter an API key' },
  { 'instructions', 'Set instructions for this chat' },
  { 'name', 'Name this chat' },
  { 'new', 'Create a new chat; an optional name can follow' },
  { 'child', 'Create a child of this chat' },
  { 'stop', 'Stop this chat\'s current task' },
  { 'context', 'Attach the source buffer or marked selection' },
  { 'history', 'Load older messages' },
  { 'status', 'Show connection and model status' },
}

function M.parse(text)
  local name, rest = text:match('^[\\/]([%a][%w_-]*)(.*)$')
  if name and (rest == '' or rest:match('^%s')) then return name, rest:gsub('^%s+', '') end
end

function M.help()
  local lines = { 'Chat commands (\\ and / both work):' }
  for _, item in ipairs(commands) do lines[#lines + 1] = '\\' .. item[1] .. '  ' .. item[2] end
  return table.concat(lines, '\n')
end

function M.complete()
  local line = vim.api.nvim_get_current_line()
  if not line:match('^[\\/]%a*$') then return false end
  local items = {}
  for _, item in ipairs(commands) do
    local word = line:sub(1, 1) .. item[1]
    if word:sub(1, #line) == line then items[#items + 1] = { word = word, menu = item[2] } end
  end
  if #items > 0 then vim.fn.complete(1, items) end
  return true
end

return M
