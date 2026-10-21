vim.opt.runtimepath:append('/app')
vim.cmd('runtime plugin/harness.lua')
vim.o.shadafile = 'NONE'
vim.o.hidden = true
require('harness').setup({ executable = '/app/target/release/harness',
  config_path = '/work/config.json', workspace = '/work/project', autostart = false })
local previous, changes, observed = nil, 0, {}
local timer = vim.uv.new_timer()
timer:start(0, 200, vim.schedule_wrap(function()
  local input = io.open('/work/editor-control.json')
  if not input then return end
  local text = input:read('*a'); input:close()
  local ok, control = pcall(vim.json.decode, text)
  if not ok then return end
  if control.stop then timer:stop(); timer:close(); vim.cmd('qa!'); return end
  if text ~= previous then
    previous = text
    if control.visible == false then vim.cmd('enew')
    else
      require('harness').command({ fargs = { 'attach', control.session } })
      if control.history then vim.defer_fn(function() require('harness').command({ fargs = { 'history' } }) end, 100) end
    end
  end
  local lines, undo = 0, 0
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf):match('^harness://chat/') then
      if not observed[buf] then
        observed[buf] = true
        vim.api.nvim_buf_attach(buf, false, { on_lines = function() changes = changes + 1 end })
      end
      lines = lines + vim.api.nvim_buf_line_count(buf)
      undo = undo + #vim.api.nvim_buf_call(buf, vim.fn.undotree).entries
    end
  end
  local output = assert(io.open('/work/editor-metrics.tmp', 'w'))
  output:write(vim.json.encode({ changes = changes, transcript_lines = lines, undo_blocks = undo }))
  output:close()
  assert(os.rename('/work/editor-metrics.tmp', '/work/editor-metrics.json'))
end))
