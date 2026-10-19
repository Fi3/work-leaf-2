if vim.g.loaded_harness then return end
vim.g.loaded_harness = true
vim.api.nvim_create_user_command('Harness', function(command)
  require('harness').command(command)
end, { nargs = '*', range = true, complete = function()
  return { 'upgrade', 'sidebar', 'login', 'setup', 'new', 'sessions', 'attach', 'send', 'stop', 'status', 'history', 'context buffer', 'context selection' }
end })
vim.api.nvim_create_user_command('HarnessQuit', function() vim.cmd('qa') end, {})
