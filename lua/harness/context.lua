local M = {}

function M.capture(buffer, workspace, first, last)
  if not vim.api.nvim_buf_is_valid(buffer) or vim.bo[buffer].buftype ~= '' or vim.b[buffer].harness_session_id then
    error('Context requires a file buffer.')
  end
  local name = vim.api.nvim_buf_get_name(buffer)
  if name == '' then error('Context requires a named file buffer.') end
  local path = vim.uv.fs_realpath(name)
  if not path then
    if vim.uv.fs_lstat(name) then error('Cannot resolve the context file.') end
    local parent = vim.uv.fs_realpath(vim.fs.dirname(name))
    if not parent then error('Cannot resolve the context directory.') end
    path = parent .. '/' .. vim.fs.basename(name)
  end
  local prefix = workspace == '/' and '/' or workspace .. '/'
  if path:sub(1, #prefix) ~= prefix then error('Context is outside the session workspace.') end
  local stat = vim.uv.fs_stat(path)
  if stat and stat.type ~= 'file' then error('Context requires a file buffer.') end
  local count = vim.api.nvim_buf_line_count(buffer)
  local start_line, end_line = first or 1, last or count
  if start_line < 1 or end_line > count or start_line > end_line then error('Invalid selection line range.') end
  local text = table.concat(vim.api.nvim_buf_get_lines(buffer, start_line - 1, end_line, true), '\n')
  if end_line < count or vim.bo[buffer].endofline then text = text .. '\n' end
  local result = {
    kind = first and 'selection' or 'buffer', path = path:sub(#prefix + 1), text = text,
    modified = vim.bo[buffer].modified, changedtick = vim.api.nvim_buf_get_changedtick(buffer),
  }
  if first then result.start_line, result.end_line = first, last end
  return result
end

return M
